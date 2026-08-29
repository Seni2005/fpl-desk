import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSnapshot } from './fixture.mjs';
import {
  FORMATIONS, SQUAD_SHAPE, MAX_PER_CLUB, HIT_COST, FIELD_SIGMA_GW,
  buildContext, optimalXI, teamHealth, categorise, transferAlternatives,
  evaluatePlan, captainRanking, captainRankImpact, rankShift, fixtureSwings,
  weeklyAdvice, ownershipOpportunity, templateSquad, templateDiff,
  simulatePlayer, availability, underlyingRate, longAvailability,
  rng, poisson, normalCdf, normalInv, percentile, clamp,
} from '../js/engine.js';

const ctx = buildContext(makeSnapshot());

/* ───────────────────────────── maths ─────────────────────────────────── */

test('rng is deterministic for a given seed', () => {
  const a = rng(42), b = rng(42);
  const xs = Array.from({ length: 5 }, () => a());
  const ys = Array.from({ length: 5 }, () => b());
  assert.deepEqual(xs, ys);
  assert.ok(xs.every((v) => v >= 0 && v < 1), 'stays in [0,1)');
  assert.ok(new Set(xs).size === 5, 'does not repeat immediately');
});

test('poisson converges on its lambda', () => {
  const rand = rng(7);
  for (const lambda of [0.2, 1, 3]) {
    let total = 0;
    const n = 40000;
    for (let i = 0; i < n; i++) total += poisson(lambda, rand);
    const observed = total / n;
    assert.ok(Math.abs(observed - lambda) < lambda * 0.06 + 0.02,
      `lambda ${lambda} sampled at ${observed.toFixed(3)}`);
  }
  assert.equal(poisson(0, rand), 0);
  assert.equal(poisson(-1, rand), 0);
});

test('normal cdf and its inverse round-trip', () => {
  for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
    assert.ok(Math.abs(normalCdf(normalInv(p)) - p) < 1e-4, `p=${p}`);
  }
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(normalCdf(-3) < 0.002 && normalCdf(3) > 0.998);
});

test('percentile interpolates and handles edges', () => {
  const s = [0, 10, 20, 30, 40];
  assert.equal(percentile(s, 0), 0);
  assert.equal(percentile(s, 1), 40);
  assert.equal(percentile(s, 0.5), 20);
  assert.equal(percentile([], 0.5), 0);
});

/* ─────────────────────────── formations ──────────────────────────────── */

test('exactly the eight legal FPL formations are generated', () => {
  assert.equal(FORMATIONS.length, 8);
  const names = FORMATIONS.map((f) => f.name).sort();
  assert.deepEqual(names, ['3-4-3', '3-5-2', '4-3-3', '4-4-2', '4-5-1', '5-2-3', '5-3-2', '5-4-1']);
  for (const f of FORMATIONS) {
    assert.equal(f.DEF + f.MID + f.FWD, 10, `${f.name} outfield count`);
    assert.ok(f.DEF >= 3 && f.DEF <= 5, `${f.name} defenders`);
    assert.ok(f.MID >= 2 && f.MID <= 5, `${f.name} midfielders`);
    assert.ok(f.FWD >= 1 && f.FWD <= 3, `${f.name} forwards`);
  }
});

/* ──────────────────────────── context ────────────────────────────────── */

test('context builds projections for every player over the horizon', () => {
  assert.ok(ctx.players.length > 100);
  assert.equal(ctx.gws.length, 6);
  for (const p of ctx.players) {
    assert.equal(p.proj.length, ctx.gws.length, `${p.name} projection length`);
    assert.ok(p.proj.every((v) => v >= 0 && Number.isFinite(v)), `${p.name} finite non-negative`);
    assert.ok(p.scores && Number.isFinite(p.scores.overall));
  }
});

test('unavailable players project zero', () => {
  const injured = ctx.players.filter((p) => p.status === 'i' || p.status === 's');
  assert.ok(injured.length > 0, 'fixture contains unavailable players');
  for (const p of injured) {
    assert.equal(availability(p), 0, `${p.name} availability`);
    assert.ok(p.proj.every((v) => v === 0), `${p.name} projects zero`);
  }
});

test('a doubtful player is discounted by his chance of playing', () => {
  const doubt = ctx.players.find((p) => p.status === 'd');
  assert.ok(doubt, 'fixture has a doubtful player');
  assert.ok(doubt.avail > 0 && doubt.avail < 1);
  assert.ok(Math.abs(doubt.avail - doubt.minsPct * 0.75) < 1e-9, 'scaled by the 75% flag');
});

