/**
 * A small, fully deterministic snapshot for the engine tests.
 * Hand-built rather than sampled, so every expected value can be reasoned about.
 */

const TEAMS = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1, name: `Club ${i + 1}`, short: `C${String(i + 1).padStart(2, '0')}`, strength: 3,
}));

/** Difficulty is deterministic: club 1 has the easiest run, club 20 the hardest. */
function fixturesFor(teamId, gws) {
  return gws.map((gw) => ({
    gw,
    opp: (teamId % 20) + 1,
    home: (gw + teamId) % 2 === 0,
    d: 1 + ((teamId + gw) % 5),
    ko: `2026-09-0${(gw % 9) + 1}T14:00:00Z`,
  }));
}

function makeEntry(id, name, manager, order, pts) {
  return {
    id, key: String(id), label: manager, name, manager,
    overallRank: 400000, overallPoints: pts, gwPoints: pts, gwRank: 400000,
    bank: 2.5, squadValue: 99.5, pickedForGw: 1,
    picks: order.map((pid, i) => ({
      id: pid, slot: i + 1, captain: i === 0, vice: i === 1, multiplier: i < 11 ? 1 : 0,
    })),
    chipsUsed: [], activeChip: null, transfersMade: 0, transferCost: 0,
    seasonHistory: [], leagues: [],
  };
}

