/**
 * FPL Desk — analytical engine.
 *
 * Pure functions only. No DOM, no fetch, no globals. Everything here takes a
 * snapshot (and optionally details) and returns plain data, so the same code
 * runs in the browser and under `node --test`.
 *
 * The unit of currency throughout is **expected points per gameweek**. Every
 * score is in that unit unless its name says otherwise, which is what lets a
 * goalkeeper and a striker sit in the same ranking.
 */

/* ────────────────────────────── constants ───────────────────────────────── */

export const SQUAD_SHAPE = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
export const MAX_PER_CLUB = 3;
export const HIT_COST = 4;

/** Every legal FPL starting shape: 1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD, 11 total. */
export const FORMATIONS = (() => {
  const out = [];
  for (let d = 3; d <= 5; d++)
    for (let m = 2; m <= 5; m++)
      for (let f = 1; f <= 3; f++)
        if (d + m + f === 10) out.push({ DEF: d, MID: m, FWD: f, name: `${d}-${m}-${f}` });
  return out;
})();

/** Points per goal by position, and the clean-sheet award. */
const GOAL_PTS = { GKP: 6, DEF: 6, MID: 5, FWD: 4 };
const CS_PTS = { GKP: 4, DEF: 4, MID: 1, FWD: 0 };

/**
 * Spread of manager totals, used to turn a points edge into a rank movement.
 * A single gameweek's scores across managers sit near a 18-point standard
 * deviation; cumulative totals widen roughly with the square root of gameweeks
 * played. This is an assumption, not a measurement — the UI says so.
 */
export const FIELD_SIGMA_GW = 18;

/* ──────────────────────────────── maths ─────────────────────────────────── */

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;

/** Seeded RNG so simulations are reproducible and tests are deterministic. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Knuth sampler; fine for the small lambdas football produces. */
export function poisson(lambda, rand) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(rand)));
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Abramowitz & Stegun 7.1.26 error function, good to ~1e-7. */
export function normalCdf(z) {
  const s = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}

/** Acklam's inverse normal CDF. */
export function normalInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/* ─────────────────────────────── context ────────────────────────────────── */

/**
 * Precomputes everything the rest of the engine needs, once.
 *
 * The expensive part is the per-gameweek projection grid: for each player, the
 * expected points in each of the next `horizon` gameweeks. Every downstream
 * feature — optimal XI, planner, captaincy, health — reads off that grid rather
 * than recomputing fixtures.
 */
export function buildContext(snapshot, details = {}) {
  const gwPlayed = snapshot.currentEvent ? snapshot.currentEvent.id : 1;
  const from = snapshot.horizonFrom || gwPlayed + 1;
  const horizon = Math.min(snapshot.horizon || 6, 6);
  const gws = [];
  for (let g = from; g < from + horizon; g++) gws.push(g);

  const byId = new Map();
  const teams = new Map();
  (snapshot.teams || []).forEach((t) => teams.set(t.id, t));

  const players = (snapshot.players || []).map((raw) => {
    const p = { ...raw };
    p.minsPct = minutesShare(p, gwPlayed);
    p.avail = availability(p);
    p.per90 = per90Rates(p);
    p.fixtures = fixtureGrid(snapshot, p.team, gws);
    p.proj = p.fixtures.map((f) => projectGw(p, f, gwPlayed));
    p.net = (p.tIn || 0) - (p.tOut || 0);
    p.ratio = p.price_ ? p.price_.ratio : 0;
    p.progress = Math.round((p.ratio / 0.075) * 100);
    p.seasonDelta = round(p.price - p.priceStart, 1);
    p.ownDelta = snapshot.totalManagers ? (p.net / snapshot.totalManagers) * 100 : 0;
    byId.set(p.id, p);
    return p;
  });

  const ctx = {
    snapshot, details, players, byId, teams, gws, gwPlayed, horizon,
    totalManagers: snapshot.totalManagers || 1,
    entry: snapshot.entry && !snapshot.entry.error ? snapshot.entry : null,
  };

  attachEffectiveOwnership(ctx);
  players.forEach((p) => {
    p.scores = playerScores(p, ctx);
    p.score = p.scores.overall;
    p.traits = playerTraits(p);
  });
  ctx.squad = ctx.entry && ctx.entry.picks
    ? ctx.entry.picks.map((pk) => ({ ...pk, player: byId.get(pk.id) })).filter((x) => x.player)
    : [];
  return ctx;
}

/** Share of the season's available minutes actually played. */
function minutesShare(p, gwPlayed) {
  return clamp((p.mins || 0) / (90 * Math.max(1, gwPlayed)), 0, 1);
}

/** Probability the player features at all, folding in the FPL status flag. */
export function availability(p) {
  if (p.status === 's' || p.status === 'u' || p.status === 'n' || p.status === 'i') return 0;
  const base = clamp((p.mins || 0) / (90 * Math.max(1, 1)), 0, 1);
  let a = p.minsPct != null ? p.minsPct : base;
  if (p.status === 'd') a *= (p.chance == null ? 50 : p.chance) / 100;
  return clamp(a, 0, 1);
}

function per90Rates(p) {
  const m = Math.max(1, p.mins || 0);
  const f = 90 / m;
  return {
    xG: (p.xG || 0) * f,
    xA: (p.xA || 0) * f,
    xGI: (p.xGI || 0) * f,
    xGC: (p.xGC || 0) * f,
    saves: (p.saves || 0) * f,
    defCon: (p.defCon || 0) * f,
  };
}

/** Points per 90 implied by the underlying numbers alone, ignoring form. */
export function underlyingRate(p) {
  const r = per90Rates(p);
  const csProb = Math.exp(-Math.max(0.1, r.xGC));
  let pts = 2; // appearance
  pts += r.xG * (GOAL_PTS[p.pos] || 4);
  pts += r.xA * 3;
  pts += csProb * (CS_PTS[p.pos] || 0);
  if (p.pos === 'GKP') pts += r.saves / 3;
  return round(pts, 3);
}