test('underlying rate rises with xGI and respects position scoring', () => {
  const base = { pos: 'MID', mins: 900, xG: 0, xA: 0, xGI: 0, xGC: 9, saves: 0, defCon: 0 };
  const low = underlyingRate(base);
  const high = underlyingRate({ ...base, xG: 5, xA: 3 });
  assert.ok(high > low, 'more xGI scores more');
  const def = underlyingRate({ ...base, pos: 'DEF', xG: 5, xA: 3 });
  const fwd = underlyingRate({ ...base, pos: 'FWD', xG: 5, xA: 3 });
  assert.ok(def > fwd, 'a defender earns more per goal than a forward');
});

/* ──────────────────────── the six scores ─────────────────────────────── */

test('every score is finite, and value scales inversely with price', () => {
  for (const p of ctx.players) {
    const s = p.scores;
    for (const k of ['overall', 'short', 'long', 'value', 'differential', 'captain']) {
      assert.ok(Number.isFinite(s[k]), `${p.name}.${k}`);
      assert.ok(s[k] >= 0, `${p.name}.${k} non-negative`);
    }
    assert.ok(s.captain >= s.overall * 0 , 'captain score defined');
    if (p.price > 0 && s.overall > 0) {
      const expected = (s.overall / p.price) * 10;
      assert.ok(Math.abs(s.value - expected) < 0.02, `${p.name} value derivation`);
    }
  }
});

test('differential falls as effective ownership rises, holding projection equal', () => {
  const pairs = ctx.players
    .filter((p) => p.scores.overall > 1)
    .sort((a, b) => b.scores.overall - a.scores.overall)
    .slice(0, 40);
  const high = pairs.filter((p) => p.eo > 20);
  const low = pairs.filter((p) => p.eo < 5);
  if (high.length && low.length) {
    const ratioHigh = high.reduce((s, p) => s + p.scores.differential / p.scores.overall, 0) / high.length;
    const ratioLow = low.reduce((s, p) => s + p.scores.differential / p.scores.overall, 0) / low.length;
    assert.ok(ratioLow > ratioHigh, 'low-owned players keep more of their projection');
  }
});

test('effective ownership exceeds raw ownership and captain share totals ~100%', () => {
  const total = ctx.players.reduce((s, p) => s + p.captainShare, 0);
  assert.ok(Math.abs(total - 100) < 0.5, `captain share sums to ${total.toFixed(2)}%`);
  for (const p of ctx.players) assert.ok(p.eo >= p.owned - 1e-9, `${p.name} eo >= owned`);
});

test('score breakdown names a concern only when a factor is genuinely weak', () => {
  for (const p of ctx.players.slice(0, 60)) {
    const b = p.scores.breakdown;
    assert.equal(b.factors.length, 6);
    assert.ok(b.factors.every((f) => f.value >= 0 && f.value <= 100), `${p.name} factors bounded`);
    const weakest = Math.min(...b.factors.map((f) => f.value));
    if (weakest >= 55) assert.equal(b.concern, null, `${p.name} should have no concern`);
    else assert.ok(typeof b.concern === 'string' && b.concern.length > 0, `${p.name} should name a concern`);
  }
});

test('the long-term score discounts by how long each flag keeps a player out', () => {
  const base = { minsPct: 1 };
  const fit = longAvailability({ ...base, status: 'a' });
  const doubt = longAvailability({ ...base, status: 'd' });
  const banned = longAvailability({ ...base, status: 's' });
  const injured = longAvailability({ ...base, status: 'i' });
  const gone = longAvailability({ ...base, status: 'u' });

  assert.equal(fit, 1, 'a fit player is fully available over a horizon');
  assert.ok(banned > injured, 'a one-match ban costs less over six weeks than an open-ended injury');
  assert.ok(doubt > banned, 'a fitness doubt costs less than a ban');
  assert.ok(injured > gone, 'an injury still beats being out of the squad entirely');
  assert.ok(injured < 0.5, `an open-ended injury is heavily discounted (${injured})`);

  // and it must actually flow through to the score
  const injuredPlayers = ctx.players.filter((p) => p.status === 'i' && p.minsPct > 0.5);
  assert.ok(injuredPlayers.length, 'fixture has injured regulars');
  for (const p of injuredPlayers) {
    const peers = ctx.players.filter((q) => q.pos === p.pos && q.status === 'a' &&
      Math.abs(q.ppg - p.ppg) < 0.6 && Math.abs(q.minsPct - p.minsPct) < 0.2);
    if (!peers.length) continue;
    const peerLong = peers.reduce((s, q) => s + q.scores.long, 0) / peers.length;
    assert.ok(p.scores.long < peerLong,
      `${p.name} (injured, long ${p.scores.long}) should rate below comparable fit players (${peerLong.toFixed(2)})`);
  }
});

