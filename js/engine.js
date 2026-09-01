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
 *
 * `team` picks which configured manager's squad to attach. None of the work
 * here depends on it, so switching later goes through `selectEntry` instead of
 * calling this again.
 */
export function buildContext(snapshot, details = {}, team = null) {
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

  // Every configured manager, in config order. Older snapshots carry a single
  // `entry` instead, so that is normalised into the same list.
  const entries = Array.isArray(snapshot.entries) && snapshot.entries.length
    ? snapshot.entries
    : snapshot.entry ? [snapshot.entry] : [];

  const ctx = {
    snapshot, details, players, byId, teams, gws, gwPlayed, horizon,
    totalManagers: snapshot.totalManagers || 1,
    entries,
    entry: null,
    squad: [],
  };

  attachEffectiveOwnership(ctx);
  players.forEach((p) => {
    p.scores = playerScores(p, ctx);
    p.score = p.scores.overall;
    p.traits = playerTraits(p);
  });
  selectEntry(ctx, team);
  return ctx;
}

/**
 * Point the context at one manager's team.
 *
 * None of the analysis above depends on whose squad it is — the projection
 * grid, the six scores and effective ownership are all properties of the
 * player pool. So switching manager is a cheap swap of two fields, not a
 * rebuild, which is what makes a team switcher instant on a phone.
 *
 * `key` matches on the config key or the raw entry id. Pass `false` for
 * "no team" — every non-squad section still works without one.
 */