function fixtureGrid(snapshot, teamId, gws) {
  const list = (snapshot.fixtures && snapshot.fixtures[teamId]) || [];
  return gws.map((gw) => {
    const games = list.filter((f) => f.gw === gw);
    if (!games.length) return { gw, blank: true, difficulty: 3, count: 0, games: [] };
    const difficulty = games.reduce((s, g) => s + g.d, 0) / games.length;
    return { gw, blank: false, difficulty, count: games.length, games };
  });
}

const fixtureMultiplier = (d) => clamp((5.5 - d) / 2.5, 0.55, 1.35);

/**
 * Expected points for one player in one gameweek.
 *
 * Blends the FPL model's own expected points, the player's season rate and
 * recent form — all already per-appearance figures — then scales by the
 * difficulty of that specific fixture and the chance he plays. A double
 * gameweek counts twice; a blank scores nothing.
 */
function projectGw(p, fixture, gwPlayed) {
  if (fixture.blank) return 0;
  const lean = clamp((gwPlayed - 1) / 7, 0, 1);
  const base =
    (0.70 - 0.40 * lean) * (p.epNext || 0) +
    (0.15 + 0.25 * lean) * (p.ppg || 0) +
    (0.15 + 0.15 * lean) * (p.form || 0);
  return round(base * fixtureMultiplier(fixture.difficulty) * p.avail * fixture.count, 3);
}

/**
 * How available a player looks across a whole horizon rather than this weekend.
 *
 * `availability` is deliberately brutal — anything flagged projects zero for the
 * next match. Over six gameweeks that is wrong in both directions: a one-match
 * ban barely dents a long-term hold, while an injury with no return date should
 * not read as a strong buy. The discount reflects how long each flag typically
 * keeps someone out.
 */
const LONG_STATUS = { a: 1, d: 0.85, s: 0.78, i: 0.32, u: 0.12, n: 0.05 };
export function longAvailability(p) {
  const base = clamp(p.minsPct == null ? 0 : p.minsPct, 0, 1);
  return base * (LONG_STATUS[p.status] == null ? 0.3 : LONG_STATUS[p.status]);
}

/** As the short projection, but blind to form and judged on long-run minutes. */
function projectGwLong(p, fixture, gwPlayed) {
  if (fixture.blank) return 0;
  const lean = clamp((gwPlayed - 1) / 7, 0, 1);
  const base =
    (0.45 - 0.20 * lean) * (p.epNext || 0) +
    (0.35 + 0.10 * lean) * (p.ppg || 0) +
    (0.20 + 0.10 * lean) * underlyingRate(p);
  const security = 0.15 + 0.85 * longAvailability(p);
  return round(base * fixtureMultiplier(fixture.difficulty) * security * fixture.count, 3);
}

/* ──────────────────── effective ownership (estimated) ───────────────────── */

/**
 * Effective ownership = the share of managers holding a player, plus the share
 * captaining him (a captain counts twice, so captaincy adds a second unit).
 *
 * The public API does not publish captaincy, so the split is estimated:
 * captains concentrate hard on the highest-projecting players that people
 * actually own. The exponent controls that concentration.
 */
export function attachEffectiveOwnership(ctx, concentration = 3.2) {
  const appeal = ctx.players.map((p) => {
    const next = p.proj[0] || 0;
    const a = Math.pow(Math.max(0, next), concentration) * ((p.owned || 0) / 100);
    return Number.isFinite(a) ? a : 0;
  });
  const total = appeal.reduce((s, v) => s + v, 0) || 1;
  ctx.players.forEach((p, i) => {
    p.captainShare = round((appeal[i] / total) * 100, 3);
    p.eo = round((p.owned || 0) + p.captainShare, 2);
  });
  ctx.captainField = ctx.players
    .filter((p) => p.captainShare > 0.05)
    .sort((a, b) => b.captainShare - a.captainShare)
    .slice(0, 40);
  return ctx;
}

/* ──────────────────────────── the six scores ────────────────────────────── */

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

/**
 * Splits the old aggregate score into six independently meaningful numbers.
 * All except Value are expected points per gameweek.
 */
export function playerScores(p, ctx) {
  const proj = p.proj;
  const overall = round(mean(proj.slice(0, 5)), 2);

  // short term weights the very next match hardest
  const w = [0.65, 0.35];
  const short = round(proj.slice(0, 2).reduce((s, v, i) => s + v * (w[i] || 0), 0), 2);

  const longProj = p.fixtures.map((f) => projectGwLong(p, f, ctx.gwPlayed));
  const long = round(mean(longProj), 2);

  const value = p.price > 0 ? round((overall / p.price) * 10, 2) : 0;

  // Expected points gained on the average manager: what you get minus what the
  // field already gets from him through ownership.
  const differential = round(overall * (1 - clamp((p.eo || 0) / 100, 0, 1)), 2);

  // Captaincy doubles the next gameweek only.
  const captain = round((proj[0] || 0) * 2, 2);

  return {
    overall, short, long, value, differential, captain,
    longProj,
    breakdown: scoreBreakdown(p, ctx, overall),
  };
}

/**
 * Why a player scores what he scores: each factor as a 0-100 percentile-ish
 * reading, plus the single biggest thing holding him back.
 */