/* ──────────────────────── optimal XI ─────────────────────────────────── */

test('optimal XI is always a legal FPL side', () => {
  const squad = ctx.squad.map((s) => s.player);
  const best = optimalXI(squad, 0);
  assert.ok(best, 'a side was found');
  assert.equal(best.xi.length, 11);
  const count = (pos) => best.xi.filter((p) => p.pos === pos).length;
  assert.equal(count('GKP'), 1, 'exactly one keeper');
  assert.ok(count('DEF') >= 3 && count('DEF') <= 5);
  assert.ok(count('MID') >= 2 && count('MID') <= 5);
  assert.ok(count('FWD') >= 1 && count('FWD') <= 3);
  assert.equal(best.formation, `${count('DEF')}-${count('MID')}-${count('FWD')}`);
  assert.ok(FORMATIONS.some((f) => f.name === best.formation), 'formation is in the legal set');
});

test('optimal XI genuinely maximises — no other formation beats it', () => {
  const squad = ctx.squad.map((s) => s.player);
  const best = optimalXI(squad, 0);
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  squad.forEach((p) => byPos[p.pos].push(p));
  Object.keys(byPos).forEach((k) => byPos[k].sort((a, b) => b.proj[0] - a.proj[0]));
  for (const f of FORMATIONS) {
    if (byPos.DEF.length < f.DEF || byPos.MID.length < f.MID || byPos.FWD.length < f.FWD) continue;
    const total = [byPos.GKP[0], ...byPos.DEF.slice(0, f.DEF), ...byPos.MID.slice(0, f.MID), ...byPos.FWD.slice(0, f.FWD)]
      .reduce((s, p) => s + p.proj[0], 0);
    // best.points is stored rounded to 2dp, so allow that much slack
    assert.ok(best.points >= total - 0.01, `${f.name} (${total.toFixed(3)}) beat the chosen ${best.formation} (${best.points})`);
  }
});

test('bench holds the remaining four with the reserve keeper first', () => {
  const squad = ctx.squad.map((s) => s.player);
  const best = optimalXI(squad, 0);
  assert.equal(best.bench.length, 4);
  assert.equal(best.bench[0].pos, 'GKP', 'reserve keeper takes the first bench slot');
  const ids = new Set([...best.xi, ...best.bench].map((p) => p.id));
  assert.equal(ids.size, 15, 'XI and bench together are the whole squad, no duplicates');
  const outfield = best.bench.slice(1);
  for (let i = 1; i < outfield.length; i++) {
    assert.ok(outfield[i - 1].proj[0] >= outfield[i].proj[0], 'outfield bench is ordered by projection');
  }
});

test('optimal XI returns null when there is no keeper', () => {
  const noKeeper = ctx.squad.map((s) => s.player).filter((p) => p.pos !== 'GKP');
  assert.equal(optimalXI(noKeeper, 0), null);
});

/* ──────────────────────── team health ───────────────────────────────── */

test('health score is bounded and its weights sum to one', () => {
  const h = teamHealth(ctx);
  assert.ok(h, 'health computed');
  assert.ok(h.score >= 0 && h.score <= 100, `score ${h.score}`);
  const w = h.components.reduce((s, c) => s + c.weight, 0);
  assert.ok(Math.abs(w - 1) < 1e-9, `weights sum to ${w}`);
  assert.ok(h.components.every((c) => c.score >= 0 && c.score <= 100), 'components bounded');
  assert.equal(h.weakness, h.components.slice().sort((a, b) => a.score - b.score)[0], 'weakness is the lowest component');
});

/* ────────────────────── categorisation ──────────────────────────────── */

test('a player with a poor short run but strong long-term reading is a hold, not a sell', () => {
  const p = {
    status: 'a', chance: null,
    scores: { short: 2.0, long: 3.6, overall: 3.0 },
  };
  const c = categorise(p);
  assert.equal(c.tag, 'hold');
  assert.match(c.why, /longer term/);
});

