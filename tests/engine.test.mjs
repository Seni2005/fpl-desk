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