function scoreBreakdown(p, ctx, overall) {
  const fdr = mean(p.fixtures.slice(0, 5).map((f) => (f.blank ? 3 : f.difficulty)));
  const factors = [
    { key: 'Expected points', value: clamp(((p.epNext || 0) / 8) * 100, 0, 100), raw: `${(p.epNext || 0).toFixed(1)} xPts` },
    { key: 'Form',            value: clamp(((p.form || 0) / 9) * 100, 0, 100),   raw: `${(p.form || 0).toFixed(1)}` },
    { key: 'Fixtures',        value: clamp(((5.5 - fdr) / 3) * 100, 0, 100),     raw: `FDR ${fdr.toFixed(1)}` },
    { key: 'Minutes',         value: clamp(p.avail * 100, 0, 100),               raw: `${Math.round(p.avail * 100)}% projected` },
    { key: 'xGI / 90',        value: clamp((p.per90.xGI / 1.1) * 100, 0, 100),   raw: `${p.per90.xGI.toFixed(2)}` },
    { key: 'Ownership',       value: clamp(100 - (p.eo || 0), 0, 100),           raw: `${(p.eo || 0).toFixed(1)}% effective` },
  ];
  const weakest = factors.slice().sort((a, b) => a.value - b.value)[0];
  let concern = null;
  if (weakest && weakest.value < 55) {
    concern = weakest.key === 'Minutes'
      ? `only ${Math.round(p.avail * 100)}% projected minutes`
      : weakest.key === 'Fixtures'
        ? `hard run, ${weakest.raw}`
        : weakest.key === 'Ownership'
          ? `heavily owned at ${weakest.raw}`
          : `weak ${weakest.key.toLowerCase()} (${weakest.raw})`;
  }
  return { factors, concern, overall };
}

/* ─────────────────────────── the simulator ──────────────────────────────── */

/**
 * Monte Carlo for one player in one gameweek, built up from the component
 * scoring events rather than sampling a total directly. That way the shape of
 * the distribution — the blanks and the hauls — comes out of the football
 * rather than being assumed.
 */
export function simulatePlayer(p, gwIndex, ctx, draws = 1500, seed = 12345) {
  const fixture = p.fixtures[gwIndex];
  const out = new Array(draws);
  if (!fixture || fixture.blank || p.avail <= 0) {
    out.fill(0);
    return summarise(out);
  }
  const rand = rng(seed + p.id * 7919 + gwIndex * 104729);
  const startProb = clamp(p.avail, 0, 1);
  const oppMult = fixtureMultiplier(fixture.difficulty);
  const r = p.per90;
  const goalPts = GOAL_PTS[p.pos] || 4;
  const csPts = CS_PTS[p.pos] || 0;
  // Expected goals conceded scales with how hard the fixture is.
  const lambdaGC = Math.max(0.15, r.xGC * (2 - oppMult) * fixture.count);

  for (let i = 0; i < draws; i++) {
    let pts = 0;
    for (let g = 0; g < fixture.count; g++) {
      if (rand() > startProb) continue;
      const full = rand() < 0.82;          // started and saw out the hour
      const mins = full ? 90 : 30 + rand() * 29;
      pts += mins >= 60 ? 2 : 1;
      const share = mins / 90;
      const goals = poisson(r.xG * share * oppMult, rand);
      const assists = poisson(r.xA * share * oppMult, rand);
      pts += goals * goalPts + assists * 3;
      if (mins >= 60 && csPts > 0 && rand() < Math.exp(-lambdaGC / fixture.count)) pts += csPts;
      if (p.pos === 'GKP') pts += Math.floor(poisson(r.saves * share, rand) / 3);
      if (goals + assists > 0 && rand() < 0.45) pts += 1 + Math.floor(rand() * 3);
      if (rand() < 0.06) pts -= 1;         // yellow
    }
    out[i] = pts;
  }
  return summarise(out);
}

function summarise(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    samples,
    mean: round(mean(samples), 2),
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    pHaul: round(samples.filter((v) => v >= 10).length / samples.length, 3),
    pBlank: round(samples.filter((v) => v <= 2).length / samples.length, 3),
  };
}

/**
 * Rank impact of a captaincy choice.
 *
 * Your edge on the field is the doubled captain return you take, minus what the
 * field takes on average — a captaincy-weighted average over what everyone else
 * picked. Because the same players are sampled in both terms, the correlation is
 * handled properly: if the popular captain blanks, going against him gains.
 *
 * The edge is then mapped to a rank movement through an assumed normal spread of
 * manager totals. That assumption is the weak link and is surfaced in the UI.
 */
export function captainRankImpact(pick, ctx, draws = 1200, seed = 777) {
  const field = ctx.captainField.slice(0, 12);
  if (!field.length || !ctx.entry) return null;

  const sims = new Map();
  const need = field.concat(field.some((f) => f.id === pick.id) ? [] : [pick]);
  need.forEach((p) => sims.set(p.id, simulatePlayer(p, 0, ctx, draws, seed).samples));

  const shareTotal = field.reduce((s, f) => s + f.captainShare, 0) || 1;
  const edges = new Array(draws);
  for (let i = 0; i < draws; i++) {
    let fieldReturn = 0;
    for (const f of field) fieldReturn += (f.captainShare / shareTotal) * sims.get(f.id)[i];
    edges[i] = sims.get(pick.id)[i] - fieldReturn;
  }

  const sorted = edges.slice().sort((a, b) => a - b);
  const toRank = (edge) => rankShift(edge, ctx);
  return {
    edge: { mean: round(mean(edges), 2), p25: percentile(sorted, 0.25), p50: percentile(sorted, 0.5), p75: percentile(sorted, 0.75) },
    // a positive edge moves you up, so the optimistic rank case comes from p75
    rank: { p25: toRank(percentile(sorted, 0.25)), p50: toRank(percentile(sorted, 0.5)), p75: toRank(percentile(sorted, 0.75)) },
    fieldSize: field.length,
  };
}

/**
 * Converts a points edge into an overall-rank movement. Positive means moving
 * up the table. Assumes manager totals are normally distributed with a spread
 * that widens as the season accumulates.
 */