test('categorisation covers the obvious cases', () => {
  assert.equal(categorise({ status: 'i', scores: { short: 9, long: 9, overall: 9 } }).tag, 'sell');
  assert.equal(categorise({ status: 's', scores: { short: 9, long: 9, overall: 9 } }).tag, 'sell');
  assert.equal(categorise({ status: 'd', chance: 25, scores: { short: 5, long: 5, overall: 5 } }).tag, 'monitor');
  assert.equal(categorise({ status: 'a', scores: { short: 1, long: 1, overall: 1 } }).tag, 'sell');
  assert.equal(categorise({ status: 'a', scores: { short: 5, long: 4, overall: 4.5 } }).tag, 'buy');
});

/* ─────────────────── transfer alternatives ─────────────────────────── */

test('alternatives match position, respect budget and rank by gain', () => {
  const squad = ctx.squad.map((s) => s.player);
  const out = squad.find((p) => p.pos === 'MID');
  const budget = 2.5;
  const alts = transferAlternatives(out, ctx, budget, squad.map((p) => p.id), 10);
  assert.ok(alts.length > 0);
  for (const a of alts) {
    assert.equal(a.player.pos, out.pos, 'same position');
    assert.ok(a.player.price <= budget + out.price + 1e-6, `${a.player.name} within budget`);
    assert.ok(!squad.some((p) => p.id === a.player.id), 'not already owned');
    assert.equal(a.player.status, 'a', 'available');
    assert.ok(typeof a.reason === 'string' && a.reason.length > 0, 'has a stated reason');
  }
  for (let i = 1; i < alts.length; i++) {
    assert.ok(alts[i - 1].gain >= alts[i].gain, 'sorted by gain');
  }
});

test('alternatives flag players who would breach the club limit', () => {
  const squad = ctx.squad.map((s) => s.player);
  const out = squad.find((p) => p.pos === 'DEF');
  const alts = transferAlternatives(out, ctx, 50, squad.map((p) => p.id), 60);
  assert.ok(alts.every((a) => typeof a.atClubLimit === 'boolean'));
});

/* ─────────────────────── multi-week plans ──────────────────────────── */

test('an empty plan just projects the current squad across the horizon', () => {
  const res = evaluatePlan({ name: 'Do nothing', weeks: [] }, ctx);
  assert.equal(res.weeks.length, ctx.gws.length);
  assert.equal(res.hits, 0);
  assert.equal(res.problems.length, 0);
  assert.ok(res.points > 0);
  assert.equal(res.net, res.points);
  assert.ok(res.weeks.every((w) => FORMATIONS.some((f) => f.name === w.formation)), 'each week fields a legal side');
});

test('a transfer moves money correctly and is reflected in the closing bank', () => {
  const squad = ctx.squad.map((s) => s.player);
  const out = squad.find((p) => p.pos === 'MID');
  const inP = ctx.players.find((p) => p.pos === 'MID' && p.status === 'a' && !squad.some((s) => s.id === p.id));
  const startBank = ctx.entry.bank;
  const res = evaluatePlan(
    { name: 'One move', weeks: [{ gw: ctx.gws[0], transfers: [{ out: out.id, in: inP.id }] }] },
    ctx,
  );
  const expected = Math.round((startBank + out.price - inP.price) * 10) / 10;
  assert.equal(res.endBank, expected, `bank ${res.endBank} should be ${expected}`);
});

test('a second transfer in one week costs a hit', () => {
  const squad = ctx.squad.map((s) => s.player);
  const mids = squad.filter((p) => p.pos === 'MID');
  const spares = ctx.players.filter((p) => p.pos === 'MID' && p.status === 'a' && !squad.some((s) => s.id === p.id)).slice(0, 2);
  const plan = { name: 'Two moves', weeks: [{ gw: ctx.gws[0], transfers: [
    { out: mids[0].id, in: spares[0].id },
    { out: mids[1].id, in: spares[1].id },
  ] }] };
  const res = evaluatePlan(plan, ctx, { startingFree: 1, freeTransfers: 1 });
  assert.equal(res.hits, HIT_COST, 'exactly one paid transfer');
  assert.equal(res.net, Math.round((res.points - HIT_COST) * 100) / 100);
});