export function selectEntry(ctx, key) {
  const list = ctx.entries || [];
  let found = null;
  if (key !== false && key != null) {
    found = list.find((e) => e && (e.key === String(key) || String(e.id) === String(key))) || null;
  } else if (key == null) {
    found = list[0] || null;
  }
  ctx.entry = found && !found.error ? found : null;
  ctx.squad = ctx.entry && ctx.entry.picks
    ? ctx.entry.picks.map((pk) => ({ ...pk, player: ctx.byId.get(pk.id) })).filter((x) => x.player)
    : [];
  return ctx.entry;
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

/* ─────────────────────── lineups you arrange yourself ───────────────────── */

/** How many of each position an eleven contains. */
export function xiCounts(xi) {
  const c = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  xi.forEach((p) => { if (c[p.pos] != null) c[p.pos] += 1; });
  return c;
}

/** Every FPL rule about the shape of a starting eleven, in one place. */
export function shapeProblem(c) {
  const total = c.GKP + c.DEF + c.MID + c.FWD;
  if (c.GKP !== 1) return c.GKP < 1 ? 'You need a goalkeeper in the eleven.' : 'Only one goalkeeper can start.';
  if (c.DEF < 3) return `That would leave ${c.DEF} defender${c.DEF === 1 ? '' : 's'} — you need at least three.`;
  if (c.DEF > 5) return 'Five defenders is the most you can play.';
  if (c.MID < 2) return `That would leave ${c.MID} midfielder${c.MID === 1 ? '' : 's'} — you need at least two.`;
  if (c.MID > 5) return 'Five midfielders is the most you can play.';
  if (c.FWD < 1) return 'You need at least one forward.';
  if (c.FWD > 3) return 'Three forwards is the most you can play.';
  if (total !== 11) return `That makes ${total} players, not eleven.`;
  return null;
}
export const legalShape = (c) => shapeProblem(c) === null;
export const formationName = (c) => `${c.DEF}-${c.MID}-${c.FWD}`;

/** The reserve keeper occupies the first bench slot; the rest keep their order. */
function orderBench(list) {
  const gk = list.filter((p) => p.pos === 'GKP');
  return [...gk, ...list.filter((p) => p.pos !== 'GKP')];
}

/**
 * Finish a part-built eleven: keep everyone already chosen, then fill the gaps
 * with the best available under whichever legal formation scores highest.
 * Returns null when the players on hand cannot make a legal shape at all.
 */
function completeXI(kept, pool, value) {
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  pool.forEach((p) => { if (byPos[p.pos]) byPos[p.pos].push(p); });
  Object.keys(byPos).forEach((k) => byPos[k].sort((a, b) => value(b) - value(a)));
  const have = xiCounts(kept);

  let best = null;
  for (const f of FORMATIONS) {
    const need = { GKP: 1 - have.GKP, DEF: f.DEF - have.DEF, MID: f.MID - have.MID, FWD: f.FWD - have.FWD };
    if (Object.values(need).some((n) => n < 0)) continue;                 // already over that line
    if (Object.keys(need).some((k) => need[k] > byPos[k].length)) continue; // not enough left
    const add = ['GKP', 'DEF', 'MID', 'FWD'].flatMap((k) => byPos[k].slice(0, need[k]));
    const xi = [...kept, ...add];
    const points = xi.reduce((s, p) => s + value(p), 0);
    if (!best || points > best.points) best = { formation: f.name, shape: f, xi, points: round(points, 2) };
  }
  return best;
}

/**
 * The eleven to field, honouring a lineup the user arranged by hand.
 *
 * A manual lineup has to survive transfers. Selling a bench player should not
 * silently rearrange the eleven you spent a minute setting up, and selling a
 * starter should replace only him. So the manual XI is filtered down to the
 * players still owned, then completed — and only a lineup that cannot be
 * repaired at all falls back to the optimiser.
 */
export function arrangeXI(squadPlayers, gwIndex = 0, manual = null, key = null) {
  const value = (p) => (key ? key(p) : (p.proj && p.proj[gwIndex]) || 0);
  const auto = optimalXI(squadPlayers, gwIndex, key);
  const ids = manual && Array.isArray(manual.xi) ? manual.xi : null;
  if (!ids || !ids.length) return auto ? { ...auto, manual: false, repaired: false } : null;

  const byId = new Map(squadPlayers.map((p) => [p.id, p]));
  const kept = [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean).slice(0, 11);
  const keptIds = new Set(kept.map((p) => p.id));
  const pool = squadPlayers.filter((p) => !keptIds.has(p.id));

  const built = completeXI(kept, pool, value);
  if (!built) return auto ? { ...auto, manual: false, repaired: true } : null;

  const inXI = new Set(built.xi.map((p) => p.id));
  const rest = squadPlayers.filter((p) => !inXI.has(p.id));
  // the bench keeps the order you gave it, with anyone new appended
  const order = new Map((manual.bench || []).map((id, i) => [id, i]));
  rest.sort((a, b) => (order.has(a.id) ? order.get(a.id) : 99) - (order.has(b.id) ? order.get(b.id) : 99));

  built.bench = orderBench(rest);
  built.captain = built.xi.slice().sort((a, b) => value(b) - value(a))[0] || null;
  built.vice = built.xi.slice().sort((a, b) => value(b) - value(a))[1] || null;
  built.manual = true;
  built.repaired = kept.length !== built.xi.length;
  return built;
}

/**
 * Swap two players between the eleven and the bench, or reorder the bench.
 * Returns the new id lists, or the reason the swap is not allowed — phrased as
 * the rule it would break, because "invalid formation" tells you nothing about
 * what to do instead.
 */
export function swapLineup(arrangement, aId, bId) {
  const xi = arrangement.xi.slice();
  const bench = arrangement.bench.slice();
  const at = (list, id) => list.findIndex((p) => p.id === id);
  const ax = at(xi, aId), bx = at(xi, bId), ab = at(bench, aId), bb = at(bench, bId);
  const a = ax >= 0 ? xi[ax] : ab >= 0 ? bench[ab] : null;
  const b = bx >= 0 ? xi[bx] : bb >= 0 ? bench[bb] : null;
  if (!a || !b || a.id === b.id) return { ok: false, error: 'Pick two different players.' };

  if (ab >= 0 && bb >= 0) {
    const next = bench.slice();
    next[ab] = b; next[bb] = a;
    if (a.pos === 'GKP' || b.pos === 'GKP') {
      return { ok: false, error: 'The reserve keeper stays in the first bench slot — swap him with your starting keeper instead.' };
    }
    return { ok: true, xi: xi.map((p) => p.id), bench: next.map((p) => p.id),
      formation: formationName(xiCounts(xi)) };
  }
  if (ax >= 0 && bx >= 0) return { ok: false, error: 'Both are already in your eleven.' };

  const starter = ax >= 0 ? a : b;
  const sub = ax >= 0 ? b : a;
  if ((starter.pos === 'GKP') !== (sub.pos === 'GKP')) {
    return { ok: false, error: 'A goalkeeper can only swap with the other goalkeeper.' };
  }
  const nextXI = xi.map((p) => (p.id === starter.id ? sub : p));
  const counts = xiCounts(nextXI);
  const problem = shapeProblem(counts);
  if (problem) return { ok: false, error: problem };
  const nextBench = orderBench(bench.map((p) => (p.id === sub.id ? starter : p)));
  return { ok: true, xi: nextXI.map((p) => p.id), bench: nextBench.map((p) => p.id),
    formation: formationName(counts) };
}

/**
 * Move the whole squad into a named formation, keeping as many of the current
 * starters as that shape allows — so changing 4-4-2 to 3-5-2 drops one defender
 * and promotes one midfielder rather than rebuilding the eleven from scratch.
 */
export function applyFormation(arrangement, name, gwIndex = 0, key = null) {
  const f = FORMATIONS.find((x) => x.name === name);
  if (!f) return { ok: false, error: `${name} is not a legal formation.` };
  const value = (p) => (key ? key(p) : (p.proj && p.proj[gwIndex]) || 0);
  const all = [...arrangement.xi, ...arrangement.bench];
  const starting = new Set(arrangement.xi.map((p) => p.id));

  const pick = (pos, n) => {
    const list = all.filter((p) => p.pos === pos).sort((x, y) => {
      const sx = starting.has(x.id) ? 1 : 0, sy = starting.has(y.id) ? 1 : 0;
      return sy - sx || value(y) - value(x);
    });
    return list.slice(0, n);
  };
  const gk = pick('GKP', 1), def = pick('DEF', f.DEF), mid = pick('MID', f.MID), fwd = pick('FWD', f.FWD);
  if (gk.length < 1 || def.length < f.DEF || mid.length < f.MID || fwd.length < f.FWD) {
    return { ok: false, error: `You do not have the players for ${name} — that needs ${f.DEF} defenders, ${f.MID} midfielders and ${f.FWD} forwards.` };
  }
  const xi = [...gk, ...def, ...mid, ...fwd];
  const inXI = new Set(xi.map((p) => p.id));
  const bench = orderBench(all.filter((p) => !inXI.has(p.id)).sort((x, y) => value(y) - value(x)));
  return { ok: true, xi: xi.map((p) => p.id), bench: bench.map((p) => p.id), formation: name };
}

/**
 * Fill empty slots with the best legal squad the money will reach.
 *
 * Greedy, one slot at a time, but never spending money the slots still to come
 * will need. Before each pick it prices the cheapest legal way to finish — the
 * k cheapest buyable players at each remaining position, recomputed against the
 * squad as it stands, so the club limit and the players already taken both
 * count. Whatever is left over that floor is what this slot may spend.
 *
 * A slot that still cannot be filled comes back in `unfilled` rather than being
 * quietly dropped, because a squad that is silently fourteen players is worse
 * than one that says which shirt is still empty.
 *
 * This is a starting point, not a solved squad. It is what makes fifteen empty
 * shirts usable at all; the picks after it are the user's.
 */
export function fillSlots(ctx, squadIds, holes, bank, opts = {}) {
  let ids = (squadIds || []).filter((id) => id != null);
  let money = bank;
  const queue = holes.slice();
  const fills = [], unfilled = [];

  /** Cheapest legal way to fill the slots still queued, given who is owned. */
  const floor = () => {
    const owned = new Set(ids);
    const clubs = {};
    ids.forEach((id) => { const q = ctx.byId.get(id); if (q) clubs[q.team] = (clubs[q.team] || 0) + 1; });
    const need = {};
    queue.forEach((h) => { need[h.pos] = (need[h.pos] || 0) + 1; });
    let total = 0;
    for (const [pos, k] of Object.entries(need)) {
      const prices = ctx.players
        .filter((p) => p.pos === pos && p.status === 'a' && !owned.has(p.id) &&
          (clubs[p.team] || 0) < MAX_PER_CLUB)
        .map((p) => p.price).sort((a, b) => a - b).slice(0, k);
      if (prices.length < k) return Infinity;       // cannot be finished at all
      total += prices.reduce((s, v) => s + v, 0);
    }
    return total;
  };

  while (queue.length) {
    const h = queue.shift();
    const reserve = floor();
    const budget = round(money - (Number.isFinite(reserve) ? reserve : 0), 1);
    const rows = slotOptions(h.pos, ctx, budget, ids, {
      filter: { legalOnly: true, avail: 'fit', sort: opts.sort || 'gain' }, limit: 1,
    });
    if (!rows.length) { unfilled.push(h); continue; }
    const pick = rows[0].player;
    fills.push({ out: h.out, pos: h.pos, player: pick });
    ids = [...ids, pick.id];
    money = round(money - pick.price, 1);
  }

  /* Spend what is left.
   *
   * The pass above has to hold money back for the slots it has not reached, so
   * it finishes under budget — sometimes far under. Leaving that in the bank is
   * not caution, it is points you did not buy. So each round finds the single
   * upgrade that adds the most and takes it, until nothing left is worth the
   * money. One swap at a time, because a squad is a set of one-slot decisions
   * and the best next move is the only one worth being sure about. */
  const rounds = opts.upgrade === false ? 0 : 24;
  for (let i = 0; i < rounds && money > 0.05 && fills.length; i++) {
    let best = null;
    for (const f of fills) {
      const others = ids.filter((id) => id !== f.player.id);
      const cand = slotOptions(f.pos, ctx, round(money + f.player.price, 1), others, {
        filter: { legalOnly: true, avail: 'fit', sort: opts.sort || 'gain' }, limit: 1,
      })[0];
      if (!cand || cand.player.id === f.player.id) continue;
      const lift = cand.player.scores.overall - f.player.scores.overall;
      if (lift > 1e-6 && (!best || lift > best.lift)) best = { f, to: cand.player, lift };
    }
    if (!best) break;
    money = round(money + best.f.player.price - best.to.price, 1);
    ids = ids.map((id) => (id === best.f.player.id ? best.to.id : id));
    best.f.player = best.to;
  }

  return { fills, bank: money, unfilled };
}

/** Which formations this squad could actually field. */
export function availableFormations(squadPlayers) {
  const c = xiCounts(squadPlayers);
  return FORMATIONS.filter((f) => c.GKP >= 1 && c.DEF >= f.DEF && c.MID >= f.MID && c.FWD >= f.FWD)
    .map((f) => f.name);
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
/**
 * Every player who could go into this slot, each carrying the reason it would
 * or would not be legal.
 *
 * Nothing is filtered out. A picker that silently omits a player cannot answer
 * "why isn't he in the list?", which is the question you actually have when
 * you go looking for someone by name. So the wrong position, the ones you
 * already own, the ones over budget and the ones at the club limit are all
 * returned, each with `blocked` set to the reason — and it is the caller's job
 * to show that reason rather than hide the row.
 *
 * `blocked` priority runs most-fundamental first: a striker cannot replace a
 * defender no matter how much money you have, so position beats budget.
 */
export function replacementOptions(outPlayer, ctx, budget, squadIds = [], opts = {}) {
  return scanMarket(ctx, {
    pos: outPlayer.pos,
    ceiling: round(budget + outPlayer.price, 1),
    squadIds, out: outPlayer,
    query: opts.query, limit: opts.limit, filter: opts.filter,
  });
}

/**
 * The same list for an EMPTY slot — a shirt you have already sold out of.
 *
 * The difference from `replacementOptions` is entirely in the money: the sold
 * player's fee is already sitting in the bank, so the ceiling is the bank
 * itself rather than bank-plus-price, and he is buyable again like anyone else.
 * Everything about how a block is explained is shared, because the club rule
 * getting this wrong once was enough.
 */
export function slotOptions(pos, ctx, budget, squadIds = [], opts = {}) {
  return scanMarket(ctx, {
    pos, ceiling: round(budget, 1), squadIds, out: null,
    query: opts.query, limit: opts.limit, filter: opts.filter,
  });
}

/**
 * Every player the market can offer for one slot, each carrying the reason it
 * would or would not be legal. `out` is the player being sold, or null when the
 * slot is already empty.
 */
function scanMarket(ctx, spec) {
  const outPlayer = spec.out || null;
  // De-duplicate. A malformed plan can map two slots onto the same id, and a
  // duplicate silently inflates a club count — which reads to the user as the
  // three-per-club rule firing a player early, with nothing on screen to
  // explain it.
  const ids = [...new Set(spec.squadIds || [])].filter((id) => id != null);
  const owned = new Set(ids);
  const clubCount = {};
  const clubNames = {};
  ids.forEach((id) => {
    const q = ctx.byId.get(id);
    if (!q || (outPlayer && q.id === outPlayer.id)) return;
    clubCount[q.team] = (clubCount[q.team] || 0) + 1;
    (clubNames[q.team] = clubNames[q.team] || []).push(q.name);
  });
  const ceiling = spec.ceiling;
  const q = (spec.query || '').trim().toLowerCase();

  const rows = [];
  for (const p of ctx.players) {
    if (outPlayer && p.id === outPlayer.id) continue;
    if (q) {
      const t = ctx.teams.get(p.team) || {};
      const hay = `${p.full || ''} ${p.name} ${t.name || ''} ${t.short || ''} ${p.pos}`.toLowerCase();
      if (hay.indexOf(q) === -1) continue;
    } else if (spec.pos !== 'all' && p.pos !== spec.pos) {
      continue;                       // the ranked list stays like-for-like
    }

    const short = round(p.price - ceiling, 1);
    const club = (ctx.teams.get(p.team) || {}).short || 'club';
    // `blockedText` is a chip, so it must stay short enough not to wrap;
    // `blockedWhy` is the full sentence for the tooltip.
    let blocked = null, blockedText = null, blockedWhy = null, fixable = false;
    if (spec.pos !== 'all' && p.pos !== spec.pos) {
      blocked = 'position';
      blockedText = `${p.pos}, not ${spec.pos}`;
      blockedWhy = outPlayer
        ? `FPL only allows like-for-like swaps — a ${p.pos} cannot replace a ${outPlayer.pos}.`
        : `This slot is a ${spec.pos}. A ${p.pos} cannot fill it.`;
    } else if (owned.has(p.id)) {
      blocked = 'owned';
      blockedText = 'already yours';
      blockedWhy = 'He is already in this squad.';
    } else if ((clubCount[p.team] || 0) >= MAX_PER_CLUB) {
      // Print the REAL count, never the constant. A message that says "3 from
      // ARS" when you can see two on the pitch is unfalsifiable, and naming
      // them turns the claim into something you can check at a glance.
      const n = clubCount[p.team];
      blocked = 'club';
      blockedText = `${n} from ${club}`;
      blockedWhy = (outPlayer ? `Counting ${outPlayer.name} out, this` : 'This') +
        ` squad already has ${n} from ${club}` +
        (clubNames[p.team] ? ` (${clubNames[p.team].join(', ')})` : '') +
        `. The limit is ${MAX_PER_CLUB}.`;
      fixable = true;
    } else if (short > 1e-6) {
      blocked = 'budget';
      blockedText = `£${short.toFixed(1)}m short`;
      blockedWhy = `He costs £${p.price.toFixed(1)}m and you have £${ceiling.toFixed(1)}m for this slot.`;
      fixable = true;
    }

    const gain = round(outPlayer ? p.scores.overall - outPlayer.scores.overall : p.scores.overall, 2);
    const reasons = [];
    const fdrIn = fdrAhead(p, 5);
    if (outPlayer) {
      const fdrOut = fdrAhead(outPlayer, 5);
      if (fdrOut - fdrIn > 0.4) reasons.push(`kinder fixtures (${fdrIn.toFixed(1)} vs ${fdrOut.toFixed(1)})`);
      if (p.per90.xGI > outPlayer.per90.xGI * 1.25 && p.per90.xGI > 0.25) reasons.push(`higher xGI/90 (${p.per90.xGI.toFixed(2)})`);
      if (p.avail > outPlayer.avail + 0.15) reasons.push(`safer minutes (${Math.round(p.avail * 100)}%)`);
      if (p.scores.value > outPlayer.scores.value * 1.15) reasons.push(`better value at £${p.price.toFixed(1)}`);
      if (p.eo < 10 && p.scores.overall > outPlayer.scores.overall) reasons.push(`low ownership at ${p.eo.toFixed(1)}%`);
    } else {
      // Nothing to compare against, so the row argues for the player on his own
      // terms — the same traits the detail panel would show.
      (p.traits || []).slice(0, 2).forEach((t) => reasons.push(t.label.toLowerCase()));
      if (!reasons.length && fdrIn <= 2.8) reasons.push(`kind fixtures (${fdrIn.toFixed(1)})`);
    }

    rows.push({
      player: p, gain,
      spend: round(p.price - (outPlayer ? outPlayer.price : 0), 1),
      short: short > 0 ? short : 0,
      legal: !blocked,
      blocked, blockedText, blockedWhy,
      // a block you could clear yourself (money, club limit) ranks above one
      // you cannot (wrong position), because only one of them is worth acting on
      fixable,
      // kept for callers written against the old shape
      atClubLimit: blocked === 'club',
      reason: reasons.slice(0, 2).join(', ') || (outPlayer ? 'higher projection' : 'available'),
    });
  }

  return finishMarket(rows, spec.filter, spec.limit);
}

/** Average fixture difficulty over the next `n` gameweeks; a blank counts as 4. */
export function fdrAhead(p, n = 5) {
  const f = (p.fixtures || []).slice(0, n);
  return f.length ? mean(f.map((x) => (x.blank ? 4 : x.difficulty))) : 3;
}

/**
 * The columns you can rank the market by. `of` reads one number off a row; a
 * negative reading means "lower is better", which is how fixtures sort kindest
 * first without a second flag to keep track of.
 */
export const MARKET_SORTS = [
  { key: 'gain',  label: 'Projected gain', of: (r) => r.gain },
  { key: 'proj',  label: 'Next GW',        of: (r) => (r.player.proj && r.player.proj[0]) || 0 },
  { key: 'form',  label: 'Form',           of: (r) => Number(r.player.form) || 0 },
  { key: 'pts',   label: 'Total points',   of: (r) => r.player.pts || 0 },
  { key: 'price', label: 'Price',          of: (r) => r.player.price },
  { key: 'owned', label: 'Ownership',      of: (r) => r.player.owned || 0 },
  { key: 'ict',   label: 'ICT index',      of: (r) => Number(r.player.ict) || 0 },
  { key: 'fix',   label: 'Fixtures',       of: (r) => -fdrAhead(r.player, 3) },
];

/**
 * Narrow the market and rank it.
 *
 * Blocked rows never climb above legal ones however you sort — the list has to
 * stay a list of things you can actually do, with the rest underneath as an
 * explanation rather than an obstacle.
 */
export function finishMarket(rows, filter, limit) {
  const f = filter || {};
  let out = rows;
  if (f.pos && f.pos !== 'all') out = out.filter((r) => r.player.pos === f.pos);
  if (f.team) out = out.filter((r) => r.player.team === Number(f.team));
  if (f.maxPrice != null) out = out.filter((r) => r.player.price <= f.maxPrice + 1e-9);
  if (f.minPrice != null) out = out.filter((r) => r.player.price >= f.minPrice - 1e-9);
  if (f.avail === 'fit') out = out.filter((r) => r.player.status === 'a');
  else if (f.avail === 'flagged') out = out.filter((r) => r.player.status !== 'a');
  if (f.maxFdr != null) out = out.filter((r) => fdrAhead(r.player, 3) <= f.maxFdr + 1e-9);
  if (f.legalOnly) out = out.filter((r) => r.legal);

  const sort = MARKET_SORTS.find((s) => s.key === f.sort) || MARKET_SORTS[0];
  // Three bands: what you can do now, what you could do after freeing something
  // up, and what the rules will never allow. Within each, by the chosen column.
  const band = (r) => (r.legal ? 0 : r.fixable ? 1 : 2);
  out = out.slice().sort((a, b) => band(a) - band(b) || sort.of(b) - sort.of(a) ||
    b.gain - a.gain || a.player.name.localeCompare(b.player.name));
  return limit ? out.slice(0, limit) : out;
}

/**
 * The ranked shortlist: same position, affordable, available, not owned.
 * This is what the picker opens with — `replacementOptions` is what search uses.
 */
export function transferAlternatives(outPlayer, ctx, budget, squadIds = [], limit = 8) {
  return replacementOptions(outPlayer, ctx, budget, squadIds)
    .filter((r) => r.legal && r.player.status === 'a')
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

  const liveGw = live && live.gw != null ? live.gw : cur ? cur.id : null;
  const targetGw = next ? next.id : liveGw != null ? liveGw + 1 : null;

  const asOf = ctx.snapshot.generatedAt || null;
  const ageMin = asOf ? Math.max(0, Math.round((Date.now() - new Date(asOf).getTime()) / 60000)) : null;

  /* Three phases, not two.
   *
   *   upcoming  nothing in this round has kicked off. There are no scores to
   *             show, so cards carry fixtures.
   *   live      something has kicked off and the round is not complete.
   *   settled   every match is played, but the next deadline has not passed —
   *             which in FPL is most of the week. This phase used to be folded
   *             into "upcoming", so the moment the last match ended the
   *             gameweek points vanished from the squad. They are the first
   *             thing anyone wants to see after a round; they stay. */
  const phase = started === 0 || total === 0 ? 'upcoming'
    : live.allFinished ? 'settled' : 'live';
  // the round whose points the squad should display, null when there are none
  const scoresGw = phase === 'upcoming' ? null : liveGw;

  const deadlineText = next
    ? new Date(next.deadline).toLocaleString(undefined, {
        weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
      })
    : null;
  const base = { liveGw, targetGw, scoresGw, asOf, ageMin, started, inPlay, total,
    deadline: next ? next.deadline : null, deadlineText };

  if (phase === 'live') {
    return { ...base, phase,
      headline: `GW${liveGw} live`,
      detail: inPlay
        ? `${inPlay} of ${total} matches underway. Advice below is for GW${targetGw}.`
        : `${started} of ${total} matches played. Advice below is for GW${targetGw}.` };
  }
  if (phase === 'settled') {
    return { ...base, phase,
      // Said in words rather than as a status colour: "GW3 final" reads as a
      // label, "Gameweek 3 finished" reads as a fact, and this is the state
      // people check when they want to know whether their score is done moving.
      headline: `Gameweek ${liveGw} finished`,
      detail: `All ${total} matches played.` +
        (deadlineText ? ` GW${targetGw} deadline ${deadlineText}.` : '') +
        ` Advice below is for GW${targetGw}.` };
  }
  return { ...base, phase,
    headline: `GW${targetGw} upcoming`,
    detail: deadlineText
      ? `Deadline ${deadlineText}. Everything below applies to GW${targetGw}.`
      : `Everything below applies to GW${targetGw}.` };
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
 * plan = { name, weeks: [{ gw, transfers: [{ out: id, in: id }], chip, xi: [ids] }] }
 *
 * A transfer with `in: null` is an EMPTY SLOT: the player has been sold, the
 * money is in the bank, and the shirt is waiting. FPL itself has no such state
 * — a transfer there is atomic — but a wildcard is built by emptying several
 * slots and refilling them one at a time, so the intermediate state has to be
 * representable or the whole flow collapses back into one-for-one swaps. An
 * empty slot costs nothing and counts as no transfer until it is filled.
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

    const holes = [];
    moves.forEach((t) => {
      const outP = ctx.byId.get(t.out);
      if (!outP) { problems.push(`GW${gw}: unknown player in a transfer`); return; }
      if (!squad.includes(t.out)) { problems.push(`GW${gw}: ${outP.name} is not in the squad by then`); return; }
      if (t.in == null) {
        // Sold, not yet replaced. The shirt stays on the pitch as an empty slot
        // so you can see the hole you have to fill and the money you have to
        // fill it with.
        bank = round(bank + outP.price, 1);
        squad = squad.map((id) => (id === t.out ? null : id));
        holes.push({ out: t.out, pos: outP.pos, name: outP.name, price: outP.price });
        return;
      }
      const inP = ctx.byId.get(t.in);
      if (!inP) { problems.push(`GW${gw}: unknown player in a transfer`); return; }
      if (squad.includes(t.in)) { problems.push(`GW${gw}: ${inP.name} is already owned`); return; }
      if (inP.pos !== outP.pos) { problems.push(`GW${gw}: ${inP.name} is a ${inP.pos}, ${outP.name} a ${outP.pos}`); return; }
      bank = round(bank + outP.price - inP.price, 1);
      squad = squad.map((id) => (id === t.out ? t.in : id));
    });

    if (bank < -1e-9) problems.push(`GW${gw}: over budget by £${Math.abs(bank).toFixed(1)}m`);
    if (holes.length) {
      problems.push(`GW${gw}: ${holes.length} empty slot${holes.length === 1 ? '' : 's'} ` +
        `(${holes.map((h) => h.pos).join(', ')}) — the projection below counts ${15 - holes.length} players`);
    }
    const clubs = {};
    squad.forEach((id) => { const q = ctx.byId.get(id); if (q) clubs[q.team] = (clubs[q.team] || 0) + 1; });
    Object.entries(clubs).forEach(([tid, n]) => {
      if (n > MAX_PER_CLUB) {
        const t = ctx.teams.get(Number(tid));
        problems.push(`GW${gw}: ${n} from ${t ? t.name : 'one club'} (max ${MAX_PER_CLUB})`);
      }
    });

    // An empty slot is not a transfer yet. It costs nothing and spends nothing
    // until something goes into it.
    const used = moves.filter((t) => t.in != null).length;
    const freeNow = unlimited ? Infinity : banked;   // what THIS week had to spend
    const paid = unlimited ? 0 : Math.max(0, used - banked);
    const hit = paid * HIT_COST;
    // playing a chip preserves the free transfer rather than spending it
    if (!unlimited) banked = Math.min(5, banked - Math.min(used, banked) + freePerWeek);
    else banked = Math.min(5, banked + freePerWeek);

    const players = squad.map((id) => ctx.byId.get(id)).filter(Boolean);
    // A lineup the user arranged by hand outranks the optimiser — but only for
    // as long as it is still legal. `arrangeXI` repairs it around transfers
    // rather than silently throwing it away.
    const best = arrangeXI(players, idx, step && step.xi ? { xi: step.xi, bench: step.bench } : null);

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
      holes,
      xi: best ? best.xi.map((p) => p.id) : [],
      bench: best ? best.bench.map((p) => p.id) : [],
      manualXI: !!(best && best.manual),
      used, free: freeNow, unlimited,
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

/* ══════════════════════ the match schedule ══════════════════════ */

/**
 * Every Premier League match in one gameweek, keyed by calendar day in a
 * named time zone.
 *
 * Two sources, because they cover different rounds. `snapshot.live.fixtures`
 * is the only place the round in progress appears, and it is the only place
 * scores and minutes exist. The per-team `snapshot.fixtures` map covers the
 * horizon ahead and is the only place fixture difficulty exists. Neither
 * covers both, so this reads whichever applies and says nothing it cannot
 * support — a match with no difficulty renders neutral rather than guessed.
 *
 * The day key is produced with Intl in the target zone rather than by
 * slicing the ISO string, which would group by UTC date and put a Sunday
 * 02:00 Sydney kickoff on Saturday.
 */
export function matchSchedule(ctx, gw, tz = 'Australia/Sydney') {
  if (gw == null) return { gw: null, tz, days: [], count: 0 };
  const live = ctx.snapshot.live;
  const mine = new Set((ctx.squad || []).map((s) => s.player && s.player.team).filter(Boolean));

  // difficulty, when the horizon covers this round
  const diff = new Map();   // `${team}:${opp}` -> difficulty
  Object.entries(ctx.snapshot.fixtures || {}).forEach(([tid, list]) => {
    (list || []).forEach((f) => {
      if (f.gw === gw) diff.set(`${tid}:${f.opp}`, f.d);
    });
  });

  let raw = [];
  if (live && live.gw === gw && live.fixtures && live.fixtures.length) {
    raw = live.fixtures.map((f) => ({
      id: f.id, h: f.h, a: f.a, ko: f.kickoff,
      started: !!f.started, finished: !!f.finished,
      minutes: f.minutes || 0, hScore: f.hScore, aScore: f.aScore,
      dh: f.dh == null ? null : f.dh, da: f.da == null ? null : f.da,
    }));
  } else {
    // Each match appears twice in the per-team map. Take the home entry so
    // every match is emitted exactly once and h/a are unambiguous.
    const seen = new Set();
    Object.entries(ctx.snapshot.fixtures || {}).forEach(([tid, list]) => {
      (list || []).forEach((f) => {
        if (f.gw !== gw || !f.home) return;
        const h = Number(tid), a = f.opp, key = `${h}:${a}`;
        if (seen.has(key)) return;
        seen.add(key);
        raw.push({ id: key, h, a, ko: f.ko, started: false, finished: false,
          minutes: 0, hScore: null, aScore: null });
      });
    });
  }

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const matches = raw.map((m) => {
    const ht = ctx.teams.get(m.h) || null;
    const at = ctx.teams.get(m.a) || null;
    const when = m.ko ? new Date(m.ko) : null;
    return {
      ...m, home: ht, away: at,
      dayKey: when ? fmt.format(when) : 'tbc',
      // difficulty from whichever source has it: the live block carries it for
      // the round being played, the horizon map for the rounds ahead
      dh: m.dh != null ? m.dh : diff.has(`${m.h}:${m.a}`) ? diff.get(`${m.h}:${m.a}`) : null,
      da: m.da != null ? m.da : diff.has(`${m.a}:${m.h}`) ? diff.get(`${m.a}:${m.h}`) : null,
      inPlay: !!m.started && !m.finished,
      yours: mine.has(m.h) || mine.has(m.a),
      yourSide: mine.has(m.h) && mine.has(m.a) ? 'both' : mine.has(m.h) ? 'h' : mine.has(m.a) ? 'a' : null,
    };
  }).sort((x, y) => (x.ko || '').localeCompare(y.ko || '') || x.h - y.h);

  const days = [];
  matches.forEach((m) => {
    let d = days.find((q) => q.key === m.dayKey);
    if (!d) { d = { key: m.dayKey, iso: m.ko, matches: [] }; days.push(d); }
    d.matches.push(m);
  });
  return { gw, tz, days, count: matches.length,
    yours: matches.filter((m) => m.yours).length };
}

/* ══════════════════════ confirmed price changes ══════════════════════ */

/**
 * The price changes we have actually observed, newest first, grouped by the
 * day they landed on in a named time zone.
 *
 * This is deliberately separate from the price PREDICTIONS elsewhere on the
 * page. Those are an estimate built from net transfers; these are a record of
 * what happened. Mixing them would let a guess borrow the authority of a fact.
 *
 * Each row carries a WINDOW rather than an instant, because FPL never publishes
 * when a price moved — only what a player costs now. `after` is the refresh
 * that still showed the old price and `seen` the one that showed the new, so
 * the change happened somewhere between them. `exact` says whether that window
 * is tight enough to quote as a time (≤ 20 minutes) or should be read as a
 * range. Do not collapse the window to a single timestamp: it would be a
 * number the data cannot support.
 */
export function priceChanges(log, ctx, opts = {}) {
  const tz = opts.tz || 'Australia/Sydney';
  const rows = (log && Array.isArray(log.changes) ? log.changes : []).slice();
  if (!rows.length) return { tz, days: [], count: 0, mine: 0, rises: 0, falls: 0 };

  const mine = new Set((ctx && ctx.squad ? ctx.squad : []).map((s) => s.id));
  const dayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });

  const enriched = rows.map((c) => {
    const t = new Date(c.seen).getTime();
    const from = c.after ? new Date(c.after).getTime() : null;
    const spanMin = from == null ? null : Math.max(0, Math.round((t - from) / 60000));
    return {
      ...c,
      up: c.to > c.from,
      yours: mine.has(c.id),
      dayKey: Number.isFinite(t) ? dayKey.format(new Date(t)) : 'unknown',
      spanMin,
      // a window this tight reads as a time; anything wider is a range
      exact: spanMin != null && spanMin <= 20,
    };
  }).sort((a, b) => String(b.seen).localeCompare(String(a.seen)) || b.owned - a.owned);

  const days = [];
  for (const c of enriched) {
    let d = days.find((x) => x.key === c.dayKey);
    if (!d) { d = { key: c.dayKey, gw: c.gw, rows: [], rises: 0, falls: 0, mine: 0 }; days.push(d); }
    d.rows.push(c);
    if (c.up) d.rises++; else d.falls++;
    if (c.yours) d.mine++;
  }

  return {
    tz, days, count: enriched.length,
    mine: enriched.filter((c) => c.yours).length,
    rises: enriched.filter((c) => c.up).length,
    falls: enriched.filter((c) => !c.up).length,
    // how precisely we can date these at all, so the UI can say so once
    // rather than repeating a caveat on every row
    tightest: enriched.reduce((m, c) => (c.spanMin == null ? m : Math.min(m, c.spanMin)), Infinity),
    widest: enriched.reduce((m, c) => (c.spanMin == null ? m : Math.max(m, c.spanMin)), 0),
  };
}

/* ════════════════ has this player's match started? ════════════════ */

/**
 * Where one player sits in the round being played.
 *
 * A player whose club has not kicked off has NOT scored nil — he has not
 * played. Rendering both as "0" is the difference between "he blanked" and
 * "he is still to come", which is the single most misread number on a live
 * FPL page, and it changes what you do about it.
 *
 * Returns one of:
 *   'upcoming'  the round has no scores at all yet
 *   'notyet'    his club's match in this round has not kicked off
 *   'playing'   his club is on the pitch right now
 *   'played'    his club's match has finished
 * plus `kickoff` so the UI can say when, and `counts` for whether the points
 * figure means anything yet.
 */
export function playerMatchState(player, ctx, gwState) {
  const gw = gwState || gameweekState(ctx);
  const live = ctx.snapshot.live;
  if (gw.phase === 'upcoming' || !live || !live.fixtures || !live.fixtures.length) {
    return { state: 'upcoming', counts: false, kickoff: null, label: null, fixture: null };
  }

  const fixtures = live.fixtures.filter((f) => f.h === player.team || f.a === player.team);
  if (!fixtures.length) {
    // A blank gameweek for his club: no fixture at all, which is not the same
    // as not having started one.
    return { state: 'blank', counts: true, kickoff: null, label: 'No fixture', fixture: null };
  }

  // A double gameweek is "still to come" until the LAST match is done, and
  // "playing" if any is live.
  const anyLive = fixtures.some((f) => f.started && !f.finished);
  const allDone = fixtures.every((f) => f.finished);
  const noneStarted = fixtures.every((f) => !f.started);
  const next = fixtures.find((f) => !f.started) || fixtures[fixtures.length - 1];

  if (anyLive) {
    const f = fixtures.find((q) => q.started && !q.finished);
    return { state: 'playing', counts: true, kickoff: f.kickoff, label: 'Playing', fixture: f };
  }
  if (noneStarted) {
    return { state: 'notyet', counts: false, kickoff: next.kickoff, label: 'Yet to play', fixture: next };
  }
  if (allDone) {
    return { state: 'played', counts: true, kickoff: null, label: null, fixture: fixtures[fixtures.length - 1] };
  }
  // part of a double played, part still to come
  return { state: 'notyet', counts: true, kickoff: next.kickoff, label: 'One to come', fixture: next };
}

/* ═══════════════════════════ the news feed ═══════════════════════════ */

/** How long a flag typically keeps someone out, worst first. */
const NEWS_RANK = { u: 0, n: 1, i: 2, s: 3, d: 4, a: 5 };

/**
 * Everything FPL actually publishes as news, newest first.
 *
 * Scope note, deliberately narrow: FPL's API carries availability text and a
 * `news_added` timestamp, and nothing else. There are no transfers, no press
 * conferences and no rumours in it. Rather than pad this with a third party's
 * headlines, the feed reports what the game itself says — which is the part
 * that actually changes your team — and the UI says that is what it is.
 *
 * Availability items carry their own timestamp from FPL. Price and ownership
 * items are dated by our own detection, so they are marked `dated: 'observed'`
 * to keep the two kinds of certainty apart.
 */
export function newsFeed(ctx, opts = {}) {
  const limit = opts.limit || 60;
  const mine = new Set((ctx.squad || []).map((s) => s.id));
  const items = [];

  for (const p of ctx.players) {
    if (!p.news || !String(p.news).trim()) continue;
    const t = ctx.teams.get(p.team) || {};
    // "Knee injury - Expected back 21 Sep" → split the return date out, because
    // when he is back is the part that decides whether you sell or hold.
    const m = String(p.news).match(/^(.*?)\s*-\s*(Expected back.*)$/i);
    items.push({
      kind: 'availability',
      id: p.id, name: p.name, full: p.full, club: t.short || '', team: p.team, pos: p.pos,
      status: p.status,
      headline: m ? m[1].trim() : String(p.news).trim(),
      back: m ? m[2].trim() : null,
      chance: p.chance,
      at: p.newsAt || null,
      dated: 'fpl',
      owned: p.owned,
      price: p.price,
      yours: mine.has(p.id),
      severity: NEWS_RANK[p.status] == null ? 5 : NEWS_RANK[p.status],
    });
  }

  items.sort((a, b) => {
    // your own players first, then the worst news, then the newest
    if (a.yours !== b.yours) return a.yours ? -1 : 1;
    if (a.severity !== b.severity) return a.severity - b.severity;
    return String(b.at || '').localeCompare(String(a.at || '')) || b.owned - a.owned;
  });

  return {
    items: items.slice(0, limit),
    total: items.length,
    yours: items.filter((i) => i.yours).length,
    out: items.filter((i) => i.status === 'i' || i.status === 'u' || i.status === 'n').length,
    doubt: items.filter((i) => i.status === 'd').length,
    suspended: items.filter((i) => i.status === 's').length,
  };
}

/* ═══════════════════════ captaincy popularity ═══════════════════════ */

/**
 * Who the field is captaining, and who is worth going against them with.
 *
 * FPL does not publish captaincy. `captainShare` is inferred from ownership and
 * projected return, normalised across the pool — an estimate, and labelled as
 * one everywhere it appears. What it is good for is RELATIVE: whether a pick is
 * crowded or contrarian, not the exact percentage.
 *
 * A differential here is a player with a real chance of outscoring the popular
 * captain while very few managers have the armband on him, which is the only
 * kind of gamble that moves rank in your favour rather than sideways.
 */
export function captaincyBoard(ctx, opts = {}) {
  const limit = opts.limit || 10;
  const mine = new Set((ctx.squad || []).map((s) => s.id));

  const pool = ctx.players
    .filter((p) => p.avail > 0.1 && p.proj[0] > 0)
    .map((p) => ({
      player: p,
      share: p.captainShare || 0,
      proj: round(p.proj[0], 2),
      doubled: round(p.proj[0] * 2, 2),
      owned: p.owned,
      eo: p.eo,
      yours: mine.has(p.id),
    }))
    .sort((a, b) => b.share - a.share);

  const popular = pool.slice(0, limit);
  const top = popular[0] || null;

  // Worth going against the crowd with: nearly as good, far less owned as a
  // captain. The threshold is relative to the popular pick rather than absolute,
  // because "differential" only means anything next to what everyone else did.
  const differentials = pool
    .filter((c) => top && c.share < top.share * 0.18 && c.proj >= top.proj * 0.82)
    .sort((a, b) => b.proj - a.proj)
    .slice(0, limit)
    .map((c) => ({
      ...c,
      // what you gain on a manager who captained the popular pick, if both
      // score their projection
      edge: round(c.doubled - (top ? top.doubled : 0), 2),
      rarity: top && top.share > 0 ? round(c.share / top.share, 3) : null,
    }));

  return {
    popular, differentials, top,
    // the share of managers concentrated on the top three armbands
    concentration: round(pool.slice(0, 3).reduce((s, c) => s + c.share, 0), 1),
    estimated: true,
  };
}