export function rankShift(edgePoints, ctx) {
  const N = ctx.totalManagers;
  const rank = ctx.entry && ctx.entry.overallRank ? ctx.entry.overallRank : Math.round(N / 2);
  const sigma = FIELD_SIGMA_GW * Math.sqrt(Math.max(1, ctx.gwPlayed));
  const q = clamp(rank / N, 1e-7, 1 - 1e-7);
  const z = normalInv(1 - q);
  const zNew = z + edgePoints / sigma;
  const newRank = Math.max(1, Math.round(N * (1 - normalCdf(zNew))));
  return rank - newRank; // positive = places gained
}

/* ─────────────────────────── optimal XI ─────────────────────────────────── */

/**
 * Exhaustive search over every legal formation. Cheap — eight shapes, one sort
 * per position — so there is no reason to approximate it.
 */
export function optimalXI(squadPlayers, gwIndex = 0, key = null) {
  const value = (p) => (key ? key(p) : (p.proj && p.proj[gwIndex]) || 0);
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  squadPlayers.forEach((p) => { if (byPos[p.pos]) byPos[p.pos].push(p); });
  Object.keys(byPos).forEach((k) => byPos[k].sort((a, b) => value(b) - value(a)));

  if (!byPos.GKP.length) return null;
  let best = null;
  for (const f of FORMATIONS) {
    if (byPos.DEF.length < f.DEF || byPos.MID.length < f.MID || byPos.FWD.length < f.FWD) continue;
    const xi = [byPos.GKP[0], ...byPos.DEF.slice(0, f.DEF), ...byPos.MID.slice(0, f.MID), ...byPos.FWD.slice(0, f.FWD)];
    const points = xi.reduce((s, p) => s + value(p), 0);
    if (!best || points > best.points) best = { formation: f.name, shape: f, xi, points: round(points, 2) };
  }
  if (!best) return null;

  const inXI = new Set(best.xi.map((p) => p.id));
  const rest = squadPlayers.filter((p) => !inXI.has(p.id));
  // the reserve keeper always occupies the first bench slot in FPL
  const benchGk = rest.filter((p) => p.pos === 'GKP');
  const outfield = rest.filter((p) => p.pos !== 'GKP').sort((a, b) => value(b) - value(a));
  best.bench = [...benchGk, ...outfield];
  best.captain = best.xi.slice().sort((a, b) => value(b) - value(a))[0] || null;
  best.vice = best.xi.slice().sort((a, b) => value(b) - value(a))[1] || null;
  return best;
}

/* ──────────────────────────── team health ──────────────────────────────── */

const BENCHMARK = { xpts: 55, value: 5.5, benchPts: 8 };

/**
 * A 0-100 composite across six things that independently sink a season, plus
 * the name of whichever is worst. Weights reflect how much each actually costs
 * you over a run of gameweeks.
 */
export function teamHealth(ctx) {
  if (!ctx.squad.length) return null;
  const squad = ctx.squad.map((s) => s.player);
  const best = optimalXI(squad, 0);
  if (!best) return null;

  const xiPts = best.points;
  const benchPts = best.bench.reduce((s, p) => s + (p.proj[0] || 0), 0);
  const avgFdr = mean(squad.map((p) => mean(p.fixtures.slice(0, 5).map((f) => (f.blank ? 4 : f.difficulty)))));
  const minutes = mean(best.xi.map((p) => p.avail));
  const squadValue = squad.reduce((s, p) => s + p.price, 0);
  const ptsPerM = squadValue > 0 ? (xiPts / squadValue) * 100 : 0;
  const flagged = squad.filter((p) => p.status !== 'a').length;

  const components = [
    { key: 'Expected points', weight: 0.28, score: clamp((xiPts / BENCHMARK.xpts) * 100, 0, 100),
      detail: `${xiPts.toFixed(1)} projected from your best XI` },
    { key: 'Fixtures',        weight: 0.18, score: clamp(((5.2 - avgFdr) / 2.4) * 100, 0, 100),
      detail: `average difficulty ${avgFdr.toFixed(2)} over five gameweeks` },
    { key: 'Minutes security',weight: 0.20, score: clamp(minutes * 100, 0, 100),
      detail: `${Math.round(minutes * 100)}% of XI minutes look safe` },
    { key: 'Value',           weight: 0.12, score: clamp((ptsPerM / BENCHMARK.value) * 100, 0, 100),
      detail: `${ptsPerM.toFixed(2)} points per £10m of squad` },
    { key: 'Injury risk',     weight: 0.12, score: clamp(100 - flagged * 22, 0, 100),
      detail: flagged ? `${flagged} flagged player${flagged === 1 ? '' : 's'}` : 'nobody flagged' },
    { key: 'Bench strength',  weight: 0.10, score: clamp((benchPts / BENCHMARK.benchPts) * 100, 0, 100),
      detail: `${benchPts.toFixed(1)} projected on the bench` },
  ];

  const score = Math.round(components.reduce((s, c) => s + c.score * c.weight, 0));
  const weakest = components.slice().sort((a, b) => a.score - b.score)[0];
  return { score, components, weakness: weakest, xi: best };
}

/* ─────────────────────── categorisation & advice ───────────────────────── */

/**
 * Buy / Hold / Monitor / Sell. Deliberately separates the short and long
 * readings so a player having a rough month with a good run coming is a hold,
 * not a sell.
 */
export function categorise(p) {
  const { short, long, overall } = p.scores;
  if (p.status === 's' || p.status === 'i' || p.status === 'u') return { tag: 'sell', why: 'unavailable' };
  if (p.status === 'd' && (p.chance == null || p.chance < 50)) return { tag: 'monitor', why: 'fitness doubt' };
  if (short < 2.2 && long < 2.4) return { tag: 'sell', why: 'weak now and later' };
  if (short < 2.4 && long >= 3.2) return { tag: 'hold', why: 'poor run, strong longer term' };
  if (short >= 4 && long >= 3.6) return { tag: 'buy', why: 'strong on both horizons' };
  if (overall >= 3.4) return { tag: 'hold', why: 'solid' };
  return { tag: 'monitor', why: 'borderline' };
}