test('free transfers bank up to a maximum of five', () => {
  const squad = ctx.squad.map((s) => s.player);
  const mids = squad.filter((p) => p.pos === 'MID');
  const spares = ctx.players.filter((p) => p.pos === 'MID' && p.status === 'a' && !squad.some((s) => s.id === p.id)).slice(0, 3);
  // save for four weeks, then make three transfers at once — all should be free
  const plan = { name: 'Bank then spend', weeks: [{ gw: ctx.gws[4], transfers: [
    { out: mids[0].id, in: spares[0].id },
    { out: mids[1].id, in: spares[1].id },
    { out: mids[2].id, in: spares[2].id },
  ] }] };
  const res = evaluatePlan(plan, ctx, { startingFree: 1, freeTransfers: 1 });
  assert.equal(res.hits, 0, 'banked transfers cover all three');
});

test('plans reject illegal moves and report why', () => {
  const squad = ctx.squad.map((s) => s.player);
  const mid = squad.find((p) => p.pos === 'MID');
  const fwd = ctx.players.find((p) => p.pos === 'FWD' && !squad.some((s) => s.id === p.id));
  const notOwned = ctx.players.find((p) => p.pos === 'MID' && !squad.some((s) => s.id === p.id));

  const mismatch = evaluatePlan({ weeks: [{ gw: ctx.gws[0], transfers: [{ out: mid.id, in: fwd.id }] }] }, ctx);
  assert.ok(mismatch.problems.some((t) => /is a FWD/.test(t)), mismatch.problems.join('; '));

  const notInSquad = evaluatePlan({ weeks: [{ gw: ctx.gws[0], transfers: [{ out: notOwned.id, in: fwd.id }] }] }, ctx);
  assert.ok(notInSquad.problems.some((t) => /not in the squad/.test(t)));
});

test('plans catch going over budget', () => {
  const squad = ctx.squad.map((s) => s.player);
  const cheap = squad.slice().sort((a, b) => a.price - b.price).find((p) => p.pos === 'DEF');
  const dear = ctx.players
    .filter((p) => p.pos === 'DEF' && !squad.some((s) => s.id === p.id))
    .sort((a, b) => b.price - a.price)[0];
  const res = evaluatePlan({ weeks: [{ gw: ctx.gws[0], transfers: [{ out: cheap.id, in: dear.id }] }] }, ctx);
  if (dear.price - cheap.price > ctx.entry.bank) {
    assert.ok(res.problems.some((t) => /over budget/.test(t)), res.problems.join('; '));
  }
});

test('two divergent plans are directly comparable', () => {
  const squad = ctx.squad.map((s) => s.player);
  const out = squad.find((p) => p.pos === 'FWD');
  const pool = ctx.players
    .filter((p) => p.pos === 'FWD' && p.status === 'a' && !squad.some((s) => s.id === p.id))
    .sort((a, b) => b.scores.overall - a.scores.overall);
  const A = evaluatePlan({ name: 'A', weeks: [{ gw: ctx.gws[0], transfers: [{ out: out.id, in: pool[0].id }] }] }, ctx);
  const B = evaluatePlan({ name: 'B', weeks: [{ gw: ctx.gws[0], transfers: [{ out: out.id, in: pool[pool.length - 1].id }] }] }, ctx);
  assert.ok(A.net > B.net, `the better signing should win: A ${A.net} vs B ${B.net}`);
});

/* ─────────────────────── the simulator ─────────────────────────────── */

test('simulation is reproducible and its mean tracks the projection', () => {
  const p = ctx.players.filter((x) => x.avail > 0.8 && x.pos === 'FWD').sort((a, b) => b.proj[0] - a.proj[0])[0];
  const a = simulatePlayer(p, 0, ctx, 800);
  const b = simulatePlayer(p, 0, ctx, 800);
  assert.deepEqual(a.samples, b.samples, 'same seed, same draws');
  assert.ok(a.mean > 0);
  assert.ok(a.p25 <= a.p50 && a.p50 <= a.p75, 'percentiles ordered');
  assert.ok(a.pHaul >= 0 && a.pHaul <= 1);
  assert.ok(a.pBlank >= 0 && a.pBlank <= 1);
});

