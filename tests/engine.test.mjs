import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSnapshot } from './fixture.mjs';
import {
  FORMATIONS, SQUAD_SHAPE, MAX_PER_CLUB, HIT_COST, FIELD_SIGMA_GW,
  buildContext, optimalXI, teamHealth, categorise, transferAlternatives, replacementOptions,
  evaluatePlan, captainRanking, captainRankImpact, rankShift, fixtureSwings,
  weeklyAdvice, ownershipOpportunity, templateSquad, templateDiff,
  simulatePlayer, availability, underlyingRate, longAvailability,
  gameweekState, playerTraits, CHIPS, selectEntry, priceChanges,
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

/* ─────────────────────── gameweek lifecycle ────────────────────────── */

test('lifecycle reports live while matches are on, and scopes advice to the next gameweek', () => {
  const liveCtx = buildContext(makeSnapshot({ live: 'inplay' }));
  const st = gameweekState(liveCtx);
  assert.equal(st.phase, 'live');
  assert.equal(st.liveGw, 1);
  assert.equal(st.targetGw, 2, 'advice targets the gameweek you can still change');
  assert.ok(st.inPlay > 0 && st.inPlay <= st.total);
  assert.match(st.detail, /GW2/, 'the detail names the gameweek the advice applies to');
  assert.ok(Number.isFinite(st.ageMin), 'staleness is reported so the UI can be honest about it');
});

test('a finished round is settled, not upcoming, and keeps its scores', () => {
  const st = gameweekState(ctx);
  assert.equal(st.phase, 'settled', 'played matches are not "upcoming"');
  assert.equal(st.targetGw, 2, 'advice still targets the week you can change');
  assert.equal(st.scoresGw, 1, 'the squad keeps showing GW1 points until the GW2 deadline');
  assert.match(st.detail, /All 10 matches played/);
  assert.match(st.detail, /deadline/i, 'the next deadline is still named');
});

test('lifecycle is upcoming before anything kicks off, and offers no scores', () => {
  const st = gameweekState(buildContext(makeSnapshot({ live: 'none' })));
  assert.equal(st.phase, 'upcoming', 'nothing started is not live');
  assert.equal(st.scoresGw, null, 'there are no points to show, so the UI must fall back to fixtures');
  assert.match(st.detail, /Deadline/);
});

test('the three phases are exhaustive and ordered by what has been played', () => {
  const phases = ['none', 'inplay', 'finished'].map(
    (live) => gameweekState(buildContext(makeSnapshot({ live }))).phase);
  assert.deepEqual(phases, ['upcoming', 'live', 'settled']);
});

/* ─────────────────────────── fan traits ────────────────────────────── */

test('every trait carries the number behind it', () => {
  let seen = 0;
  for (const p of ctx.players) {
    for (const t of p.traits) {
      assert.ok(t.icon && t.label, 'trait is labelled');
      assert.ok(typeof t.raw === 'string' && t.raw.length > 0, `${p.name}/${t.key} must show its raw figure`);
      assert.ok(['good', 'warn', 'bad', 'info'].includes(t.tone), `${t.key} tone`);
      seen++;
    }
    assert.ok(p.traits.length <= 4, 'traits stay to a readable handful');
  }
  assert.ok(seen > 100, `traits are actually generated (${seen})`);
});

test('availability trouble outranks everything else in the badge order', () => {
  const flagged = ctx.players.filter((p) => p.status !== 'a' && p.traits.length);
  assert.ok(flagged.length, 'fixture has flagged players');
  for (const p of flagged) {
    assert.ok(['out', 'ban', 'doubt'].includes(p.traits[0].key),
      `${p.name} leads with ${p.traits[0].key}, should lead with its flag`);
  }
});

test('a high xG forward is badged as a goal threat with the figure attached', () => {
  const hot = ctx.players.find((p) => p.pos === 'FWD' && p.status === 'a' && p.per90.xG >= 0.45);
  if (hot) {
    const t = hot.traits.find((x) => x.key === 'threat');
    assert.ok(t, `${hot.name} should be badged`);
    assert.match(t.raw, /xG\/90/);
  }
});

/* ──────────────────────────── chips ────────────────────────────────── */

test('bench boost scores all fifteen instead of eleven', () => {
  const gw = ctx.gws[0];
  const plain = evaluatePlan({ weeks: [] }, ctx);
  const boosted = evaluatePlan({ weeks: [{ gw, transfers: [], chip: 'bboost' }] }, ctx);
  const w0 = plain.weeks[0], b0 = boosted.weeks[0];
  assert.equal(b0.benchCounted, true);
  assert.ok(b0.points > w0.points, `bench boost should add points (${b0.points} vs ${w0.points})`);

  const squad = ctx.squad.map((s) => s.player);
  const all15 = squad.reduce((s, p) => s + (p.proj[0] || 0), 0);
  const best = optimalXI(squad, 0);
  const capBonus = best.captain.proj[0];
  assert.ok(Math.abs(b0.points - (all15 + capBonus)) < 0.02,
    `bench boost total should be all fifteen plus the captain bonus (${b0.points} vs ${(all15 + capBonus).toFixed(2)})`);
});

test('triple captain adds exactly one more copy of the captain', () => {
  const gw = ctx.gws[0];
  const plain = evaluatePlan({ weeks: [] }, ctx).weeks[0];
  const tc = evaluatePlan({ weeks: [{ gw, transfers: [], chip: '3xc' }] }, ctx).weeks[0];
  assert.equal(tc.captainMultiplier, 3);
  assert.equal(plain.captainMultiplier, 2);
  const squad = ctx.squad.map((s) => s.player);
  const cap = optimalXI(squad, 0).captain.proj[0];
  assert.ok(Math.abs((tc.points - plain.points) - cap) < 0.02,
    `the gap should equal one captain projection (${(tc.points - plain.points).toFixed(2)} vs ${cap.toFixed(2)})`);
});

test('wildcard makes a week of transfers free', () => {
  const gw = ctx.gws[0];
  const squad = ctx.squad.map((s) => s.player);
  const mids = squad.filter((p) => p.pos === 'MID').slice(0, 3);
  const spares = ctx.players.filter((p) => p.pos === 'MID' && p.status === 'a' && !squad.some((s) => s.id === p.id)).slice(0, 3);
  const transfers = mids.map((m, i) => ({ out: m.id, in: spares[i].id }));

  const paid = evaluatePlan({ weeks: [{ gw, transfers }] }, ctx, { startingFree: 1, freeTransfers: 1 });
  const wc = evaluatePlan({ weeks: [{ gw, transfers, chip: 'wildcard' }] }, ctx, { startingFree: 1, freeTransfers: 1 });
  assert.equal(paid.hits, 2 * HIT_COST, 'without the chip, two of three transfers are paid');
  assert.equal(wc.hits, 0, 'the wildcard covers all of them');
  assert.deepEqual(wc.weeks[0].squad.sort(), paid.weeks[0].squad.sort(), 'a wildcard keeps the new squad');
});

test('free hit reverts the squad the following week', () => {
  const gw = ctx.gws[0];
  const squad = ctx.squad.map((s) => s.player);
  const mids = squad.filter((p) => p.pos === 'MID').slice(0, 3);
  const spares = ctx.players.filter((p) => p.pos === 'MID' && p.status === 'a' && !squad.some((s) => s.id === p.id)).slice(0, 3);
  const transfers = mids.map((m, i) => ({ out: m.id, in: spares[i].id }));

  const fh = evaluatePlan({ weeks: [{ gw, transfers, chip: 'freehit' }] }, ctx, { startingFree: 1, freeTransfers: 1 });
  assert.equal(fh.hits, 0, 'a free hit costs no points');
  const wk0 = fh.weeks[0], wk1 = fh.weeks[1];
  assert.ok(spares.every((s) => wk0.squad.includes(s.id)), 'the rented players play that week');
  assert.ok(spares.every((s) => !wk1.squad.includes(s.id)), 'and are gone the next');
  assert.ok(mids.every((m) => wk1.squad.includes(m.id)), 'the original squad comes back');
  assert.equal(fh.endBank, ctx.entry.bank, 'the bank is restored too');
});

test('a plan cannot spend the same chip twice', () => {
  const res = evaluatePlan({ weeks: [
    { gw: ctx.gws[0], transfers: [], chip: 'bboost' },
    { gw: ctx.gws[2], transfers: [], chip: 'bboost' },
  ] }, ctx);
  assert.ok(res.problems.some((t) => /Bench Boost is played 2 times/.test(t)), res.problems.join('; '));
});

test('an unknown chip is rejected rather than silently ignored', () => {
  const res = evaluatePlan({ weeks: [{ gw: ctx.gws[0], transfers: [], chip: 'nonsense' }] }, ctx);
  assert.ok(res.problems.some((t) => /unknown chip/.test(t)));
  assert.equal(res.weeks[0].chip, null, 'and it does not take effect');
});

test('every chip is described for the interface', () => {
  for (const key of ['wildcard', 'freehit', '3xc', 'bboost']) {
    const c = CHIPS[key];
    assert.ok(c && c.name && c.icon && c.blurb, `${key} needs a name, icon and explanation`);
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

/* ───────────────────── multiple managers, one page ─────────────────── */

test('a snapshot with several managers exposes all of them', () => {
  const c = buildContext(makeSnapshot());
  assert.equal(c.entries.length, 2, 'both configured managers are available');
  assert.equal(c.entry.id, 1234567, 'the first is attached by default');
  assert.equal(c.squad.length, 15);
});

test('selectEntry swaps the squad without touching the analysis', () => {
  const c = buildContext(makeSnapshot());
  // capture something expensive that must NOT change when the manager does
  const before = c.players.map((p) => p.scores.overall);
  const first = c.squad.map((s) => s.id);

  const other = selectEntry(c, '7654321');
  assert.equal(other.id, 7654321, 'switched by key');
  assert.equal(c.squad.length, 15, 'the new manager has a full squad');
  assert.notDeepEqual(c.squad.map((s) => s.id), first, 'and it is a different fifteen');

  const after = c.players.map((p) => p.scores.overall);
  assert.deepEqual(after, before,
    'projections and scores are properties of the player pool, not of whose team it is');
});

test('selectEntry matches on raw id as well as key', () => {
  const c = buildContext(makeSnapshot());
  assert.equal(selectEntry(c, 7654321).id, 7654321, 'a number works');
  assert.equal(selectEntry(c, '1234567').id, 1234567, 'a string works');
});

test('an unknown team leaves no squad rather than falling back to someone else', () => {
  const c = buildContext(makeSnapshot());
  // Silently showing the first manager's team would be the dangerous bug here:
  // on a shared link you would be reading someone else's squad as your own.
  assert.equal(selectEntry(c, '9999999'), null);
  assert.equal(c.squad.length, 0);
});

test('false means "no team", and every other section still has what it needs', () => {
  const c = buildContext(makeSnapshot(), {}, false);
  assert.equal(c.entry, null);
  assert.equal(c.squad.length, 0);
  assert.ok(c.players.length > 100, 'the player pool is untouched');
  assert.ok(c.players[0].scores.overall >= 0, 'and still scored');
});

test('a manager whose fetch failed is offered but never selected', () => {
  const snap = makeSnapshot();
  snap.entries = [{ id: 55, key: '55', label: 'Broken', error: 'HTTP 404' }, snap.entries[1]];
  const c = buildContext(snap);
  assert.equal(c.entries.length, 2, 'the failure is still listed, so the UI can say so');
  assert.equal(selectEntry(c, '55'), null, 'but selecting it yields no squad');
  assert.equal(c.squad.length, 0);
  assert.equal(selectEntry(c, '7654321').id, 7654321, 'and the working one is unaffected');
});

test('an older single-entry snapshot still works', () => {
  const snap = makeSnapshot();
  delete snap.entries;                       // as written before multi-team
  const c = buildContext(snap);
  assert.equal(c.entries.length, 1);
  assert.equal(c.entry.id, 1234567);
  assert.equal(c.squad.length, 15);
});

/* ─────────────── searching for any replacement, not just the shortlist ─────────────── */

test('the shortlist is what you can actually make', () => {
  const out = ctx.squad[3].player;
  const alts = transferAlternatives(out, ctx, 2.0, ctx.squad.map((s) => s.id), 8);
  assert.ok(alts.length > 0);
  for (const a of alts) {
    assert.equal(a.player.pos, out.pos, 'like for like');
    assert.equal(a.legal, true, 'every shortlisted option is legal');
    assert.equal(a.player.status, 'a', 'and available');
  }
  const gains = alts.map((a) => a.gain);
  assert.deepEqual(gains, gains.slice().sort((x, y) => y - x), 'ranked by gain');
});

test('search reaches players the shortlist would never offer', () => {
  const out = ctx.squad[3].player;
  const ids = ctx.squad.map((s) => s.id);
  const short = transferAlternatives(out, ctx, 0.5, ids, 12).map((a) => a.player.id);
  const all = replacementOptions(out, ctx, 0.5, ids, { query: out.pos });
  assert.ok(all.length > short.length,
    `search sees ${all.length} where the shortlist offers ${short.length}`);
  assert.ok(all.some((r) => !short.includes(r.player.id)),
    'including players outside the shortlist entirely');
});

test('nothing is silently dropped — every exclusion carries its reason', () => {
  const out = ctx.squad.find((s) => s.player.pos === 'MID').player;
  const ids = ctx.squad.map((s) => s.id);
  // a tiny budget so the budget block definitely fires
  const rows = replacementOptions(out, ctx, 0, ids, { query: '' });
  for (const r of rows) {
    if (r.legal) assert.equal(r.blocked, null);
    else assert.ok(r.blockedText && r.blockedText.length > 3, 'a blocked row explains itself');
  }
  const kinds = new Set(rows.filter((r) => !r.legal).map((r) => r.blocked));
  assert.ok(kinds.has('budget'), 'an unaffordable player is shown as unaffordable, not hidden');
});

test('a player you already own is offered back with that reason, not omitted', () => {
  const out = ctx.squad.find((s) => s.player.pos === 'MID').player;
  const ids = ctx.squad.map((s) => s.id);
  const mate = ctx.squad.find((s) => s.player.pos === 'MID' && s.id !== out.id).player;
  const rows = replacementOptions(out, ctx, 99, ids, { query: mate.name.toLowerCase() });
  const hit = rows.find((r) => r.player.id === mate.id);
  assert.ok(hit, 'a squad-mate is findable by name');
  assert.equal(hit.blocked, 'owned');
  assert.equal(hit.legal, false);
});

test('the wrong position is a block, not an omission', () => {
  const out = ctx.squad.find((s) => s.player.pos === 'DEF').player;
  const rows = replacementOptions(out, ctx, 99, ctx.squad.map((s) => s.id), { query: 'fwd' });
  assert.ok(rows.length > 0, 'searching another position still returns players');
  const wrong = rows.filter((r) => r.player.pos !== out.pos);
  assert.ok(wrong.length > 0);
  for (const r of wrong) {
    assert.equal(r.blocked, 'position');
    // the chip stays short enough not to wrap; the sentence lives in the tooltip
    assert.ok(r.blockedText.length <= 18, `chip is short: "${r.blockedText}"`);
    assert.match(r.blockedText, new RegExp(`^${r.player.pos}`));
    assert.match(r.blockedWhy, /like-for-like/);
    assert.equal(r.fixable, false, 'nothing you can do clears a position mismatch');
  }
});

test('position outranks budget when both would block', () => {
  // A striker cannot replace a defender however much money you have, so the
  // reason shown must be the one you cannot solve by selling someone.
  const out = ctx.squad.find((s) => s.player.pos === 'DEF').player;
  const rows = replacementOptions(out, ctx, 0, ctx.squad.map((s) => s.id), { query: 'fwd' });
  const wrong = rows.filter((r) => r.player.pos !== out.pos);
  assert.ok(wrong.length > 0);
  assert.ok(wrong.every((r) => r.blocked === 'position'), 'never reported as merely unaffordable');
});

test('results band by what you can act on', () => {
  // buyable now, then blocked-but-solvable (money, club limit), then never.
  const out = ctx.squad.find((s) => s.player.pos === 'MID').player;
  const rows = replacementOptions(out, ctx, 3, ctx.squad.map((s) => s.id), { query: 'e' });
  const band = (r) => (r.legal ? 0 : r.fixable ? 1 : 2);
  const bands = rows.map(band);
  assert.deepEqual(bands, bands.slice().sort((a, b) => a - b),
    'bands never interleave');
  assert.ok(bands.includes(0) && bands.includes(2),
    'the search spans both what you can buy and what the rules forbid');
});

/* ─────────────────── the three-per-club rule ─────────────────── */

/**
 * A squad holding exactly `n` players from one club, all defenders, padded out
 * with midfielders from elsewhere. Spreading the club across positions is what
 * lets a FOURTH club-mate exist as a midfielder — the fixture only has three
 * players per club per position, so a same-position fourth cannot be built.
 */
function squadWith(club, n) {
  const clubDef = ctx.players.filter((p) => p.team === club && p.pos === 'DEF');
  const clubMid = ctx.players.filter((p) => p.team === club && p.pos === 'MID');
  const away = ctx.players.filter((p) => p.team !== club && p.pos === 'MID');
  return {
    ids: [...clubDef.slice(0, n).map((p) => p.id), ...away.slice(0, 15 - n).map((p) => p.id)],
    clubDef, clubMid, away,
  };
}

test('a THIRD player from a club is allowed — the limit is three, not two', () => {
  const { ids, clubMid, away } = squadWith(7, 2);
  const rows = replacementOptions(away[0], ctx, 60, ids, { query: '' });
  const third = rows.find((r) => r.player.id === clubMid[0].id);
  assert.ok(third, 'the third club-mate is offered');
  assert.equal(third.blocked, null, 'and is not blocked');
  assert.equal(third.legal, true);
});

test('a FOURTH is blocked, and the message states the real count', () => {
  const { ids, clubMid, away } = squadWith(7, 3);
  const rows = replacementOptions(away[0], ctx, 60, ids, { query: '' });
  const fourth = rows.find((r) => r.player.id === clubMid[0].id);
  assert.ok(fourth, 'a fourth candidate exists');
  assert.equal(fourth.blocked, 'club');
  assert.match(fourth.blockedText, /^3 from /, `states the true count: "${fourth.blockedText}"`);
  assert.match(fourth.blockedWhy, /already has 3 from/, 'says how many it counted');
  assert.match(fourth.blockedWhy, /\(.+,.+\)/, 'and names them, so the claim is checkable');
});

test('swapping one club-mate for another is legal even at the limit', () => {
  // Selling one and buying another from the same club keeps you at three, so
  // it must never be blocked.
  const { ids, clubDef } = squadWith(7, 3);
  const spare = ctx.players.find((p) => p.team === 7 && p.pos === 'DEF' && !ids.includes(p.id));
  if (!spare) return;                       // fixture too small; nothing to assert
  const rows = replacementOptions(clubDef[0], ctx, 60, ids, { query: '' });
  const hit = rows.find((r) => r.player.id === spare.id);
  assert.ok(hit);
  assert.equal(hit.blocked, null, 'the outgoing player is discounted from his own club count');
});

test('a duplicated squad id cannot inflate a club count', () => {
  // A malformed plan mapping two slots onto one player used to read as an
  // extra club-mate, firing the limit a player early with nothing on screen
  // to explain it.
  const { ids, clubDef, clubMid, away } = squadWith(7, 2);
  const dupe = [...ids, clubDef[0].id, clubDef[1].id];
  const rows = replacementOptions(away[0], ctx, 60, dupe, { query: '' });
  const third = rows.find((r) => r.player.id === clubMid[0].id);
  assert.equal(third.blocked, null, 'duplicates are collapsed before counting');
});

test('the club count is taken from the squad it is given, not a rebuilt one', () => {
  // The UI bug this guards: the picker used to rebuild the squad from the weeks
  // BEFORE the one being edited, so a transfer staged in that week was invisible
  // to it and the club you had just moved away from still counted — firing the
  // limit one player early.
  const { ids, clubDef, clubMid, away } = squadWith(7, 3);
  const afterSelling = ids.filter((id) => id !== clubDef[0].id).concat(away[13].id);
  const rows = replacementOptions(away[0], ctx, 60, afterSelling, { query: '' });
  const nowLegal = rows.find((r) => r.player.id === clubMid[0].id);
  assert.ok(nowLegal, 'a club-mate is still offered');
  assert.equal(nowLegal.blocked, null,
    'the squad handed in holds only two from that club, so a third is fine');
});

/* ─────────────────── confirmed price changes ─────────────────── */

const priceLogFixture = () => ({
  updated: '2026-08-30T00:40:00Z', days: 21,
  changes: [
    // a tight window — the 15-minute cron
    { id: 9001, name: 'Alpha', club: 'ARS', pos: 'MID', from: 5.5, to: 5.6, delta: 0.1,
      owned: 12.5, gw: 3, after: '2026-08-30T00:25:00Z', seen: '2026-08-30T00:40:00Z' },
    // a wide one — the 3-hour baseline
    { id: 9002, name: 'Beta', club: 'LIV', pos: 'DEF', from: 6.0, to: 5.9, delta: -0.1,
      owned: 4.0, gw: 3, after: '2026-08-29T21:00:00Z', seen: '2026-08-30T00:00:00Z' },
    // an earlier day
    { id: 9003, name: 'Gamma', club: 'MCI', pos: 'FWD', from: 9.0, to: 9.1, delta: 0.1,
      owned: 30.0, gw: 2, after: '2026-08-27T00:25:00Z', seen: '2026-08-27T00:40:00Z' },
  ],
});

test('price changes group by the day they landed on in the target zone', () => {
  const out = priceChanges(priceLogFixture(), ctx, { tz: 'Australia/Sydney' });
  assert.equal(out.count, 3);
  assert.equal(out.rises, 2);
  assert.equal(out.falls, 1);
  assert.ok(out.days.length >= 2, 'more than one day is represented');
  const keys = out.days.map((d) => d.key);
  assert.deepEqual(keys, keys.slice().sort().reverse(), 'newest day first');
  for (const d of out.days) assert.equal(d.rows.length, d.rises + d.falls);
});

test('a change is a window, never an instant', () => {
  const out = priceChanges(priceLogFixture(), ctx);
  const tight = out.days.flatMap((d) => d.rows).find((c) => c.id === 9001);
  const wide = out.days.flatMap((d) => d.rows).find((c) => c.id === 9002);
  assert.equal(tight.spanMin, 15);
  assert.equal(tight.exact, true, '15 minutes is tight enough to quote as a time');
  assert.equal(wide.spanMin, 180);
  assert.equal(wide.exact, false, 'three hours is a range, not a time');
  // Every row keeps both ends, so nothing downstream can invent a precise
  // moment FPL never published.
  for (const c of out.days.flatMap((d) => d.rows)) {
    assert.ok(c.after && c.seen, 'both ends of the window survive');
    assert.ok(new Date(c.seen) > new Date(c.after));
  }
});

test('the day carries its gameweek, so "when" answers week as well as time', () => {
  const out = priceChanges(priceLogFixture(), ctx);
  assert.ok(out.days.every((d) => Number.isFinite(d.gw)), 'every day names a gameweek');
  const older = out.days[out.days.length - 1];
  assert.equal(older.gw, 2, 'an older day keeps the gameweek it happened in');
});

test('your own players are flagged in the price log', () => {
  const clean = priceChanges(priceLogFixture(), ctx);
  assert.equal(clean.mine, 0, 'nobody in the base fixture is in the squad');
  const log = priceLogFixture();
  log.changes[0].id = ctx.squad[0].id;       // one of yours moved
  const out = priceChanges(log, ctx);
  assert.equal(out.mine, 1);
  assert.ok(out.days.flatMap((d) => d.rows).find((c) => c.id === ctx.squad[0].id).yours);
});

test('the spread of window widths is reported, so the UI can caveat once', () => {
  const out = priceChanges(priceLogFixture(), ctx);
  assert.equal(out.tightest, 15);
  assert.equal(out.widest, 180);
});

test('an empty or missing log is not an error', () => {
  for (const log of [null, undefined, {}, { changes: [] }]) {
    const out = priceChanges(log, ctx);
    assert.equal(out.count, 0);
    assert.deepEqual(out.days, []);
  }
});

/* ══════════════ wildcard slots, lineups and the market filter ═════════════ */

import {
  slotOptions, finishMarket, MARKET_SORTS, fdrAhead,
  arrangeXI, swapLineup, applyFormation, availableFormations,
  xiCounts, shapeProblem, legalShape, formationName,
} from '../js/engine.js';

const squadIds = () => ctx.squad.map((s) => s.id);
const P = (id) => ctx.byId.get(id);

test('an empty slot banks the fee and leaves a hole on the pitch', () => {
  const out = ctx.squad.find((s) => s.player.pos === 'MID').id;
  const plan = { name: 'wc', weeks: [{ gw: ctx.gws[0], transfers: [{ out, in: null }] }] };
  const res = evaluatePlan(plan, ctx);
  const wk = res.weeks[0];
  assert.equal(wk.holes.length, 1, 'one shirt is waiting');
  assert.equal(wk.holes[0].pos, 'MID');
  assert.equal(wk.squad.filter((id) => id == null).length, 1, 'the slot is genuinely empty');
  assert.ok(!wk.squad.includes(out), 'the sold player has left the squad');
  assert.ok(wk.bank > (ctx.entry.bank || 0), 'his fee is in the bank');
  assert.equal(wk.hit, 0, 'an unfilled slot is not a transfer, so it cannot cost a hit');
  assert.equal(wk.used, 0);
  assert.ok(res.problems.some((t) => /empty slot/.test(t)), 'and the plan says so out loud');
});

test('several slots can be empty at once — this is what a wildcard looks like mid-build', () => {
  const outs = ctx.squad.slice(0, 5).map((s) => s.id);
  const plan = { name: 'wc', weeks: [{ gw: ctx.gws[0], chip: 'wildcard',
    transfers: outs.map((id) => ({ out: id, in: null })) }] };
  const res = evaluatePlan(plan, ctx);
  assert.equal(res.weeks[0].holes.length, 5);
  assert.equal(res.weeks[0].hit, 0);
  const banked = outs.reduce((s, id) => s + P(id).price, ctx.entry.bank);
  assert.ok(Math.abs(res.weeks[0].bank - banked) < 0.05, 'every fee is accounted for');
});

test('filling an empty slot spends the bank, not the bank plus a price', () => {
  const out = ctx.squad.find((s) => s.player.pos === 'FWD');
  const plan = { name: 'wc', weeks: [{ gw: ctx.gws[0], transfers: [{ out: out.id, in: null }] }] };
  const wk = evaluatePlan(plan, ctx).weeks[0];
  const rows = slotOptions('FWD', ctx, wk.bank, wk.squad);
  assert.ok(rows.length, 'the market has forwards');
  for (const r of rows.filter((x) => x.legal)) {
    assert.ok(r.player.price <= wk.bank + 1e-9,
      `${r.player.name} at £${r.player.price} must fit inside £${wk.bank}`);
  }
  const over = rows.find((r) => r.blocked === 'budget');
  if (over) assert.match(over.blockedWhy, new RegExp(`£${wk.bank.toFixed(1)}m for this slot`));
});

test('the player you just sold can be bought back into his own empty slot', () => {
  const out = ctx.squad.find((s) => s.player.pos === 'MID');
  const plan = { name: 'wc', weeks: [{ gw: ctx.gws[0], transfers: [{ out: out.id, in: null }] }] };
  const wk = evaluatePlan(plan, ctx).weeks[0];
  const rows = slotOptions('MID', ctx, wk.bank, wk.squad);
  const him = rows.find((r) => r.player.id === out.id);
  assert.ok(him, 'he is in the market again');
  assert.ok(him.legal, 'and buying him back is legal — you have his money');
});

test('the club limit counts the squad on the pitch, holes and all', () => {
  const team = ctx.squad[0].player.team;
  const mates = ctx.squad.filter((s) => s.player.team === team);
  const rows = slotOptions(ctx.squad[0].player.pos, ctx, 100, squadIds());
  const blocked = rows.filter((r) => r.player.team === team && r.blocked === 'club');
  if (mates.length >= MAX_PER_CLUB) {
    assert.ok(blocked.length, 'at the limit, the club is blocked');
    assert.match(blocked[0].blockedWhy, /limit is 3/);
  } else {
    assert.equal(blocked.length, 0, 'under the limit, nothing from that club is blocked');
  }
});

test('a manual eleven survives a transfer that does not touch it', () => {
  const auto = optimalXI(ctx.squad.map((s) => s.player), 0);
  const manual = { xi: auto.xi.map((p) => p.id), bench: auto.bench.map((p) => p.id) };
  const benchMan = auto.bench.find((p) => p.pos !== 'GKP');
  const players = ctx.squad.map((s) => s.player).filter((p) => p.id !== benchMan.id);
  const kept = arrangeXI(players, 0, manual);
  assert.equal(kept.manual, true);
  assert.deepEqual(kept.xi.map((p) => p.id).sort(), manual.xi.slice().sort(),
    'selling a substitute leaves the eleven exactly as it was');
});

test('a manual eleven is repaired, not discarded, when a starter is sold', () => {
  const auto = optimalXI(ctx.squad.map((s) => s.player), 0);
  const manual = { xi: auto.xi.map((p) => p.id), bench: auto.bench.map((p) => p.id) };
  const gone = auto.xi.find((p) => p.pos === 'MID');
  const players = ctx.squad.map((s) => s.player).filter((p) => p.id !== gone.id);
  const fixed = arrangeXI(players, 0, manual);
  assert.equal(fixed.xi.length, 11);
  assert.equal(shapeProblem(xiCounts(fixed.xi)), null, 'still a legal shape');
  assert.ok(!fixed.xi.some((p) => p.id === gone.id));
  const survivors = manual.xi.filter((id) => id !== gone.id);
  const stillThere = survivors.filter((id) => fixed.xi.some((p) => p.id === id));
  assert.equal(stillThere.length, survivors.length, 'everyone else keeps his place');
});

test('swapping a bench player in and a starter out keeps the eleven legal', () => {
  const arr = optimalXI(ctx.squad.map((s) => s.player), 0);
  const sub = arr.bench.find((p) => p.pos !== 'GKP');
  const starter = arr.xi.find((p) => p.pos === sub.pos);
  const r = swapLineup(arr, starter.id, sub.id);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.xi.includes(sub.id) && !r.xi.includes(starter.id));
  assert.ok(r.bench.includes(starter.id));
  assert.equal(r.xi.length, 11);
});

test('a swap that would break the shape is refused with the rule it breaks', () => {
  const arr = optimalXI(ctx.squad.map((s) => s.player), 0);
  const counts = xiCounts(arr.xi);
  // find a position that is already at its minimum, and try to drop one more
  const min = { DEF: 3, MID: 2, FWD: 1 };
  const tight = ['DEF', 'MID', 'FWD'].find((k) => counts[k] === min[k]);
  if (!tight) return;                       // this XI has slack everywhere
  const starter = arr.xi.find((p) => p.pos === tight);
  const sub = arr.bench.find((p) => p.pos !== tight && p.pos !== 'GKP');
  if (!sub) return;
  const r = swapLineup(arr, starter.id, sub.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /at least|most/, 'the message names the rule, not "invalid"');
});

test('a goalkeeper can only swap with the other goalkeeper', () => {
  const arr = optimalXI(ctx.squad.map((s) => s.player), 0);
  const gk = arr.xi.find((p) => p.pos === 'GKP');
  const outfieldSub = arr.bench.find((p) => p.pos !== 'GKP');
  const bad = swapLineup(arr, gk.id, outfieldSub.id);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /goalkeeper/i);

  const benchGk = arr.bench.find((p) => p.pos === 'GKP');
  if (benchGk) {
    const good = swapLineup(arr, gk.id, benchGk.id);
    assert.equal(good.ok, true, good.error);
    assert.ok(good.xi.includes(benchGk.id));
    assert.equal(good.bench[0], gk.id, 'the reserve keeper stays in the first bench slot');
  }
});

test('changing formation keeps as many starters as the new shape allows', () => {
  const arr = optimalXI(ctx.squad.map((s) => s.player), 0);
  const shapes = availableFormations(ctx.squad.map((s) => s.player));
  assert.ok(shapes.length > 1, 'a full squad can field more than one shape');
  const target = shapes.find((s) => s !== arr.formation);
  const r = applyFormation(arr, target, 0);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.formation, target);
  assert.equal(r.xi.length, 11);
  const [d, m, f] = target.split('-').map(Number);
  const byId = new Map([...arr.xi, ...arr.bench].map((p) => [p.id, p]));
  const c = xiCounts(r.xi.map((id) => byId.get(id)));
  assert.deepEqual([c.DEF, c.MID, c.FWD], [d, m, f]);
  assert.equal(c.GKP, 1);
});

test('an impossible formation is refused by name, not by silence', () => {
  const arr = optimalXI(ctx.squad.map((s) => s.player), 0);
  assert.equal(applyFormation(arr, '6-2-2', 0).ok, false);
  assert.match(applyFormation(arr, '6-2-2', 0).error, /not a legal formation/);
});

test('every legal shape passes and every illegal one names its rule', () => {
  assert.equal(shapeProblem({ GKP: 1, DEF: 4, MID: 4, FWD: 2 }), null);
  assert.equal(legalShape({ GKP: 1, DEF: 3, MID: 4, FWD: 3 }), true);
  assert.match(shapeProblem({ GKP: 1, DEF: 2, MID: 5, FWD: 3 }), /at least three/);
  assert.match(shapeProblem({ GKP: 1, DEF: 5, MID: 5, FWD: 0 }), /at least one forward/);
  assert.match(shapeProblem({ GKP: 0, DEF: 5, MID: 4, FWD: 2 }), /need a goalkeeper/);
  assert.match(shapeProblem({ GKP: 2, DEF: 4, MID: 3, FWD: 2 }), /Only one goalkeeper/);
  assert.equal(formationName({ GKP: 1, DEF: 3, MID: 5, FWD: 2 }), '3-5-2');
});

test('the market filters on every axis the drawer offers', () => {
  const all = slotOptions('MID', ctx, 100, []);
  const cheap = finishMarket(all, { maxPrice: 6 });
  assert.ok(cheap.length && cheap.every((r) => r.player.price <= 6));
  const fit = finishMarket(all, { avail: 'fit' });
  assert.ok(fit.every((r) => r.player.status === 'a'));
  const one = ctx.teams.keys().next().value;
  const club = finishMarket(all, { team: one });
  assert.ok(club.every((r) => r.player.team === one));
  const kind = finishMarket(all, { maxFdr: 3 });
  assert.ok(kind.every((r) => fdrAhead(r.player, 3) <= 3 + 1e-9));
  assert.ok(finishMarket(all, { legalOnly: true }).every((r) => r.legal));
});

test('every sort column ranks descending, and blocked rows stay underneath', () => {
  const all = slotOptions('MID', ctx, 12, squadIds());
  for (const s of MARKET_SORTS) {
    const rows = finishMarket(all, { sort: s.key });
    const legal = rows.filter((r) => r.legal);
    for (let i = 1; i < legal.length; i++) {
      assert.ok(s.of(legal[i - 1]) >= s.of(legal[i]) - 1e-9,
        `${s.key} is not descending at row ${i}`);
    }
    const firstBlocked = rows.findIndex((r) => !r.legal);
    const lastLegal = rows.map((r) => r.legal).lastIndexOf(true);
    if (firstBlocked >= 0 && lastLegal >= 0) {
      assert.ok(firstBlocked > lastLegal, `${s.key} floated a blocked row above a legal one`);
    }
  }
});

test('sorting by fixtures puts the kindest run first', () => {
  const all = slotOptions('DEF', ctx, 100, []);
  const rows = finishMarket(all, { sort: 'fix', legalOnly: true });
  assert.ok(fdrAhead(rows[0].player, 3) <= fdrAhead(rows[rows.length - 1].player, 3) + 1e-9);
});

test('auto-fill builds a legal squad out of fifteen empty shirts', async () => {
  const { fillSlots } = await import('../js/engine.js');
  const holes = ctx.squad.map((s) => ({ out: s.id, pos: s.player.pos }));
  const bank = ctx.squad.reduce((s, x) => s + x.player.price, ctx.entry.bank);
  const r = fillSlots(ctx, [], holes, bank);
  assert.equal(r.unfilled.length, 0, 'every slot found somebody');
  assert.equal(r.fills.length, 15);
  assert.ok(r.bank >= -1e-9, `it did not overspend (£${r.bank}m left)`);

  const shape = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubs = {};
  r.fills.forEach((f) => { shape[f.player.pos] += 1; clubs[f.player.team] = (clubs[f.player.team] || 0) + 1; });
  assert.deepEqual(shape, SQUAD_SHAPE, 'the positions come out right');
  assert.ok(Object.values(clubs).every((n) => n <= MAX_PER_CLUB), 'and nobody breaks the club limit');
  assert.equal(new Set(r.fills.map((f) => f.player.id)).size, 15, 'nobody is picked twice');
});

test('auto-fill reserves money for the slots it has not reached yet', async () => {
  const { fillSlots } = await import('../js/engine.js');
  const holes = [{ pos: 'FWD' }, { pos: 'FWD' }, { pos: 'GKP' }];
  // Exactly enough money for the three cheapest — nothing to spare anywhere.
  const cheapest = (pos, k) => ctx.players
    .filter((p) => p.pos === pos && p.status === 'a')
    .map((p) => p.price).sort((a, b) => a - b).slice(0, k).reduce((s, v) => s + v, 0);
  const tight = cheapest('FWD', 2) + cheapest('GKP', 1);

  const r = fillSlots(ctx, [], holes, tight);
  assert.equal(r.unfilled.length, 0,
    'the first forward did not eat the money the other two slots needed');
  assert.ok(r.bank >= -1e-9, `it did not overspend (£${r.bank}m left)`);

  const broke = fillSlots(ctx, [], holes, tight - 0.5);
  assert.ok(broke.unfilled.length > 0, 'half a million short and it says which slot missed out');
});

test('auto-fill says which slots it could not fill rather than dropping them', async () => {
  const { fillSlots } = await import('../js/engine.js');
  const r = fillSlots(ctx, [], [{ pos: 'FWD' }, { pos: 'FWD' }], 0.1);
  assert.ok(r.unfilled.length > 0, 'no money means no players, and it says so');
});

test('the upgrade pass spends what is left without breaking anything', async () => {
  const { fillSlots } = await import('../js/engine.js');
  const holes = ctx.squad.map((s) => ({ out: s.id, pos: s.player.pos }));
  const bank = ctx.squad.reduce((s, x) => s + x.player.price, ctx.entry.bank);
  const plain = fillSlots(ctx, [], holes, bank, { upgrade: false });
  const better = fillSlots(ctx, [], holes, bank);

  const worth = (r) => r.fills.reduce((s, f) => s + f.player.scores.overall, 0);
  assert.ok(worth(better) >= worth(plain) - 1e-9, 'upgrading never makes the squad worse');
  assert.ok(better.bank <= plain.bank + 1e-9, 'and it never leaves more money behind');
  assert.ok(better.bank >= -1e-9, `still inside the budget (£${better.bank}m)`);

  const clubs = {};
  better.fills.forEach((f) => { clubs[f.player.team] = (clubs[f.player.team] || 0) + 1; });
  assert.ok(Object.values(clubs).every((n) => n <= MAX_PER_CLUB), 'and still legal on clubs');
  assert.equal(new Set(better.fills.map((f) => f.player.id)).size, better.fills.length, 'and nobody duplicated');
});

/* ═══════ a half-built squad must still lay out — the vanishing-pitch bug ═══════ */

test('a squad with no legal eleven still puts every player on the pitch', () => {
  // Sell three midfielders and a forward: eleven players left, but only nine
  // outfield, which no formation can accommodate. optimalXI is right to refuse;
  // arrangeXI must not hand back nothing.
  const outs = [
    ...ctx.squad.filter((s) => s.player.pos === 'MID').slice(0, 3),
    ...ctx.squad.filter((s) => s.player.pos === 'FWD').slice(0, 1),
  ].map((s) => s.id);
  const plan = { name: 'wc', weeks: [{ gw: ctx.gws[0], transfers: outs.map((id) => ({ out: id, in: null })) }] };
  const wk = evaluatePlan(plan, ctx).weeks[0];

  const owned = wk.squad.filter((id) => id != null);
  assert.equal(owned.length, 11);
  assert.equal(optimalXI(owned.map(P), 0), null, 'no legal eleven exists — that part was correct');

  assert.equal(wk.incomplete, true, 'the week says so');
  assert.ok(wk.missing && wk.missing.length, `and says what it is short of: ${wk.missing}`);

  const shown = new Set([...wk.xi, ...wk.bench]);
  assert.equal(shown.size, owned.length, 'nobody is duplicated');
  for (const id of owned) {
    assert.ok(shown.has(id), `${P(id).name} must still be somewhere on the pitch`);
  }
});

test('the provisional layout respects the maxima it can still honour', () => {
  const outs = [
    ...ctx.squad.filter((s) => s.player.pos === 'MID').slice(0, 3),
    ...ctx.squad.filter((s) => s.player.pos === 'FWD').slice(0, 1),
  ].map((s) => s.id);
  const plan = { name: 'wc', weeks: [{ gw: ctx.gws[0], transfers: outs.map((id) => ({ out: id, in: null })) }] };
  const wk = evaluatePlan(plan, ctx).weeks[0];
  const c = xiCounts(wk.xi.map(P));
  assert.ok(wk.xi.length <= 11, `at most eleven start (${wk.xi.length})`);
  assert.equal(c.GKP, 1, 'exactly one keeper on the pitch');
  assert.ok(c.DEF <= 5 && c.MID <= 5 && c.FWD <= 3, 'no line is over its maximum');
  assert.equal(shapeProblem(c, { partial: true }), null, 'legal as far as it can be');
});

test('an emptied squad is a squad of holes, not an incomplete eleven', () => {
  const plan = { name: 'wc', weeks: [{ gw: ctx.gws[0], chip: 'wildcard',
    transfers: ctx.squad.map((s) => ({ out: s.id, in: null })) }] };
  const wk = evaluatePlan(plan, ctx).weeks[0];
  assert.equal(wk.holes.length, 15);
  assert.equal(wk.xi.length, 0);
  assert.equal(wk.incomplete, false, 'nobody owned means nothing to lay out');
});

test('the squad can still be rearranged while it is short', () => {
  const outs = ctx.squad.filter((s) => s.player.pos === 'MID').slice(0, 3).map((s) => s.id);
  const plan = { name: 'wc', weeks: [{ gw: ctx.gws[0], transfers: outs.map((id) => ({ out: id, in: null })) }] };
  const wk = evaluatePlan(plan, ctx).weeks[0];
  if (!wk.incomplete) return;                    // this fixture can still field an XI

  const arr = { xi: wk.xi.map(P), bench: wk.bench.map(P), incomplete: true };
  const sub = arr.bench.find((p) => p.pos !== 'GKP' && arr.xi.some((q) => q.pos === p.pos));
  if (!sub) return;
  const starter = arr.xi.find((p) => p.pos === sub.pos);
  const r = swapLineup(arr, starter.id, sub.id);
  assert.equal(r.ok, true,
    `a like-for-like swap must not be refused mid-build (${r.error || ''})`);
});

test('the maxima still hold while the squad is short', () => {
  assert.match(shapeProblem({ GKP: 2, DEF: 4, MID: 3, FWD: 2 }, { partial: true }), /Only one goalkeeper/);
  assert.match(shapeProblem({ GKP: 1, DEF: 6, MID: 3, FWD: 1 }, { partial: true }), /Five defenders/);
  assert.equal(shapeProblem({ GKP: 1, DEF: 5, MID: 2, FWD: 2 }, { partial: true }), null,
    'ten players is not an error while you are still buying');
  assert.match(shapeProblem({ GKP: 1, DEF: 5, MID: 2, FWD: 2 }), /not eleven/,
    'but it is once the squad is meant to be complete');
});

/* ══════════════════ set-piece duty and the season review ══════════════════ */

import { setPieces, setPieceText, seasonReview, playerScores, SET_PIECE_ROUTINES } from '../js/engine.js';

test('set-piece duty is read off the order FPL publishes', () => {
  assert.deepEqual(setPieces({ pens: 1, fks: 2, corners: null }).map((r) => r.key), ['pens', 'fks']);
  assert.equal(setPieces({ pens: 1 })[0].first, true);
  assert.equal(setPieces({ pens: 2 })[0].first, false);
  assert.deepEqual(setPieces({ pens: null, fks: null, corners: null }), []);
  assert.deepEqual(setPieces({ pens: 5 }), [], 'fifth in line is not a set-piece taker');
  assert.match(setPieceText({ pens: 1, corners: 2 }), /penalties \(1st\).*corners \(2nd\)/);
});

test('a penalty taker wears the badge, and it outranks the xG badges', () => {
  const p = ctx.players.find((x) => x.pos !== 'GKP');
  const taker = playerTraits({ ...p, pens: 1 }, 4);
  assert.ok(taker.some((t) => t.key === 'pens'), 'the badge is there');
  const idx = taker.findIndex((t) => t.key === 'pens');
  const threat = taker.findIndex((t) => t.key === 'threat');
  if (threat >= 0) assert.ok(idx < threat, 'and it leads the goal-threat badge');
  assert.equal(taker.find((t) => t.key === 'pens').raw, 'first choice');
});

test('set-piece duty is shown but never scored', () => {
  const p = ctx.players.find((x) => x.pos === 'MID');
  const plain = playerScores(p, ctx);
  const taker = playerScores({ ...p, pens: 1, fks: 1, corners: 1 }, ctx);
  assert.deepEqual(taker, plain,
    'the projection must not move — the xG already contains the penalties he has taken');
});

test('the market can be filtered to penalty takers', () => {
  const all = slotOptions('MID', ctx, 100, []);
  const marked = all.map((r, i) => (i % 7 === 0
    ? { ...r, player: { ...r.player, pens: 1 } }
    : { ...r, player: { ...r.player, pens: null, fks: null, corners: null } }));
  const pens = finishMarket(marked, { setPiece: 'pens' });
  assert.ok(pens.length, 'some takers found');
  assert.ok(pens.every((r) => r.player.pens === 1));
  assert.ok(pens.length < marked.length, 'and it actually narrowed the list');
});

/* ── the season ── */

const seasonCtx = () => {
  const c = buildContext(makeSnapshot());
  c.snapshot.eventStats = [
    { id: 1, average: 50, highest: 120 },
    { id: 2, average: 40, highest: 110 },
    { id: 3, average: 60, highest: 130 },
  ];
  c.entry.seasonHistory = [
    { gw: 1, pts: 61, rank: 400000, total: 61, value: 100.0, bank: 1.5, transfers: 0, hit: 0, bench: 5 },
    { gw: 2, pts: 44, rank: 350000, total: 101, value: 100.2, bank: 0.7, transfers: 2, hit: 4, bench: 12 },
    { gw: 3, pts: 72, rank: 210000, total: 173, value: 100.9, bank: 0.3, transfers: 1, hit: 0, bench: 2 },
  ];
  return c;
};

test('the season is scored from the running total, not from the points label', () => {
  const s = seasonReview(seasonCtx());
  assert.equal(s.played, 3);
  assert.equal(s.points, 173, 'the season total is what FPL says it is');
  // GW2: the total moved 61 → 101, so the week netted 40 after a 4-point hit
  const wk2 = s.weeks.find((w) => w.gw === 2);
  assert.equal(wk2.net, 40, 'net is the change in the running total');
  assert.equal(wk2.hit, 4);
  assert.equal(wk2.gross, 44, 'and the gross is the net plus the hit back on');
  assert.equal(s.weeks.reduce((a, w) => a + w.net, 0), 173, 'the weeks add up to the season');
});

test('the season counts the two numbers FPL never shows you', () => {
  const s = seasonReview(seasonCtx());
  assert.equal(s.hits, 4, 'points paid in hits');
  assert.equal(s.hitCount, 1, 'in one week');
  assert.equal(s.bench, 19, 'points left on the bench');
  assert.equal(s.transfers, 3);
});

test('the season is compared against what the field scored', () => {
  const s = seasonReview(seasonCtx());
  assert.equal(s.weeks[0].vsAverage, 11, '61 against an average of 50');
  assert.equal(s.weeks[1].vsAverage, 0, '40 against an average of 40 is level');
  assert.equal(s.beat, 2, 'two weeks better than the field');
  assert.equal(s.ratedWeeks, 3);
  assert.equal(s.vsAverage, 23, '+11, 0, +12');
});

test('the season names the best and worst weeks and the rank swing', () => {
  const s = seasonReview(seasonCtx());
  assert.equal(s.best.gw, 3);
  assert.equal(s.worst.gw, 2);
  assert.equal(s.rank, 210000, 'the rank is the latest one');
  assert.equal(s.bestRank, 210000);
  assert.equal(s.worstRank, 400000);
  assert.equal(s.valueGain, 0.9, 'value is measured from the first week on record');
});

test('a season with one round played, or none at all, is not an error', () => {
  const one = buildContext(makeSnapshot());
  one.snapshot.eventStats = [];
  one.entry.seasonHistory = [{ gw: 1, pts: 61, rank: 400000, total: 61, value: 100, bank: 1.5 }];
  const s = seasonReview(one);
  assert.equal(s.played, 1);
  assert.equal(s.points, 61);
  assert.equal(s.vsAverage, null, 'no field data means no comparison, not a zero');
  assert.equal(s.valueGain, 0, 'one week of value is no change');

  const none = buildContext(makeSnapshot());
  none.entry.seasonHistory = [];
  assert.equal(seasonReview(none), null);
});

test('an older history without the new fields still reviews', () => {
  const old = buildContext(makeSnapshot());
  old.entry.seasonHistory = [
    { gw: 1, pts: 61, rank: 400000, value: 100, bank: 1.5 },
    { gw: 2, pts: 44, rank: 350000, value: 100.2, bank: 0.7 },
  ];
  const s = seasonReview(old);
  assert.equal(s.played, 2);
  assert.equal(s.points, 105, 'the total falls back to summing the weeks');
  assert.equal(s.hits, 0);
  assert.equal(s.bench, 0);
});

/* ═══════════════════════════ chip timing ════════════════════════════════ */

import { chipPlanner } from '../js/engine.js';

/** A schedule with a known blank week and a known double week. */
function schedCtx() {
  const c = buildContext(makeSnapshot());
  const teams = {};
  const ids = [...c.teams.keys()];
  const blanking = ids.slice(0, 4);
  for (const id of ids) {
    teams[id] = {};
    for (let g = c.gws[0]; g <= c.gws[0] + 9; g++) {
      if (g === c.gws[0] + 7 && blanking.includes(id)) continue;        // blank
      teams[id][g] = g === c.gws[0] + 9 && blanking.includes(id) ? 2 : 1; // double
    }
  }
  c.snapshot.schedule = { from: c.gws[0], to: c.gws[0] + 9, teams };
  return { ctx: c, blankGw: c.gws[0] + 7, doubleGw: c.gws[0] + 9, blanking };
}

test('the chip planner reads blanks and doubles from the schedule', () => {
  const { ctx: c, blankGw, doubleGw } = schedCtx();
  const p = chipPlanner(c);
  assert.ok(p.blankWeeks.length, 'it found the blank week');
  assert.equal(p.blankWeeks[0].gw, blankGw);
  assert.ok(p.doubleWeeks.length, 'and the double');
  assert.equal(p.doubleWeeks[0].gw, doubleGw);
  const blank = p.weeks.find((w) => w.gw === blankGw);
  assert.ok(blank.blanks.every((x) => x.team != null), 'blanking players are named');
  assert.equal(blank.blankCount, blank.blanks.length);
});

test('weeks inside the horizon are scored, weeks beyond it are not', () => {
  const { ctx: c } = schedCtx();
  const p = chipPlanner(c);
  const inside = p.weeks.filter((w) => w.rated);
  const outside = p.weeks.filter((w) => !w.rated);
  assert.ok(inside.length && outside.length, 'the fixture spans both grades');
  assert.deepEqual(inside.map((w) => w.gw), c.gws, 'rated weeks are exactly the projection horizon');
  for (const w of inside) {
    assert.ok(w.xiPoints > 0, `GW${w.gw} has a projection`);
    assert.ok(w.bboost != null && w.tc != null);
  }
  for (const w of outside) {
    assert.equal(w.xiPoints, null, `GW${w.gw} claims no points it cannot know`);
    assert.equal(w.bboost, null);
    assert.equal(w.tc, null);
    assert.ok(w.known > 0, 'but the fixture structure is still reported');
  }
});

test('Bench Boost is worth exactly what the bench projects', () => {
  const { ctx: c } = schedCtx();
  const p = chipPlanner(c);
  const w = p.picks.bboost.best;
  assert.ok(w, 'a week was chosen');
  const idx = c.gws.indexOf(w.gw);
  const arr = arrangeXI(c.squad.map((s) => s.player), idx);
  const bench = Math.round(arr.bench.reduce((s, q) => s + (q.proj[idx] || 0), 0) * 100) / 100;
  assert.equal(w.bboost, bench, 'no modelling, just the bench');
  for (const other of p.weeks.filter((x) => x.bboost != null)) {
    assert.ok(w.bboost >= other.bboost, `GW${w.gw} is the best bench week`);
  }
});

test('Triple Captain is the marginal armband, not the whole three', () => {
  const { ctx: c } = schedCtx();
  const p = chipPlanner(c);
  const w = p.picks['3xc'].best;
  const idx = c.gws.indexOf(w.gw);
  const arr = arrangeXI(c.squad.map((s) => s.player), idx);
  const top = Math.max(...arr.xi.map((q) => q.proj[idx] || 0));
  assert.ok(Math.abs(w.tc - top) < 0.01, 'one more copy of the captain, not three');
});

test('Free Hit is only offered for a week that is actually bad', () => {
  const { ctx: c } = schedCtx();
  const p = chipPlanner(c);
  assert.ok(p.typical > 0, 'a normal week for this squad is known');
  for (const w of p.weeks.filter((x) => x.freehit != null)) {
    assert.ok(Math.abs((p.typical - w.xiPoints) - w.freehit) < 0.02,
      'the value is the gap below a normal week');
  }
  const pick = p.picks.freehit.best;
  if (pick) assert.ok(pick.freehit > 0, 'never a week that is already better than usual');
});

test('every wildcard week is judged over the same window', () => {
  const { ctx: c } = schedCtx();
  const p = chipPlanner(c);
  const rated = p.weeks.filter((w) => w.wildcard != null);
  assert.ok(rated.length, 'some weeks have runway');
  // Only weeks with at least three gameweeks of fixtures left may be rated —
  // otherwise a three-week average is being ranked against a six-week one.
  const lastRatable = c.gws[c.gws.length - 3];
  assert.equal(rated[rated.length - 1].gw, lastRatable);
  assert.ok(rated.every((w) => w.wildcard >= 1 && w.wildcard <= 5), 'and it is a difficulty');
});

test('a snapshot with no schedule still plans what it can', () => {
  const c = buildContext(makeSnapshot());
  delete c.snapshot.schedule;
  const p = chipPlanner(c);
  assert.equal(p.scheduleKnown, false, 'and says the schedule is missing');
  assert.deepEqual(p.blankWeeks, [], 'no fixture counts means no blanks claimed');
  assert.ok(p.weeks.every((w) => w.known === 0));
  assert.ok(p.picks.bboost.best, 'the points-based chips still work off the projections');
});

test('no squad, no chip advice', () => {
  const c = buildContext(makeSnapshot());
  selectEntry(c, false);
  assert.equal(chipPlanner(c), null);
});

/* ═════════════════════ scoring the advice afterwards ═════════════════════ */

import { adviceReview, CALIBRATION_BANDS } from '../js/engine.js';

/** A locked prediction for GW1 plus the actuals it should be scored against. */
function reviewFixture(over = {}) {
  const ids = ctx.squad.map((s) => s.id);
  const preds = ctx.players.map((p) => [p.id, 4]);
  const timeline = { players: {}, latestGw: 1 };
  // Everyone actually scored 3, so the model was a point optimistic throughout.
  ctx.players.forEach((p) => { timeline.players[String(p.id)] = { 1: [p.price, p.owned, 3, 3] }; });
  const predictions = {
    gws: {
      1: {
        at: '2026-08-21T09:00:00Z', deadline: '2026-08-21T17:30:00Z', locked: true,
        rows: preds,
        entries: {
          [ctx.entry.key]: {
            captain: ids[8], vice: ids[7], xi: ids.slice(0, 11), expected: 58, confidence: 'moderate',
            transfer: { out: ids[14], in: ctx.players.find((p) => !ids.includes(p.id)).id, gain: 1.2 },
            picks: ctx.squad.map((s, i) => [s.id, i + 1, i === 6 ? 2 : i < 11 ? 1 : 0]),
            chip: null,
            ...over.entry,
          },
        },
        ...over.week,
      },
    },
  };
  return { predictions, timeline, ids };
}

test('only a locked gameweek is ever scored', () => {
  const { predictions, timeline } = reviewFixture({ week: { locked: false } });
  const r = adviceReview(predictions, timeline, ctx);
  assert.equal(r.waiting, true, 'an open week is a prediction, not a result');
  assert.deepEqual(r.weeks, []);
});

test('the model is scored on how close the projections came', () => {
  const { predictions, timeline } = reviewFixture();
  const w = adviceReview(predictions, timeline, ctx).latest;
  assert.equal(w.gw, 1);
  assert.equal(w.mae, 1, 'projected 4, they scored 3');
  assert.equal(w.bias, 1, 'and a positive bias means optimistic');
  assert.equal(w.n, ctx.players.length);
});

test('the headline error excludes the players nobody was ever unsure about', () => {
  const { predictions, timeline } = reviewFixture();
  // Half the pool projected at 0.5, and they all scored 0 — easy cases that
  // would drag an all-players average toward zero.
  predictions.gws[1].rows = ctx.players.map((p, i) => [p.id, i % 2 ? 0.5 : 4]);
  ctx.players.forEach((p, i) => {
    timeline.players[String(p.id)][1] = [p.price, p.owned, i % 2 ? 0 : 3, i % 2 ? 0 : 3];
  });
  const w = adviceReview(predictions, timeline, ctx).latest;
  assert.ok(w.maeTop > w.mae, `the honest figure is worse (${w.maeTop} vs ${w.mae})`);
  assert.equal(w.threshold, 2);
  assert.ok(w.nTop < w.n, 'and it is measured over fewer players');
});

test('the captain call is scored against the man you actually picked', () => {
  const { predictions, timeline, ids } = reviewFixture();
  timeline.players[String(ids[8])][1] = [5, 5, 9, 9];    // ours scored 9
  timeline.players[String(ids[6])][1] = [5, 5, 2, 2];    // yours scored 2
  const w = adviceReview(predictions, timeline, ctx).latest;
  assert.equal(w.captain.same, false);
  assert.equal(w.captain.advised.pts, 9);
  assert.equal(w.captain.yours.pts, 2);
  assert.equal(w.captain.delta, 14, 'the armband doubles the gap, so 7 becomes 14');
});

test('captaining the same man is a nil difference, not a missing one', () => {
  const { predictions, timeline, ids } = reviewFixture();
  predictions.gws[1].entries[ctx.entry.key].captain = ids[6];
  const w = adviceReview(predictions, timeline, ctx).latest;
  assert.equal(w.captain.same, true);
  assert.equal(w.captain.delta, 0);
});

test('the transfer call is scored, and whether you took it is knowable', () => {
  const { predictions, timeline, ids } = reviewFixture();
  const move = predictions.gws[1].entries[ctx.entry.key].transfer;
  timeline.players[String(move.out)][1] = [5, 5, 1, 1];
  timeline.players[String(move.in)][1] = [5, 5, 11, 11];
  const w = adviceReview(predictions, timeline, ctx).latest;
  assert.equal(w.transfer.delta, 10, 'the man coming in outscored the man going out by 10');
  assert.equal(w.transfer.taken, false, 'and the squad shows it was not made');
  assert.equal(w.transfer.out.id, ids[14]);
});

test('the reliability bands compare what was said with what happened', () => {
  const { predictions, timeline } = reviewFixture();
  predictions.gws[1].rows = ctx.players.map((p, i) => [p.id, i % 3 === 0 ? 1.5 : i % 3 === 1 ? 5 : 7]);
  ctx.players.forEach((p, i) => {
    const got = i % 3 === 0 ? 1 : i % 3 === 1 ? 6 : 6;
    timeline.players[String(p.id)][1] = [p.price, p.owned, got, got];
  });
  const s = adviceReview(predictions, timeline, ctx).season;
  assert.ok(s.bands.length >= 3, 'several bands have players in them');
  for (const b of s.bands) {
    assert.ok(b.n > 0, 'an empty band is dropped rather than drawn as a gap');
    assert.ok(b.predicted >= b.lo && b.predicted < b.hi, 'the band average sits inside the band');
    assert.ok(b.actual != null);
  }
  const mid = s.bands.find((b) => b.lo === 4);
  assert.ok(mid && mid.actual > mid.predicted, 'the 4–6 band under-predicted, and it says so');
  assert.deepEqual(CALIBRATION_BANDS[0], [0, 1]);
});

test('bias is broken out by position, because the model is not wrong evenly', () => {
  const { predictions, timeline } = reviewFixture();
  ctx.players.forEach((p) => {
    const got = p.pos === 'DEF' ? 1 : 4;             // defenders flatter to deceive
    timeline.players[String(p.id)][1] = [p.price, p.owned, got, got];
  });
  const s = adviceReview(predictions, timeline, ctx).season;
  const def = s.byPos.find((r) => r.pos === 'DEF');
  const mid = s.byPos.find((r) => r.pos === 'MID');
  assert.equal(def.bias, 3, 'projected 4, they scored 1');
  assert.equal(mid.bias, 0);
  assert.ok(def.n > 0 && mid.n > 0);
});

test('an actual can be recovered from a running total when the week is missing', () => {
  const { predictions, timeline } = reviewFixture();
  const p = ctx.players[0];
  // An old three-element row: only the season total, no gameweek figure.
  timeline.players[String(p.id)] = { 1: [p.price, p.owned, 7] };
  const r = adviceReview(predictions, timeline, ctx);
  assert.ok(r.latest.n > 0, 'it still scores');
});

test('no predictions, or no timeline, is not an error', () => {
  assert.equal(adviceReview(null, { players: {} }, ctx), null);
  assert.equal(adviceReview({ gws: {} }, null, ctx), null);
  assert.equal(adviceReview({ gws: {} }, { players: {} }, ctx).waiting, true);
});

/* ═══════════════════ the people you actually play ═══════════════════════ */

import { leagueEdge } from '../js/engine.js';

/** A twelve-man league whose squads overlap yours by varying amounts. */
function leagueCtx(over = {}) {
  const c = buildContext(makeSnapshot());
  const mine = c.squad.map((s) => s.id);
  const others = c.players.filter((p) => !mine.includes(p.id)).map((p) => p.id);
  const managers = Array.from({ length: 12 }, (_, i) => {
    // rival i owns the first (12 - i) of your players, then fills up elsewhere
    const shared = mine.slice(0, 12 - i);
    const rest = others.slice(i * 15, i * 15 + (15 - shared.length));
    const picks = [...shared, ...rest].map((id, j) => ({ id, slot: j + 1, multiplier: j === 0 ? 2 : 1 }));
    return { entry: 1000 + i, team: `Team ${i}`, manager: `M${i}`, rank: i + 2, total: 500 - i * 5,
      picks, captain: i < 8 ? mine[0] : mine[3], chip: null };
  });
  c.entry.rivals = { leagueId: 51, leagueName: 'The Sunday League', gw: 1, size: 40, managers, ...over };
  return { ctx: c, mine };
}

test('ownership is counted inside the league, not across the world', () => {
  const { ctx: c, mine } = leagueCtx();
  const e = leagueEdge(c);
  assert.equal(e.covered, 12, 'and it says how many squads that was');
  assert.equal(e.size, 40, 'without pretending to cover the whole league');

  const first = e.squad.find((r) => r.player.id === mine[0]);
  assert.equal(first.owners, 12, 'every rival owns your first player');
  assert.equal(first.share, 100);
  assert.equal(first.edge, Math.round((100 - first.global) * 10) / 10, 'the edge is league share minus global');

  const last = e.squad.find((r) => r.player.id === mine[11]);
  assert.equal(last.owners, 1, 'only one rival owns your twelfth');
});

test('a differential in here is not the same as a differential out there', () => {
  const { ctx: c, mine } = leagueCtx();
  const e = leagueEdge(c);
  assert.ok(e.differentials.length, 'some of yours are rare in this league');
  assert.ok(e.differentials.every((r) => r.owners <= 3), 'a quarter of twelve');
  assert.ok(e.template.every((r) => r.owners >= 9), 'and template means three quarters of it');
  assert.ok(e.squad.every((r) => r.yours), 'the squad list is your squad');
  // Your last three players are owned by nobody in the league.
  assert.ok(e.unique.every((r) => r.owners === 0));
  assert.ok(e.unique.length >= 1, 'and there is at least one');
});

test('what they have that you do not is ranked by how many of them have it', () => {
  const { ctx: c, mine } = leagueCtx();
  const e = leagueEdge(c);
  assert.ok(e.against.length, 'the league holds players you do not');
  assert.ok(e.against.every((r) => !r.yours), 'none of them are yours');
  for (let i = 1; i < e.against.length; i++) {
    assert.ok(e.against[i - 1].owners >= e.against[i].owners, 'most-held first');
  }
});

test('the armband spread is reported, because eight on one is a different week from four on three', () => {
  const { ctx: c, mine } = leagueCtx();
  const e = leagueEdge(c);
  assert.equal(e.captainSpread, 2, 'two different men wore it');
  assert.equal(e.topCaptain.player.id, mine[0]);
  assert.equal(e.topCaptain.captains, 8, 'eight of twelve on the same man');
  assert.equal(e.captains[1].captains, 4);
});

test('no league, no rivals, or empty squads gives nothing rather than a wrong number', () => {
  const plain = buildContext(makeSnapshot());
  assert.equal(leagueEdge(plain), null, 'no rivals fetched');

  const { ctx: c } = leagueCtx();
  c.entry.rivals.managers = [{ entry: 1, team: 'x', manager: 'y', picks: [], captain: null }];
  assert.equal(leagueEdge(c), null, 'a rival with no picks is not a data point');

  const { ctx: d } = leagueCtx();
  selectEntry(d, false);
  assert.equal(leagueEdge(d), null, 'and without your own squad there is nothing to compare');
});

/* ══════════════ FPL's price predictor, read rather than guessed ══════════ */

import { priceOutlook } from '../js/engine.js';

test('progress is FPL’s published figure, not an estimate of ours', () => {
  const p = ctx.players.find((x) => Number.isFinite(x.pricePct));
  assert.ok(p, 'the snapshot carries FPL’s figure');
  assert.equal(p.progress, Math.round(p.pricePct), 'progress is that number, rounded');
  assert.equal(p.progressSource, 'fpl');
});

test('the old owner-relative estimate no longer drives anything', () => {
  // The bug this replaced: net transfers divided by the player's own owner
  // count, so a lightly-owned player crossed the line on a handful of moves.
  // Two players with identical published progress must read identically
  // however different their ownership.
  const a = { ...ctx.players[0], pricePct: 40, owned: 2.5, price_: { net: 140000, ratio: 0.68, band: 'rising' } };
  const b = { ...ctx.players[1], pricePct: 40, owned: 45, price_: { net: 140000, ratio: 0.01, band: 'steady' } };
  const oa = priceOutlook(a), ob = priceOutlook(b);
  assert.equal(oa.pct, ob.pct, 'ownership does not bend the published progress');
  assert.equal(oa.dir, ob.dir);
});

test('a snapshot without the predictor reports no progress rather than a wrong one', () => {
  const snap = makeSnapshot();
  snap.players.forEach((p) => { delete p.pricePct; delete p.priceProj; delete p.priceRate; });
  const old = buildContext(snap);
  const p = old.players[0];
  assert.equal(p.progress, null, 'null, never a fabricated percentage');
  assert.equal(p.progressSource, null);
  const o = priceOutlook(p);
  assert.equal(o.known, false);
  assert.equal(o.pct, null);
  assert.deepEqual(o.projections, [], 'and no forecast is invented either');
  // The honest part survives: net transfers are a fact FPL reports directly.
  assert.equal(o.net, p.net);
});

test('direction comes from the sign, for rises and for falls alike', () => {
  const rise = priceOutlook({ pricePct: 75.2, priceProj: [{ d: 0, pct: 75.2, like: 3 }], net: 5 });
  const fall = priceOutlook({ pricePct: -87.8, priceProj: [{ d: 0, pct: -87.8, like: -4 }], net: -5 });
  assert.equal(rise.dir, 1);
  assert.equal(fall.dir, -1, 'a negative percentage is a fall, not a small rise');
  assert.equal(rise.over, false);
  assert.equal(priceOutlook({ pricePct: 113.3, priceProj: [] }).over, true, 'past 100 is past the threshold');
  assert.equal(priceOutlook({ pricePct: -106, priceProj: [] }).over, true, 'in both directions');
});

test('FPL’s likelihood is glossed but never invented', () => {
  const o = priceOutlook({ pricePct: 113.3, priceProj: [{ d: 0, pct: 113.3, like: 5 }], net: 1 });
  assert.equal(o.likelihood, 5, 'the raw rating travels with the word');
  assert.equal(o.word, 'very likely');
  const quiet = priceOutlook({ pricePct: 10.3, priceProj: [{ d: 0, pct: 10.3, like: 1 }], net: 1 });
  assert.equal(quiet.word, 'unlikely', 'Dedic’s case: 10% progress is not a rise coming');
  const none = priceOutlook({ pricePct: 40, priceProj: [{ d: 0, pct: 40, like: null }], net: 1 });
  assert.equal(none.word, null, 'no rating means no word, not a guessed one');
});

test('the three-night forecast is carried through in order', () => {
  const o = priceOutlook({
    pricePct: 75.2, net: 1,
    priceProj: [{ d: 0, pct: 75.2, like: 3 }, { d: 1, pct: 113.3, like: 5 }, { d: 2, pct: 151.4, like: 5 }],
  });
  assert.deepEqual(o.projections.map((x) => x.day), [0, 1, 2]);
  assert.deepEqual(o.projections.map((x) => x.pct), [75.2, 113.3, 151.4]);
  assert.equal(o.projections[1].dir, 1);
  assert.equal(o.projections[2].word, 'very likely');
  assert.equal(o.word, 'possible', 'the headline word is tonight’s, not the best of the three');
});