/**
 * Ranked replacements for a player being sold, each with the reason it beat the
 * alternatives — taken from whichever factor actually drives the gap.
 */
export function transferAlternatives(outPlayer, ctx, budget, squadIds = [], limit = 8) {
  const owned = new Set(squadIds);
  const clubCount = {};
  squadIds.forEach((id) => {
    const q = ctx.byId.get(id);
    if (q && q.id !== outPlayer.id) clubCount[q.team] = (clubCount[q.team] || 0) + 1;
  });
  const ceiling = round(budget + outPlayer.price, 1);

  return ctx.players
    .filter((p) => p.pos === outPlayer.pos && !owned.has(p.id) && p.price <= ceiling + 1e-6 && p.status === 'a')
    .map((p) => {
      const gain = round(p.scores.overall - outPlayer.scores.overall, 2);
      const reasons = [];
      const fdrOut = mean(outPlayer.fixtures.slice(0, 5).map((f) => (f.blank ? 4 : f.difficulty)));
      const fdrIn = mean(p.fixtures.slice(0, 5).map((f) => (f.blank ? 4 : f.difficulty)));
      if (fdrOut - fdrIn > 0.4) reasons.push(`kinder fixtures (${fdrIn.toFixed(1)} vs ${fdrOut.toFixed(1)})`);
      if (p.per90.xGI > outPlayer.per90.xGI * 1.25 && p.per90.xGI > 0.25) reasons.push(`higher xGI/90 (${p.per90.xGI.toFixed(2)})`);
      if (p.avail > outPlayer.avail + 0.15) reasons.push(`safer minutes (${Math.round(p.avail * 100)}%)`);
      if (p.scores.value > outPlayer.scores.value * 1.15) reasons.push(`better value at £${p.price.toFixed(1)}`);
      if (p.eo < 10 && p.scores.overall > outPlayer.scores.overall) reasons.push(`low ownership at ${p.eo.toFixed(1)}%`);
      return {
        player: p, gain,
        spend: round(p.price - outPlayer.price, 1),
        atClubLimit: (clubCount[p.team] || 0) >= MAX_PER_CLUB,
        reason: reasons.slice(0, 2).join(', ') || 'higher projection',
      };
    })
    .sort((a, b) => b.gain - a.gain)
    .slice(0, limit);
}

/* ─────────────────────── gameweek lifecycle ────────────────────────────── */

/**
 * Which phase the gameweek is in, and — the part that actually matters — which
 * gameweek any advice on screen applies to.
 *
 * While matches are being played the current gameweek is already decided, so
 * every recommendation is really about the next one. Saying so explicitly is
 * the difference between a useful page and a confusing one.
 */
export function gameweekState(ctx) {
  const live = ctx.snapshot.live || null;
  const cur = ctx.snapshot.currentEvent;
  const next = ctx.snapshot.nextEvent;
  const total = live ? live.total : 0;
  const started = live ? live.started : 0;
  const inPlay = live ? live.inPlay : 0;

  // "live" means the round is under way: something has kicked off and the
  // whole set has not finished yet.
  const isLive = total > 0 && started > 0 && !live.allFinished;
  const liveGw = live && live.gw != null ? live.gw : cur ? cur.id : null;
  const targetGw = next ? next.id : liveGw != null ? liveGw + 1 : null;

  const asOf = ctx.snapshot.generatedAt || null;
  const ageMin = asOf ? Math.max(0, Math.round((Date.now() - new Date(asOf).getTime()) / 60000)) : null;

  if (isLive) {
    return {
      phase: 'live', liveGw, targetGw, asOf, ageMin,
      started, inPlay, total,
      deadline: next ? next.deadline : null,
      headline: `GW${liveGw} live`,
      detail: inPlay
        ? `${inPlay} of ${total} matches underway. Advice below is for GW${targetGw}.`
        : `${started} of ${total} matches played. Advice below is for GW${targetGw}.`,
    };
  }

  return {
    phase: 'upcoming', liveGw, targetGw, asOf, ageMin,
    started, inPlay, total,
    deadline: next ? next.deadline : null,
    headline: `GW${targetGw} upcoming`,
    detail: next
      ? `Deadline ${new Date(next.deadline).toLocaleString(undefined, {
          weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
        })}. Everything below applies to GW${targetGw}.`
      : `Everything below applies to GW${targetGw}.`,
  };
}

/* ───────────────────────────── fan traits ──────────────────────────────── */

/**
 * Plain-language reads on a player, each carrying the number it came from.
 *
 * The point is layering, not simplification: a badge is the headline and the
 * raw figure travels with it, so nothing is lost for someone who wants the
 * underlying stat.
 */