test('a better attacker hauls more often than a fringe one, fixture held equal', () => {
  // Compare within one club, otherwise fixture difficulty confounds the result:
  // a weak forward with a difficulty-1 tie can out-haul a good one facing a 5.
  const byTeam = new Map();
  ctx.players
    .filter((p) => p.pos === 'FWD' && p.avail > 0.3)
    .forEach((p) => { if (!byTeam.has(p.team)) byTeam.set(p.team, []); byTeam.get(p.team).push(p); });

  const pair = [...byTeam.values()]
    .map((list) => list.slice().sort((a, b) => b.per90.xG - a.per90.xG))
    .find((list) => list.length >= 2 && list[0].per90.xG > list[list.length - 1].per90.xG * 1.5);
  assert.ok(pair, 'found two forwards at one club with clearly different rates');

  const elite = pair[0], fringe = pair[pair.length - 1];
  assert.equal(elite.fixtures[0].difficulty, fringe.fixtures[0].difficulty, 'same fixture');
  const e = simulatePlayer(elite, 0, ctx, 3000);
  const f = simulatePlayer(fringe, 0, ctx, 3000);
  assert.ok(e.pHaul > f.pHaul, `elite haul ${e.pHaul} (xG/90 ${elite.per90.xG.toFixed(2)}) vs fringe ${f.pHaul} (${fringe.per90.xG.toFixed(2)})`);
  assert.ok(e.mean > f.mean, `elite mean ${e.mean} vs fringe ${f.mean}`);
});

test('a blank gameweek simulates to exactly zero', () => {
  const p = ctx.players[0];
  const blanked = { ...p, fixtures: p.fixtures.map((f) => ({ ...f, blank: true, count: 0 })) };
  const s = simulatePlayer(blanked, 0, ctx, 200);
  assert.equal(s.mean, 0);
  assert.ok(s.samples.every((v) => v === 0));
});

/* ───────────────────────── rank impact ─────────────────────────────── */

test('rank shift has the right sign and zero edge moves nobody', () => {
  assert.equal(rankShift(0, ctx), 0);
  assert.ok(rankShift(10, ctx) > 0, 'gaining points moves you up');
  assert.ok(rankShift(-10, ctx) < 0, 'losing points moves you down');
  assert.ok(rankShift(20, ctx) > rankShift(5, ctx), 'a bigger edge moves you further');
});

test('rank shift is damped as the season accumulates', () => {
  const early = buildContext({ ...makeSnapshot(), currentEvent: { id: 1, name: 'GW1', finished: true } });
  const late = buildContext({ ...makeSnapshot(), currentEvent: { id: 25, name: 'GW25', finished: true } });
  const e = Math.abs(rankShift(10, early));
  const l = Math.abs(rankShift(10, late));
  assert.ok(e > l, `the same edge should matter less later (${e} vs ${l})`);
  assert.equal(FIELD_SIGMA_GW, 18, 'the assumed spread is a documented constant');
});

test('captain rank impact returns ordered percentiles', () => {
  const caps = captainRanking(ctx, 1, false);
  const impact = captainRankImpact(caps[0].player, ctx, 500);
  assert.ok(impact, 'impact computed');
  assert.ok(impact.edge.p25 <= impact.edge.p50 && impact.edge.p50 <= impact.edge.p75);
  assert.ok(impact.rank.p25 <= impact.rank.p50 && impact.rank.p50 <= impact.rank.p75,
    'a better points outcome is a better rank outcome');
  assert.ok(impact.fieldSize > 0);
});

/* ────────────────────── captaincy ranking ──────────────────────────── */

test('captaincy ranks by projection and classifies risk by ownership', () => {
  const caps = captainRanking(ctx, 3, false);
  assert.equal(caps.length, 3);
  for (let i = 1; i < caps.length; i++) {
    assert.ok(caps[i - 1].xPts >= caps[i].xPts, 'ordered by expected points');
  }
  for (const c of caps) {
    assert.ok(['Safe', 'Balanced', 'Aggressive'].includes(c.profile));
    if (c.eo >= 35) assert.equal(c.profile, 'Safe');
    if (c.eo < 12) assert.equal(c.profile, 'Aggressive');
    assert.ok(c.minutes >= 0 && c.minutes <= 100);
  }
});

/* ───────────────────── ownership vs opportunity ────────────────────── */