export function makeSnapshot(opts = {}) {
  const gws = opts.gws || [2, 3, 4, 5, 6, 7];
  const fixtures = {};
  TEAMS.forEach((t) => { fixtures[t.id] = fixturesFor(t.id, gws); });

  const positions = ['GKP', 'DEF', 'MID', 'FWD'];
  const players = [];
  let id = 0;
  for (const pos of positions) {
    const count = pos === 'GKP' ? 40 : 60;
    for (let i = 0; i < count; i++) {
      id++;
      // Club and quality must vary independently. If quality is a function of i
      // with a period dividing 20, every player at a club ends up identical and
      // any controlled comparison becomes impossible.
      const team = (i % 20) + 1;
      const tier = Math.floor(i / 20);              // 0, 1, 2 within each club
      const quality = Math.min(0.95, 0.15 + tier * 0.34 + (i % 5) * 0.02);
      const mins = Math.round(90 * (0.25 + 0.75 * quality));
      players.push({
        id, name: `${pos}${i}`, full: `Test ${pos}${i}`, team, pos,
        price: Math.round((4 + quality * 8) * 10) / 10,
        priceStart: Math.round((4 + quality * 8) * 10) / 10,
        changeEvent: 0,
        // flags at two tiers, so there are both fringe and nailed players
        // carrying each status — otherwise a like-for-like comparison is impossible
        status: i === 3 || i === 43 ? 'i' : i === 5 || i === 45 ? 'd' : i === 7 || i === 47 ? 's' : 'a',
        news: i === 3 || i === 43 ? 'Knee injury' : '',
        chance: i === 5 || i === 45 ? 75 : null,
        form: Math.round(quality * 8 * 10) / 10,
        pts: Math.round(quality * 12),
        gwPts: Math.round(quality * 12),
        ppg: Math.round(quality * 6 * 10) / 10,
        epNext: Math.round(quality * 7 * 10) / 10,
        owned: Math.round(quality * quality * 45 * 10) / 10,
        mins,
        starts: 1,
        goals: Math.round(quality * 3), assists: Math.round(quality * 2),
        cs: 1, saves: pos === 'GKP' ? 4 : 0, bonus: 1, bps: 20,
        xG: Math.round(quality * 1.4 * 100) / 100,
        xA: Math.round(quality * 0.8 * 100) / 100,
        xGI: Math.round(quality * 2.2 * 100) / 100,
        xGC: 1.1,
        xGI90: 0, xGC90: 0,
        defCon: 5,
        tIn: Math.round(quality * 90000), tOut: Math.round((1 - quality) * 60000),
        price_: { net: 0, ratio: (quality - 0.5) * 0.2, band: 'steady' },
        fdr5: 3, fdr3: 3,
      });
    }
  }

  // A squad that is legal by construction: 2/5/5/3 and at most three per club.
  // The club counter is shared across positions — keeping it per-position lets
  // a club appear four times, which is exactly the bug the engine caught.
  const clubs = {};
  const pick = (pos, n) => {
    const out = [];
    for (const p of players) {
      if (p.pos !== pos || p.status !== 'a') continue;
      if ((clubs[p.team] || 0) >= 3) continue;
      clubs[p.team] = (clubs[p.team] || 0) + 1;
      out.push(p.id);
      if (out.length === n) break;
    }
    return out;
  };
  const squadIds = [...pick('GKP', 2), ...pick('DEF', 5), ...pick('MID', 5), ...pick('FWD', 3)];
  // slots 1-11 start, 12-15 bench, ordered GK / DEF / MID / FWD
  const order = [squadIds[0], ...squadIds.slice(2, 6), ...squadIds.slice(7, 11), ...squadIds.slice(12, 14)];
  const bench = squadIds.filter((x) => !order.includes(x));
  const finalOrder = [...order, ...bench];

  // Live block, as the fetcher writes it. `live: 'inplay'` puts matches on the
  // pitch; the default has the round finished and the next deadline ahead.
  const mkFixtures = (started, finished) =>
    Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, h: (i * 2) % 20 + 1, a: (i * 2 + 1) % 20 + 1,
      kickoff: '2026-08-22T14:00:00Z',
      started: i < started, finished: i < finished, provisional: i < finished,
      minutes: i < finished ? 90 : i < started ? 62 : 0,
      hScore: i < started ? 1 : null, aScore: i < started ? 0 : null,
    }));
  const liveMode = opts.live || 'finished';
  const liveFixtures = liveMode === 'inplay' ? mkFixtures(6, 2)
    : liveMode === 'none' ? mkFixtures(0, 0)
    : mkFixtures(10, 10);

  return {
    generatedAt: new Date('2026-08-28T09:00:00Z').toISOString(),
    season: '2026/27',
    totalManagers: 8000000,
    currentEvent: { id: 1, name: 'Gameweek 1', finished: liveMode === 'finished' },
    nextEvent: { id: 2, name: 'Gameweek 2', deadline: '2026-08-28T17:30:00Z' },
    live: {
      gw: 1,
      deadline: '2026-08-21T17:30:00Z',
      finished: liveMode === 'finished',
      dataChecked: liveMode === 'finished',
      fixtures: liveFixtures,
      started: liveFixtures.filter((f) => f.started).length,
      inPlay: liveFixtures.filter((f) => f.started && !f.finished).length,
      total: liveFixtures.length,
      allFinished: liveFixtures.every((f) => f.finished),
      nextKickoff: (liveFixtures.find((f) => !f.started) || {}).kickoff || null,
    },
    horizonFrom: gws[0],
    horizon: gws.length,
    events: gws.map((g) => ({ id: g, name: `Gameweek ${g}`, deadline: '2026-09-01T17:30:00Z' })),
    teams: TEAMS,
    fixtures,
    players,
    // Two managers, so entry selection has something to select between.
    // The second is a deliberate near-duplicate with a different id: the bug
    // to guard against is matching on the wrong field and silently landing on
    // the first entry every time.
    entries: opts.noEntry ? [] : [
      makeEntry(1234567, 'Test Team', 'Tester', finalOrder, 61),
      makeEntry(7654321, 'Other Team', 'Rival', finalOrder.slice().reverse(), 74),
    ],
    entry: opts.noEntry ? null : {
      id: 1234567, name: 'Test Team', manager: 'Tester',
      overallRank: 400000, overallPoints: 61, gwPoints: 61, gwRank: 400000,
      bank: 2.5, squadValue: 99.5, pickedForGw: 1,
      picks: finalOrder.map((pid, i) => ({
        id: pid, slot: i + 1, captain: i === 0, vice: i === 1, multiplier: i < 11 ? 1 : 0,
      })),
      chipsUsed: [], activeChip: null, transfersMade: 0, transferCost: 0,
      seasonHistory: [], leagues: [],
    },
  };
}