export function playerTraits(p, limit = 4) {
  const r = p.per90 || { xG: 0, xA: 0, xGI: 0, xGC: 0, saves: 0 };
  const fdr = p.fixtures && p.fixtures.length
    ? mean(p.fixtures.slice(0, 5).map((f) => (f.blank ? 4 : f.difficulty)))
    : 3;
  const out = [];
  const add = (key, icon, label, tone, raw, weight) => out.push({ key, icon, label, tone, raw, weight });

  if (p.status === 'i' || p.status === 'u') add('out', '🚑', 'Ruled out', 'bad', p.news || 'unavailable', 100);
  else if (p.status === 's') add('ban', '🟥', 'Suspended', 'bad', p.news || 'suspended', 99);
  else if (p.status === 'd') add('doubt', '⚠️', 'Fitness doubt', 'warn', `${p.chance == null ? '50' : p.chance}% chance of playing`, 98);

  if (r.xG >= 0.45) add('threat', '🔥', 'High goal threat', 'good', `xG/90 ${r.xG.toFixed(2)}`, 90);
  else if (r.xG >= 0.28) add('threat2', '⚽', 'Gets chances', 'good', `xG/90 ${r.xG.toFixed(2)}`, 60);

  if (r.xA >= 0.30) add('creator', '🎯', 'Chance creator', 'good', `xA/90 ${r.xA.toFixed(2)}`, 85);

  if ((p.pos === 'DEF' || p.pos === 'GKP') && r.xGC > 0 && r.xGC <= 1.05) {
    add('cs', '🧱', 'Clean sheet odds', 'good', `xGC/90 ${r.xGC.toFixed(2)}`, 80);
  }
  if (p.pos === 'DEF' && r.xGI >= 0.3) add('attdef', '🚀', 'Attacking defender', 'good', `xGI/90 ${r.xGI.toFixed(2)}`, 82);

  if (p.avail >= 0.9 && p.status === 'a') add('nailed', '🔒', 'Nailed on', 'good', `${Math.round(p.avail * 100)}% of minutes`, 70);
  else if (p.avail > 0 && p.avail < 0.6) add('rotation', '🔄', 'Rotation risk', 'warn', `${Math.round(p.avail * 100)}% of minutes`, 88);

  if ((p.form || 0) >= 6) add('form', '📈', 'In form', 'good', `form ${(p.form || 0).toFixed(1)}`, 75);
  else if ((p.form || 0) <= 1.5 && p.avail > 0.5) add('cold', '📉', 'Out of form', 'warn', `form ${(p.form || 0).toFixed(1)}`, 55);

  if (fdr <= 2.6) add('kind', '🗓️', 'Kind fixtures', 'good', `FDR ${fdr.toFixed(1)} next 5`, 72);
  else if (fdr >= 4) add('tough', '🧗', 'Tough run', 'warn', `FDR ${fdr.toFixed(1)} next 5`, 68);

  if (p.eo != null && p.eo < 8 && p.scores && p.scores.overall > 2.5) {
    add('diff', '💎', 'Differential', 'info', `${p.eo.toFixed(1)}% effective ownership`, 65);
  } else if (p.eo != null && p.eo >= 40) {
    add('template', '🏰', 'Template pick', 'info', `${p.eo.toFixed(1)}% effective ownership`, 50);
  }

  if (p.progress >= 100) add('rise', '💰', 'Price rising', 'info', `${p.progress}% to a rise`, 62);
  else if (p.progress <= -100) add('fall', '📉', 'Price falling', 'warn', `${Math.abs(p.progress)}% to a fall`, 64);

  return out.sort((a, b) => b.weight - a.weight).slice(0, limit);
}

/* ─────────────────────── multi-week transfer plans ─────────────────────── */

/** The four chips, and what each one does to a gameweek's scoring. */
export const CHIPS = {
  wildcard: { key: 'wildcard', name: 'Wildcard', icon: '🃏', blurb: 'Unlimited transfers this week, no hits. The squad keeps the changes.' },
  freehit:  { key: 'freehit',  name: 'Free Hit',  icon: '🎟️', blurb: 'Unlimited transfers for this week only. The squad reverts afterwards.' },
  '3xc':    { key: '3xc',      name: 'Triple Captain', icon: '👑', blurb: 'Your captain scores triple instead of double.' },
  bboost:   { key: 'bboost',   name: 'Bench Boost', icon: '🪑', blurb: 'All fifteen players score, not just the eleven.' },
};

/**
 * Walks a plan gameweek by gameweek: applies each week's transfers, tracks the
 * bank and the accumulated hits, and totals the projected points from the best
 * legal XI in every week. Two plans evaluated this way are directly comparable.
 *
 * plan = { name, weeks: [{ gw, transfers: [{ out: id, in: id }] }] }
 */