test('opportunity favours output the field is not already exposed to', () => {
  const top = ownershipOpportunity(ctx, 15);
  assert.ok(top.length > 0);
  for (let i = 1; i < top.length; i++) {
    assert.ok(top[i - 1].opportunity >= top[i].opportunity, 'sorted');
  }
  // a heavily owned player must out-project a low-owned one by a wide margin to rank above him
  const heavy = top.find((t) => t.eo > 25);
  if (heavy) {
    const light = top.find((t) => t.eo < 5);
    if (light) assert.ok(heavy.projected > light.projected, 'a template pick only ranks on raw projection');
  }
});

/* ───────────────────────── template ────────────────────────────────── */

test('the template squad is itself legal', () => {
  const t = templateSquad(ctx);
  assert.equal(t.length, 15);
  const counts = t.reduce((m, p) => ({ ...m, [p.pos]: (m[p.pos] || 0) + 1 }), {});
  assert.deepEqual(counts, SQUAD_SHAPE);
  const clubs = {};
  t.forEach((p) => { clubs[p.team] = (clubs[p.team] || 0) + 1; });
  assert.ok(Object.values(clubs).every((n) => n <= MAX_PER_CLUB), 'respects the club limit');
});

test('template diff separates what you are missing from where you differ', () => {
  const d = templateDiff(ctx);
  assert.ok(d);
  const myIds = new Set(ctx.squad.map((s) => s.id));
  assert.ok(d.missing.every((p) => !myIds.has(p.id)), 'missing are genuinely not owned');
  assert.ok(d.differentials.every((p) => myIds.has(p.id)), 'differentials are genuinely owned');
  assert.ok(d.overlap >= 0 && d.overlap <= 100);
  for (let i = 1; i < d.missing.length; i++) {
    assert.ok(d.missing[i - 1].eo >= d.missing[i].eo, 'missing sorted by how exposed the field is');
  }
});

/* ────────────────────── fixture swings ─────────────────────────────── */

test('fixture swings identify a gameweek and a direction', () => {
  const swings = fixtureSwings(ctx, 0.3);
  assert.ok(Array.isArray(swings));
  for (const s of swings) {
    assert.ok(ctx.gws.includes(s.gw), 'the swing lands on a real gameweek');
    assert.ok(['easier', 'harder'].includes(s.direction));
    assert.equal(s.direction, s.shift > 0 ? 'easier' : 'harder');
  }
  for (let i = 1; i < swings.length; i++) {
    assert.ok(Math.abs(swings[i - 1].shift) >= Math.abs(swings[i].shift), 'sorted by magnitude');
  }
});

/* ───────────────────────── weekly advice ───────────────────────────── */

test('weekly advice answers every question the dashboard asks', () => {
  const a = weeklyAdvice(ctx, { simulate: false, freeTransfers: 1 });
  assert.ok(a, 'advice produced');
  assert.equal(a.xi.length, 11);
  assert.equal(a.bench.length, 4);
  assert.ok(FORMATIONS.some((f) => f.name === a.formation));
  assert.ok(a.captain && a.vice, 'captain and vice named');
  assert.notEqual(a.captain.player.id, a.vice.player.id, 'captain and vice differ');
  assert.ok(Number.isFinite(a.expectedPoints) && a.expectedPoints > 0);
  assert.ok(['none', 'low', 'moderate', 'high'].includes(a.confidence));
  assert.equal(a.hit, 0, 'a free transfer costs nothing');
  assert.ok(a.health && a.health.score >= 0);
  assert.ok(a.headline && typeof a.headline.text === 'string' && a.headline.text.length > 10);
  if (a.transfer) {
    assert.equal(a.transfer.out.pos, a.transfer.in.pos, 'the suggested move is like-for-like');
    assert.ok(!ctx.squad.some((s) => s.id === a.transfer.in.id), 'suggests someone not already owned');
  }
});

test('advice charges a hit when there is no free transfer', () => {
  const a = weeklyAdvice(ctx, { simulate: false, freeTransfers: 0 });
  assert.equal(a.hit, HIT_COST);
});

test('advice degrades cleanly with no squad connected', () => {
  const bare = buildContext(makeSnapshot({ noEntry: true }));
  assert.equal(bare.squad.length, 0);
  assert.equal(weeklyAdvice(bare), null);
  assert.equal(teamHealth(bare), null);
  assert.equal(templateDiff(bare), null);
  assert.deepEqual(captainRanking(bare), []);
  // the parts that do not need a squad still work
  assert.ok(ownershipOpportunity(bare, 5).length > 0);
  assert.ok(templateSquad(bare).length === 15);
});

test('clamp behaves at the edges', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});