export function evaluatePlan(plan, ctx, opts = {}) {
  const freePerWeek = opts.freeTransfers == null ? 1 : opts.freeTransfers;
  let banked = opts.startingFree == null ? 1 : opts.startingFree;
  let bank = ctx.entry ? ctx.entry.bank : 0;
  let squad = ctx.squad.map((s) => s.id);

  const weeks = [];
  let totalPoints = 0, totalHits = 0;
  const problems = [];

  // A chip can only be played once, so a plan that spends one twice is invalid
  // however good it looks.
  const chipUse = {};
  (plan.weeks || []).forEach((w) => {
    if (!w.chip) return;
    if (!CHIPS[w.chip]) { problems.push(`GW${w.gw}: unknown chip "${w.chip}"`); return; }
    chipUse[w.chip] = (chipUse[w.chip] || 0) + 1;
  });
  Object.entries(chipUse).forEach(([c, n]) => {
    if (n > 1) problems.push(`${CHIPS[c].name} is played ${n} times — you only have one`);
  });

  ctx.gws.forEach((gw, idx) => {
    const step = (plan.weeks || []).find((w) => w.gw === gw);
    const moves = (step && step.transfers) || [];
    const chip = step && step.chip && CHIPS[step.chip] ? step.chip : null;
    const unlimited = chip === 'wildcard' || chip === 'freehit';

    // Free Hit only rents the squad for one week, so remember what to give back.
    const squadBefore = squad.slice();
    const bankBefore = bank;

    moves.forEach((t) => {
      const outP = ctx.byId.get(t.out), inP = ctx.byId.get(t.in);
      if (!outP || !inP) { problems.push(`GW${gw}: unknown player in a transfer`); return; }
      if (!squad.includes(t.out)) { problems.push(`GW${gw}: ${outP.name} is not in the squad by then`); return; }
      if (squad.includes(t.in)) { problems.push(`GW${gw}: ${inP.name} is already owned`); return; }
      if (inP.pos !== outP.pos) { problems.push(`GW${gw}: ${inP.name} is a ${inP.pos}, ${outP.name} a ${outP.pos}`); return; }
      bank = round(bank + outP.price - inP.price, 1);
      squad = squad.map((id) => (id === t.out ? t.in : id));
    });

    if (bank < -1e-9) problems.push(`GW${gw}: over budget by £${Math.abs(bank).toFixed(1)}m`);
    const clubs = {};
    squad.forEach((id) => { const q = ctx.byId.get(id); if (q) clubs[q.team] = (clubs[q.team] || 0) + 1; });
    Object.entries(clubs).forEach(([tid, n]) => {
      if (n > MAX_PER_CLUB) {
        const t = ctx.teams.get(Number(tid));
        problems.push(`GW${gw}: ${n} from ${t ? t.name : 'one club'} (max ${MAX_PER_CLUB})`);
      }
    });

    const used = moves.length;
    const paid = unlimited ? 0 : Math.max(0, used - banked);
    const hit = paid * HIT_COST;
    // playing a chip preserves the free transfer rather than spending it
    if (!unlimited) banked = Math.min(5, banked - Math.min(used, banked) + freePerWeek);
    else banked = Math.min(5, banked + freePerWeek);

    const players = squad.map((id) => ctx.byId.get(id)).filter(Boolean);
    const best = optimalXI(players, idx);

    // Captaincy is worth an extra copy of the armband's projection — two more
    // under Triple Captain. Bench Boost scores all fifteen instead of eleven.
    const capMult = chip === '3xc' ? 3 : 2;
    const capBonus = best && best.captain ? (best.captain.proj[idx] || 0) * (capMult - 1) : 0;
    const base = chip === 'bboost'
      ? players.reduce((s, q) => s + (q.proj[idx] || 0), 0)
      : best ? best.points : 0;
    const points = round(base + capBonus, 2);

    totalPoints += points;
    totalHits += hit;
    weeks.push({
      gw, transfers: moves, chip, hit, bank,
      points, net: round(points - hit, 2),
      formation: best ? best.formation : null,
      captain: best && best.captain ? best.captain.name : null,
      captainMultiplier: capMult,
      benchCounted: chip === 'bboost',
      squad: squad.slice(),
    });

    if (chip === 'freehit') { squad = squadBefore; bank = bankBefore; }
  });

  return {
    name: plan.name || 'Plan',
    weeks,
    points: round(totalPoints, 2),
    hits: totalHits,
    net: round(totalPoints - totalHits, 2),
    endBank: bank,
    chips: Object.keys(chipUse),
    problems,
  };
}

/* ───────────────────────── captaincy ranking ────────────────────────────── */

/**
 * Top captaincy options with the risk profile attached. Safe / Balanced /
 * Aggressive comes from effective ownership: captaining what everyone else
 * captains protects rank, going against them swings it.
 */
export function captainRanking(ctx, limit = 3, withSim = true) {
  if (!ctx.squad.length) return [];
  const starters = optimalXI(ctx.squad.map((s) => s.player), 0);
  const pool = starters ? starters.xi : ctx.squad.map((s) => s.player);

  return pool
    .filter((p) => p.avail > 0)
    .sort((a, b) => b.proj[0] - a.proj[0])
    .slice(0, limit)
    .map((p) => {
      const sim = withSim ? simulatePlayer(p, 0, ctx, 1200) : null;
      const impact = withSim ? captainRankImpact(p, ctx, 900) : null;
      const profile = p.eo >= 35 ? 'Safe' : p.eo >= 12 ? 'Balanced' : 'Aggressive';
      const f = p.fixtures[0];
      return {
        player: p,
        xPts: round((p.proj[0] || 0) * 2, 2),
        fixture: f && !f.blank ? f : null,
        minutes: Math.round(p.avail * 100),
        xGI90: round(p.per90.xGI, 2),
        eo: p.eo,
        profile,
        sim, impact,
      };
    });
}

/* ─────────────────────────── fixture swings ─────────────────────────────── */

/**
 * Finds the gameweek where a club's run changes character, by comparing a
 * three-week block before against the three after and reporting the sharpest
 * shift. "Fixture swing → GW8" means the run gets materially easier there.
 */
export function fixtureSwings(ctx, minShift = 0.7) {
  const out = [];
  ctx.teams.forEach((team) => {
    const list = (ctx.snapshot.fixtures && ctx.snapshot.fixtures[team.id]) || [];
    const byGw = ctx.gws.map((gw) => {
      const g = list.filter((f) => f.gw === gw);
      return g.length ? g.reduce((s, x) => s + x.d, 0) / g.length : 3;
    });
    let bestShift = 0, bestGw = null;
    for (let i = 1; i < byGw.length; i++) {
      const before = mean(byGw.slice(Math.max(0, i - 3), i));
      const after = mean(byGw.slice(i, Math.min(byGw.length, i + 3)));
      const shift = before - after; // positive = getting easier
      if (Math.abs(shift) > Math.abs(bestShift)) { bestShift = shift; bestGw = ctx.gws[i]; }
    }
    if (bestGw && Math.abs(bestShift) >= minShift) {
      out.push({ team, gw: bestGw, shift: round(bestShift, 2), direction: bestShift > 0 ? 'easier' : 'harder', blocks: byGw });
    }
  });
  return out.sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift));
}

/* ────────────────────────── the decision layer ─────────────────────────── */

/**
 * The "what should I do this week" synthesis. Everything above feeds this; it
 * is the only function that makes a recommendation rather than a measurement.
 */
export function weeklyAdvice(ctx, opts = {}) {
  if (!ctx.squad.length) return null;
  const squad = ctx.squad.map((s) => s.player);
  const best = optimalXI(squad, 0);
  const health = teamHealth(ctx);
  const caps = captainRanking(ctx, 3, opts.simulate !== false);
  const bank = ctx.entry ? ctx.entry.bank : 0;
  const free = opts.freeTransfers == null ? 1 : opts.freeTransfers;

  // the single transfer with the best projected gain over the horizon
  let bestMove = null;
  squad.forEach((outP) => {
    const alts = transferAlternatives(outP, ctx, bank, squad.map((p) => p.id), 3);
    alts.forEach((alt) => {
      if (alt.atClubLimit) return;
      const gain = round(alt.gain * ctx.gws.length, 2);
      if (!bestMove || gain > bestMove.horizonGain) {
        bestMove = { out: outP, in: alt.player, perGw: alt.gain, horizonGain: gain, reason: alt.reason, spend: alt.spend };
      }
    });
  });

  const hit = free >= 1 ? 0 : HIT_COST;
  const worthIt = bestMove ? bestMove.horizonGain - hit : 0;
  const confidence = !bestMove ? 'none'
    : worthIt > 6 ? 'high'
    : worthIt > 2.5 ? 'moderate'
    : 'low';

  // biggest risk in the starting XI
  const risks = best.xi.map((p) => {
    if (p.status !== 'a') return { p, kind: 'availability', severity: 3, text: `${p.name} is flagged` };
    if (p.avail < 0.6) return { p, kind: 'rotation', severity: 2, text: `${p.name} is at ${Math.round(p.avail * 100)}% projected minutes` };
    if ((p.fixtures[0] && p.fixtures[0].difficulty) >= 4.5) return { p, kind: 'fixture', severity: 1, text: `${p.name} has a very tough fixture` };
    return null;
  }).filter(Boolean).sort((a, b) => b.severity - a.severity);

  const headline = buildHeadline(ctx, squad, health);

  return {
    xi: best.xi, bench: best.bench, formation: best.formation,
    captain: caps[0] || null, vice: caps[1] || null, captains: caps,
    expectedPoints: round(best.points + (caps[0] ? caps[0].player.proj[0] : 0), 1),
    transfer: bestMove, hit, confidence, worthIt,
    risk: risks[0] || null,
    health, headline,
  };
}

/** The one-line "your biggest problem is…" reading. */
function buildHeadline(ctx, squad, health) {
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  squad.forEach((p) => byPos[p.pos] && byPos[p.pos].push(p));

  let worst = null;
  Object.entries(byPos).forEach(([pos, list]) => {
    if (!list.length || pos === 'GKP') return;
    const tiedUp = list.filter((p) => p.per90.xGI < 0.28 && p.price >= 6);
    const spend = tiedUp.reduce((s, p) => s + p.price, 0);
    if (spend > 0 && (!worst || spend > worst.spend)) {
      worst = { pos, spend: round(spend, 1), players: tiedUp };
    }
  });

  if (worst && worst.spend >= 12) {
    const AREA = { DEF: 'defence', MID: 'midfield', FWD: 'attack' };
    return {
      kind: 'dead-money',
      text: `Your ${AREA[worst.pos] || worst.pos} has £${worst.spend.toFixed(1)}m tied up in players with low xGI over the next ${ctx.gws.length} gameweeks.`,
      players: worst.players,
    };
  }
  const flagged = squad.filter((p) => p.status !== 'a');
  if (flagged.length >= 2) {
    return { kind: 'availability', text: `${flagged.length} of your squad are carrying an injury or ban.`, players: flagged };
  }
  if (health && health.weakness && health.weakness.score < 55) {
    return { kind: 'health', text: `${health.weakness.key} is the weakest part of your team — ${health.weakness.detail}.`, players: [] };
  }
  return { kind: 'ok', text: 'No structural problem stands out this week. The margins are in the captaincy.', players: [] };
}

/* ─────────────────────── ownership vs opportunity ──────────────────────── */

/**
 * Replaces the blunt "under 5% owned" filter. A differential is a player whose
 * projected return is high *relative to how exposed the field already is*, so a
 * 12%-owned player projecting 6 points is a better differential than a 3%-owned
 * player projecting 2.
 */
export function ownershipOpportunity(ctx, limit = 20) {
  const scored = ctx.players
    .filter((p) => p.status === 'a' && p.avail > 0.4 && p.proj[0] > 0)
    .map((p) => ({
      player: p,
      opportunity: round(p.scores.overall * (1 - clamp(p.eo / 100, 0, 0.95)), 3),
      eo: p.eo,
      projected: p.scores.overall,
    }));
  return scored.sort((a, b) => b.opportunity - a.opportunity).slice(0, limit);
}

/* ──────────────────────── template comparison ──────────────────────────── */

/**
 * Builds the template squad greedily by ownership within the FPL constraints,
 * then reports what you are missing and where you diverge.
 */
export function templateSquad(ctx) {
  const need = { ...SQUAD_SHAPE };
  const clubs = {};
  const picked = [];
  const pool = ctx.players
    .filter((p) => p.status === 'a')
    .sort((a, b) => b.owned - a.owned);

  for (const p of pool) {
    if (!need[p.pos]) continue;
    if ((clubs[p.team] || 0) >= MAX_PER_CLUB) continue;
    picked.push(p);
    need[p.pos]--;
    clubs[p.team] = (clubs[p.team] || 0) + 1;
    if (Object.values(need).every((n) => n === 0)) break;
  }
  return picked;
}

export function templateDiff(ctx) {
  if (!ctx.squad.length) return null;
  const template = templateSquad(ctx);
  const templateIds = new Set(template.map((p) => p.id));
  const mine = ctx.squad.map((s) => s.player);
  const myIds = new Set(mine.map((p) => p.id));

  const missing = template
    .filter((p) => !myIds.has(p.id))
    .sort((a, b) => b.eo - a.eo);
  const differentials = mine
    .filter((p) => !templateIds.has(p.id))
    .sort((a, b) => a.eo - b.eo);

  return {
    template,
    missing,
    differentials,
    // how much of the field's exposure you are choosing to go without
    exposureGap: round(missing.reduce((s, p) => s + p.eo, 0), 1),
    overlap: template.length ? Math.round(((template.length - missing.length) / template.length) * 100) : 0,
  };
}
