/**
 * Pulls the Fantasy Premier League API and writes a compact snapshot the
 * dashboard can read from the same origin.
 *
 * Runs on a GitHub Actions runner, which has unrestricted internet access,
 * so it gets the whole ~700-player dataset in one go.
 *
 * Output: data/snapshot.json
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The engine is pure and DOM-free, which is exactly why the fetcher can use it:
// the projection recorded in predictions.json is then the same number the page
// will show, computed by the same code, rather than a second implementation
// that could quietly drift from it.
import * as engine from "../js/engine.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://fantasy.premierleague.com/api";
const UA = "Mozilla/5.0 (compatible; fpl-desk/1.0; +https://github.com)";

const FIXTURE_HORIZON = 6; // gameweeks shown in the ticker
const DETAIL_COUNT = 180;  // players we pull full season-by-season history for
const DETAIL_CONCURRENCY = 5; // be a polite guest on someone else's API
const LEAGUE_LIMIT = 8;    // private mini-leagues we pull standings for
const RIVAL_LIMIT = 12;    // squads pulled from your biggest mini-league, once a gameweek

async function get(path) {
  const url = `${API}${path}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status}`);
        // A 404 is an answer, not a failure to get one — a manager who joined
        // the league after this gameweek simply has no picks for it. Retrying
        // four times with backoff turns a dozen of those into two minutes of
        // waiting for a result that will not change. 429 is the exception: that
        // one genuinely means "come back later".
        e.final = res.status >= 400 && res.status < 500 && res.status !== 429;
        throw e;
      }
      return await res.json();
    } catch (err) {
      if (err.final) throw new Error(`${path} failed: ${err.message}`);
      if (attempt === 4) throw new Error(`${path} failed after 4 tries: ${err.message}`);
      const wait = 1500 * attempt;
      console.warn(`  retry ${attempt} for ${path} (${err.message}), waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const num = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

async function loadConfig() {
  try {
    return JSON.parse(await readFile(join(ROOT, "config.json"), "utf8"));
  } catch {
    return { teamId: null };
  }
}

/**
 * The managers to fetch, from either config shape.
 *
 *   { "teams": [ { "name": "Seni", "id": 1234567 }, … ] }   preferred
 *   { "teamId": 1234567 }                                    still works
 *
 * A bare number in the array is accepted too, since that is what people type
 * first. `name` is only a label — the manager's real name comes from the API
 * and is used when no label is given.
 */
function teamList(config) {
  const raw = Array.isArray(config.teams) ? config.teams
    : config.teamId ? [config.teamId] : [];
  return raw
    .map((t) => (typeof t === "object" && t ? t : { id: t }))
    .map((t) => ({ id: Number(t.id), label: t.name || t.label || null }))
    .filter((t) => Number.isFinite(t.id) && t.id > 0);
}

/** Everything about one manager: squad, season history, mini-leagues. */
async function fetchEntry(team, current) {
  const id = team.id;
  try {
    console.log(`Fetching entry ${id}…`);
    const info = await get(`/entry/${id}/`);
    const gw = current ? current.id : 1;
    const picks = await get(`/entry/${id}/event/${gw}/picks/`);
    const history = await get(`/entry/${id}/history/`);

    const manager = `${info.player_first_name} ${info.player_last_name}`.trim();
    const entry = {
      id,
      key: String(id),
      label: team.label || manager || info.name,
      name: info.name,
      manager,
      overallRank: info.summary_overall_rank,
      overallPoints: info.summary_overall_points,
      gwPoints: info.summary_event_points,
      gwRank: info.summary_event_rank,
      bank: (info.last_deadline_bank ?? 0) / 10,
      squadValue: (info.last_deadline_value ?? 0) / 10,
      pickedForGw: gw,
      picks: (picks.picks || []).map((p) => ({
        id: p.element,
        slot: p.position,
        captain: !!p.is_captain,
        vice: !!p.is_vice_captain,
        multiplier: p.multiplier,
      })),
      chipsUsed: (history.chips || []).map((c) => ({ name: c.name, gw: c.event })),
      activeChip: picks.active_chip || null,
      transfersMade: picks.entry_history?.event_transfers ?? 0,
      transferCost: picks.entry_history?.event_transfers_cost ?? 0,
      seasonHistory: (history.current || []).map((h) => ({
        gw: h.event,
        pts: h.points,
        // `rank` has always meant the overall rank here; the gameweek's own
        // rank is new and gets its own name rather than shifting the old one.
        rank: h.overall_rank,
        gwRank: h.rank,
        total: h.total_points,
        value: h.value / 10,
        bank: h.bank / 10,
        transfers: h.event_transfers || 0,
        // The two figures no FPL surface puts in front of you: what the hits
        // cost and what you left on the bench.
        hit: h.event_transfers_cost || 0,
        bench: h.points_on_bench || 0,
      })),
      leagues: [],
    };
    console.log(`  ${entry.name} (${entry.label}) — ${entry.picks.length} picks, rank ${entry.overallRank ?? "n/a"}`);

    // ---- mini-leagues -------------------------------------------------
    // league_type "x" is a league someone created; "s" is a system league
    // (Overall, country, region). Only the created ones get a standings
    // fetch — the global tables are millions deep and the rank alone is
    // the interesting part.
    const classic = (info.leagues && info.leagues.classic) || [];
    const wanted = classic.filter((l) => l.league_type === "x").slice(0, LEAGUE_LIMIT);
    const systemOnly = classic.filter((l) => l.league_type !== "x");

    console.log(`  fetching standings for ${wanted.length} mini-league(s)…`);
    for (const l of wanted) {
      try {
        const st = await get(`/leagues-classic/${l.id}/standings/`);
        const results = (st.standings && st.standings.results) || [];
        entry.leagues.push({
          id: l.id,
          name: l.name,
          type: "private",
          myRank: l.entry_rank ?? null,
          myLastRank: l.entry_last_rank ?? null,
          size: l.rank_count ?? results.length,
          hasMore: !!(st.standings && st.standings.has_next),
          standings: results.slice(0, 25).map((r) => ({
            rank: r.rank,
            lastRank: r.last_rank,
            entry: r.entry,
            team: r.entry_name,
            manager: r.player_name,
            total: r.total,
            gw: r.event_total,
            isMe: r.entry === id,
          })),
        });
      } catch (err) {
        console.warn(`  league ${l.id} failed: ${err.message}`);
      }
    }
    for (const l of systemOnly) {
      entry.leagues.push({
        id: l.id, name: l.name, type: "global",
        myRank: l.entry_rank ?? null, myLastRank: l.entry_last_rank ?? null,
        size: l.rank_count ?? null, hasMore: true, standings: [],
      });
    }
    console.log(`  ${entry.leagues.length} league(s) recorded`);
    return entry;
  } catch (err) {
    // One bad team ID must not cost everyone else their squad, so the failure
    // is recorded against that manager and the loop carries on.
    console.warn(`  entry ${id} failed: ${err.message}`);
    return { id, key: String(id), label: team.label || `Team ${id}`, error: err.message };
  }
}

/**
 * The picks of the managers you are actually playing against.
 *
 * Global ownership tells you what the world holds; it does not tell you what
 * the twelve people above you in your mini-league hold, which is the only
 * ownership that moves your rank in the league you care about.
 *
 * Picks lock at the deadline and cannot change until the next one, so this is
 * fetched ONCE PER GAMEWEEK and reused from the previous snapshot after that.
 * Re-pulling a dozen squads every fifteen minutes through a match window would
 * be a rude way to treat someone else's API for data that cannot have moved.
 */
async function fetchRivals(entry, prevSnapshot, gw) {
  const leagues = (entry.leagues || []).filter((l) => l.type === "private" && l.standings.length > 1);
  if (!leagues.length) return null;
  // The biggest league you are in is the one whose rank you talk about.
  const league = leagues.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0];

  const prevEntry = ((prevSnapshot && prevSnapshot.entries) || [])
    .find((e) => e.id === entry.id);
  const cached = prevEntry && prevEntry.rivals;
  if (cached && cached.gw === gw && cached.leagueId === league.id && cached.managers.length) {
    console.log(`  rivals: reusing GW${gw} picks for ${league.name} (locked since the deadline)`);
    return cached;
  }

  const rows = league.standings.filter((r) => !r.isMe).slice(0, RIVAL_LIMIT);
  console.log(`  rivals: fetching ${rows.length} squads from ${league.name}…`);
  const managers = [];
  for (const r of rows) {
    try {
      const p = await get(`/entry/${r.entry}/event/${gw}/picks/`);
      const picks = (p.picks || []).map((x) => ({
        id: x.element, slot: x.position, multiplier: x.multiplier,
      }));
      const cap = (p.picks || []).find((x) => x.is_captain);
      managers.push({
        entry: r.entry, team: r.team, manager: r.manager, rank: r.rank, total: r.total,
        picks, captain: cap ? cap.element : null, chip: p.active_chip || null,
      });
    } catch (err) {
      // A manager who joined after this gameweek has no picks for it. That is
      // not an error worth failing the run over.
      console.warn(`    ${r.team} (${r.entry}) skipped: ${err.message}`);
    }
  }
  if (!managers.length) return null;
  return { leagueId: league.id, leagueName: league.name, gw, size: league.size, managers };
}

const PREDICTION_MIN_PROJ = 0.05; // below this a player is not really a prediction

/**
 * Record what the page is about to advise, before the deadline it applies to.
 *
 * A tool that tells you who to captain every week and never checks whether it
 * was right is asking to be taken on faith. This writes the projection for
 * every player for the gameweek ahead, plus the specific calls made for each
 * manager and the squad they actually fielded, so that after the round both the
 * model and the advice can be scored against `timeline.json` with no further
 * API calls.
 *
 * The one rule that makes it worth anything: **a gameweek is written only while
 * its deadline is still in the future.** Once the deadline passes the row is
 * locked and later refreshes leave it alone. A "prediction" edited after kickoff
 * is not a prediction, and a calibration built on those would flatter the model
 * exactly where it matters most.
 */
function updatePredictions(prev, snapshot, engine) {
  const log = prev && prev.gws ? prev : { gws: {} };
  const next = snapshot.nextEvent;
  if (!next || !next.deadline) return log;

  const gw = String(next.id);
  const now = new Date();
  const passed = new Date(next.deadline) <= now;
  const existing = log.gws[gw];

  if (passed) {
    if (existing && !existing.locked) {
      existing.locked = true;
      console.log(`  predictions: GW${gw} locked at the deadline`);
    }
    return log;
  }
  if (existing && existing.locked) return log;

  const ctx = engine.buildContext(snapshot, {}, false);
  const rows = [];
  for (const p of ctx.players) {
    const proj = p.proj && p.proj[0];
    if (proj == null || proj < PREDICTION_MIN_PROJ) continue;
    rows.push([p.id, Math.round(proj * 100) / 100]);
  }

  const entries = {};
  for (const e of snapshot.entries || []) {
    if (e.error || !e.picks || !e.picks.length) continue;
    engine.selectEntry(ctx, e.key);
    // The simulator is the slow part and adds nothing to a recorded number, so
    // the recording skips it. The projection it would decorate is identical.
    const a = engine.weeklyAdvice(ctx, { simulate: false });
    if (!a) continue;
    entries[e.key] = {
      captain: a.captain ? a.captain.player.id : null,
      vice: a.vice ? a.vice.player.id : null,
      xi: a.xi.map((p) => p.id),
      expected: a.expectedPoints,
      confidence: a.confidence,
      transfer: a.transfer ? { out: a.transfer.out.id, in: a.transfer.in.id, gain: a.transfer.perGw } : null,
      // What you actually fielded, so the call can be scored against the choice
      // rather than only against the outcome.
      picks: e.picks.map((p) => [p.id, p.slot, p.multiplier]),
      chip: e.activeChip || null,
    };
  }

  log.gws[gw] = {
    at: snapshot.generatedAt,
    deadline: next.deadline,
    locked: false,
    rows,
    entries,
  };
  log.updated = snapshot.generatedAt;
  console.log(`  predictions: GW${gw} recorded — ${rows.length} projections, ` +
    `${Object.keys(entries).length} manager call(s)`);
  return log;
}

async function loadJson(name, fallback) {
  try {
    return JSON.parse(await readFile(join(ROOT, "data", name), "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Diff this refresh against the previous one.
 *
 * Runs here rather than in the browser because the previous snapshot is on disk
 * at this point and about to be overwritten — the client would have no way to
 * see what changed. The output is small enough to commit every few hours.
 */
function buildChanges(prev, players, teams, gw) {
  const empty = {
    generatedAt: new Date().toISOString(), since: null, gw,
    priceRises: [], priceFalls: [], statusChanges: [], formMovers: [], ownershipMovers: [],
  };
  if (!prev || !Array.isArray(prev.players)) return empty;

  const before = new Map(prev.players.map((p) => [p.id, p]));
  const changes = { ...empty, since: prev.generatedAt };
  const label = (p) => ({
    id: p.id, name: p.name, team: (teams.find((t) => t.id === p.team) || {}).short || "",
    pos: p.pos, owned: p.owned,
  });

  for (const p of players) {
    const q = before.get(p.id);
    if (!q) continue;

    if (p.price !== q.price) {
      const row = { ...label(p), from: q.price, to: p.price, delta: round(p.price - q.price, 1) };
      (p.price > q.price ? changes.priceRises : changes.priceFalls).push(row);
    }
    if (p.status !== q.status || (p.news || "") !== (q.news || "")) {
      changes.statusChanges.push({
        ...label(p), from: q.status, to: p.status, news: p.news || "",
        chance: p.chance, worse: rankStatus(p.status) > rankStatus(q.status),
      });
    }
    const dForm = round(p.form - q.form, 1);
    if (Math.abs(dForm) >= 0.8) changes.formMovers.push({ ...label(p), from: q.form, to: p.form, delta: dForm });

    const dOwn = round(p.owned - q.owned, 2);
    if (Math.abs(dOwn) >= 0.4) changes.ownershipMovers.push({ ...label(p), from: q.owned, to: p.owned, delta: dOwn });
  }

  const byOwn = (a, b) => b.owned - a.owned;
  changes.priceRises.sort(byOwn);
  changes.priceFalls.sort(byOwn);
  changes.statusChanges.sort(byOwn);
  changes.formMovers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  changes.ownershipMovers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return changes;
}

/** Availability ordered worst-first so we can tell a downgrade from a recovery. */
function rankStatus(s) {
  return { a: 0, d: 1, s: 2, i: 3, u: 4, n: 5 }[s] ?? 9;
}

/** Keep roughly three weeks of price history: long enough to look back over a
 *  couple of gameweeks, small enough to commit and to fetch on a phone. */
const PRICE_LOG_DAYS = 21;

/**
 * Append-only record of price changes, with WHEN each was noticed.
 *
 * FPL does not publish a timestamp for a price change — the API only ever says
 * what a player costs now. So the only honest timing available is our own: a
 * change happened somewhere between the previous refresh and this one. Every
 * row therefore carries a WINDOW (`after` … `seen`) rather than an instant, and
 * the interface renders it as a window. Narrowing it is a matter of refreshing
 * more often around the nightly change, which the cron now does.
 */
function updatePriceLog(prevLog, prevSnapshot, players, teams, gw, nowIso) {
  const log = prevLog && Array.isArray(prevLog.changes) ? prevLog : { changes: [] };
  const before = prevSnapshot && Array.isArray(prevSnapshot.players)
    ? new Map(prevSnapshot.players.map((p) => [p.id, p]))
    : null;

  if (before) {
    const after = prevSnapshot.generatedAt || null;
    for (const p of players) {
      const q = before.get(p.id);
      if (!q || q.price === p.price) continue;
      const t = teams.find((x) => x.id === p.team);
      log.changes.push({
        id: p.id,
        name: p.name,
        full: p.full,
        team: p.team,
        club: t ? t.short : "",
        pos: p.pos,
        from: q.price,
        to: p.price,
        delta: round(p.price - q.price, 1),
        owned: p.owned,
        gw,
        // the change happened somewhere in (after, seen]
        after,
        seen: nowIso,
      });
    }
  }

  // Trim by age, then by count, so one pathological day cannot bloat the file.
  const cutoff = Date.now() - PRICE_LOG_DAYS * 864e5;
  log.changes = log.changes
    .filter((c) => !c.seen || new Date(c.seen).getTime() >= cutoff)
    .slice(-4000);
  log.updated = nowIso;
  log.days = PRICE_LOG_DAYS;
  return log;
}

/**
 * Append-only time series, one row per player per gameweek. Rewriting the
 * current gameweek's row on each refresh keeps it to 38 rows a season rather
 * than one every three hours.
 */
function updateTimeline(prevTimeline, players, gw) {
  const timeline = prevTimeline && prevTimeline.players ? prevTimeline : { players: {} };
  for (const p of players) {
    const key = String(p.id);
    if (!timeline.players[key]) timeline.players[key] = {};
    // Fourth element is the gameweek's OWN points. It could be differenced out
    // of the running total, but only while no gameweek is ever missing from the
    // series — and a refresh that fails on the one week you needed would give a
    // wrong number rather than no number. Older rows have three elements and
    // still read fine.
    timeline.players[key][String(gw)] = [p.price, p.owned, p.pts, p.gwPts];
  }
  timeline.updated = new Date().toISOString();
  timeline.latestGw = gw;
  return timeline;
}

/**
 * Price-change pressure.
 *
 * FPL moves a player's price once enough net transfers accumulate relative to
 * how many managers own them. The exact threshold is not published, so this is
 * an estimate, not a guarantee — the dashboard labels it as such.
 */
function pricePressure(el, totalPlayers) {
  const owners = Math.max((num(el.selected_by_percent) / 100) * totalPlayers, 1);
  const net = (el.transfers_in_event || 0) - (el.transfers_out_event || 0);
  const ratio = net / owners;
  let band = "steady";
  if (ratio >= 0.075) band = "rising";
  else if (ratio >= 0.04) band = "warm";
  else if (ratio <= -0.075) band = "falling";
  else if (ratio <= -0.04) band = "cooling";
  return { net, ratio: round(ratio, 4), band };
}

/**
 * Fixtures per club per remaining gameweek, for the whole rest of the season.
 *
 * The per-team fixture map only reaches six weeks, which is right for the
 * ticker and useless for chips: blanks and doubles are announced months out and
 * are the entire reason to hold a Free Hit. This is deliberately just counts —
 * twenty clubs by thirty-odd gameweeks of small integers — so it costs almost
 * nothing to carry.
 *
 * A fixture with no `event` is one the FA has pulled and not yet rescheduled.
 * It is counted nowhere, which is exactly right: that is what makes a blank.
 */
function scheduleShape(fixtures, teams, fromEvent) {
  const byTeam = {};
  for (const t of teams) byTeam[t.id] = {};
  let last = fromEvent;
  for (const f of fixtures) {
    if (f.event == null || f.event < fromEvent) continue;
    if (f.event > last) last = f.event;
    for (const id of [f.team_h, f.team_a]) {
      if (!byTeam[id]) continue;
      byTeam[id][f.event] = (byTeam[id][f.event] || 0) + 1;
    }
  }
  return { from: fromEvent, to: last, teams: byTeam };
}

function buildFixtureIndex(fixtures, teams, fromEvent) {
  const byTeam = {};
  for (const t of teams) byTeam[t.id] = [];
  const wanted = new Set();
  for (let g = fromEvent; g < fromEvent + FIXTURE_HORIZON; g++) wanted.add(g);

  for (const f of fixtures) {
    if (f.event == null || !wanted.has(f.event)) continue;
    if (byTeam[f.team_h]) {
      byTeam[f.team_h].push({ gw: f.event, opp: f.team_a, home: true, d: f.team_h_difficulty, ko: f.kickoff_time });
    }
    if (byTeam[f.team_a]) {
      byTeam[f.team_a].push({ gw: f.event, opp: f.team_h, home: false, d: f.team_a_difficulty, ko: f.kickoff_time });
    }
  }
  for (const id of Object.keys(byTeam)) byTeam[id].sort((a, b) => a.gw - b.gw);
  return byTeam;
}

/** Average difficulty over the horizon; doubles count twice, blanks score 3 (neutral). */
function fixtureScore(list, fromEvent, span) {
  let total = 0;
  let counted = 0;
  for (let g = fromEvent; g < fromEvent + span; g++) {
    const games = list.filter((f) => f.gw === g);
    if (!games.length) {
      total += 3;
      counted += 1;
    } else {
      for (const g2 of games) {
        total += g2.d;
        counted += 1;
      }
    }
  }
  return counted ? round(total / counted, 2) : 3;
}

async function main() {
  const config = await loadConfig();
  // read before we overwrite, so the diff has something to compare against
  const prevSnapshot = await loadJson("snapshot.json", null);
  const prevTimeline = await loadJson("timeline.json", null);
  const prevPriceLog = await loadJson("prices.json", null);
  const prevPredictions = await loadJson("predictions.json", null);

  console.log("Fetching bootstrap-static…");
  const boot = await get("/bootstrap-static/");
  console.log(`  ${boot.elements.length} players, ${boot.teams.length} teams`);

  console.log("Fetching fixtures…");
  const fixtures = await get("/fixtures/");
  console.log(`  ${fixtures.length} fixtures`);

  const totalPlayers = boot.total_players || 1;
  const events = boot.events;
  const current = events.find((e) => e.is_current) || null;
  const next = events.find((e) => e.is_next) || events.find((e) => !e.finished) || null;
  const fromEvent = next ? next.id : current ? current.id + 1 : 1;

  const posName = {};
  for (const t of boot.element_types) posName[t.id] = t.singular_name_short; // GKP DEF MID FWD

  const teamById = {};
  const teams = boot.teams.map((t) => {
    const row = {
      id: t.id,
      name: t.name,
      short: t.short_name,
      strength: t.strength,
      atkH: t.strength_attack_home,
      atkA: t.strength_attack_away,
      defH: t.strength_defence_home,
      defA: t.strength_defence_away,
    };
    teamById[t.id] = row;
    return row;
  });

  const fixturesByTeam = buildFixtureIndex(fixtures, boot.teams, fromEvent);

  // ---- live state --------------------------------------------------------
  // Per-fixture status for the gameweek in progress. The refresh cannot be
  // truly live, so the interface stamps how old this is rather than implying
  // it is current to the second.
  const liveGw = current ? current.id : null;
  const liveFixtures = liveGw
    ? fixtures
        .filter((f) => f.event === liveGw)
        .map((f) => ({
          id: f.id,
          h: f.team_h, a: f.team_a,
          kickoff: f.kickoff_time,
          started: !!f.started,
          finished: !!f.finished,
          provisional: !!f.finished_provisional,
          minutes: f.minutes || 0,
          hScore: f.team_h_score, aScore: f.team_a_score,
          // Difficulty for the round in progress. The per-team fixture map
          // only covers the horizon AHEAD, so without these the schedule
          // panel has no ratings for the week actually being played.
          dh: f.team_h_difficulty, da: f.team_a_difficulty,
        }))
        .sort((x, y) => new Date(x.kickoff) - new Date(y.kickoff))
    : [];

  const live = {
    gw: liveGw,
    deadline: current ? current.deadline_time : null,
    finished: current ? !!current.finished : false,
    dataChecked: current ? !!current.data_checked : false,
    fixtures: liveFixtures,
    started: liveFixtures.filter((f) => f.started).length,
    inPlay: liveFixtures.filter((f) => f.started && !f.finished).length,
    total: liveFixtures.length,
    allFinished: liveFixtures.length > 0 && liveFixtures.every((f) => f.finished),
    nextKickoff: (liveFixtures.find((f) => !f.started) || {}).kickoff || null,
  };
  console.log(
    `Live state: GW${live.gw} — ${live.started}/${live.total} started, ${live.inPlay} in play` +
    `${live.allFinished ? ', all finished' : ''}`
  );

  const players = boot.elements.map((el) => {
    const mins = el.minutes || 0;
    const per90 = (v) => (mins > 0 ? round((num(v) * 90) / mins, 3) : 0);
    const teamFix = fixturesByTeam[el.team] || [];

    return {
      id: el.id,
      name: el.web_name,
      full: `${el.first_name} ${el.second_name}`.trim(),
      team: el.team,
      pos: posName[el.element_type] || "?",
      price: el.now_cost / 10,
      priceStart: (el.now_cost - el.cost_change_start) / 10,
      changeEvent: el.cost_change_event / 10,
      status: el.status, // a=available i=injured d=doubtful s=suspended u=unavailable n=not in squad
      news: el.news || "",
      newsAt: el.news_added,
      ict: num(el.ict_index),
      influence: num(el.influence),
      creativity: num(el.creativity),
      threat: num(el.threat),
      chance: el.chance_of_playing_next_round,
      form: num(el.form),
      pts: el.total_points || 0,
      gwPts: el.event_points || 0,
      ppg: num(el.points_per_game),
      epNext: num(el.ep_next),
      owned: num(el.selected_by_percent),
      mins,
      starts: el.starts || 0,
      goals: el.goals_scored || 0,
      assists: el.assists || 0,
      cs: el.clean_sheets || 0,
      saves: el.saves || 0,
      bonus: el.bonus || 0,
      bps: el.bps || 0,
      xG: num(el.expected_goals),
      xA: num(el.expected_assists),
      xGI: num(el.expected_goal_involvements),
      xGC: num(el.expected_goals_conceded),
      xGI90: per90(el.expected_goal_involvements),
      xGC90: per90(el.expected_goals_conceded),
      defCon: el.defensive_contribution || 0,
      // Set-piece duty. FPL publishes the order for each routine and it is the
      // best cheap predictor in the dataset — a first-choice penalty taker at a
      // decent side is worth more than most of the xG columns. 1 = first choice,
      // null = not on the list.
      pens: el.penalties_order,
      fks: el.direct_freekicks_order,
      corners: el.corners_and_indirect_freekicks_order,
      tIn: el.transfers_in_event || 0,
      tOut: el.transfers_out_event || 0,
      price_: pricePressure(el, totalPlayers),
      fdr5: fixtureScore(teamFix, fromEvent, 5),
      fdr3: fixtureScore(teamFix, fromEvent, 3),
    };
  });

  // ---- squads -----------------------------------------------------------
  // One entry per configured manager. The heavy shared data above is fetched
  // once no matter how many people are listed; each extra manager costs three
  // calls plus one per mini-league.
  const entries = [];
  for (const team of teamList(config)) {
    const e = await fetchEntry(team, current);
    if (!e) continue;
    if (!e.error && current) {
      try {
        e.rivals = await fetchRivals(e, prevSnapshot, current.id);
      } catch (err) {
        console.warn(`  rivals for ${e.label} failed: ${err.message}`);
        e.rivals = null;
      }
    }
    entries.push(e);
  }
  if (!teamList(config).length) console.log("No teams in config.json — skipping squads.");

  // Older deployed pages read snapshot.entry. Keeping it pointed at the first
  // manager means a stale cached page degrades to single-team rather than
  // breaking outright.
  const entry = entries[0] || null;
  // ---- per-player history ------------------------------------------------
  // element-summary is one call per player, so we pull it for the squad plus
  // the players most likely to be looked at, rather than all 700.
  // every configured manager's squad, so each of them gets full history
  const squadIds = entries.flatMap((e) => (e.picks || []).map((p) => p.id));
  const ranked = players
    .slice()
    .sort((a, b) => (b.owned * 2 + b.pts) - (a.owned * 2 + a.pts))
    .slice(0, DETAIL_COUNT)
    .map((p) => p.id);
  const detailIds = Array.from(new Set([...squadIds, ...ranked]));

  console.log(`Fetching history for ${detailIds.length} players…`);
  const details = {};
  let done = 0;
  const queue = detailIds.slice();
  await Promise.all(
    Array.from({ length: DETAIL_CONCURRENCY }, async () => {
      while (queue.length) {
        const pid = queue.shift();
        try {
          const d = await get(`/element-summary/${pid}/`);
          details[pid] = {
            past: (d.history_past || []).map((s) => ({
              season: s.season_name,
              pts: s.total_points,
              mins: s.minutes,
              goals: s.goals_scored,
              assists: s.assists,
              cs: s.clean_sheets,
              endCost: s.end_cost / 10,
              startCost: s.start_cost / 10,
            })),
            gws: (d.history || []).map((h) => ({
              gw: h.round,
              pts: h.total_points,
              mins: h.minutes,
              opp: h.opponent_team,
              home: h.was_home,
              bonus: h.bonus,
              value: h.value / 10,
            })),
          };
        } catch (err) {
          console.warn(`  history for ${pid} failed: ${err.message}`);
        }
        done++;
        if (done % 40 === 0) console.log(`  ${done}/${detailIds.length}`);
      }
    })
  );
  console.log(`  got history for ${Object.keys(details).length} players`);

  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(join(ROOT, "data", "details.json"), JSON.stringify(details));
  console.log(`Wrote data/details.json (${Math.round(JSON.stringify(details).length / 1024)} KB)`);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    hasDetails: Object.keys(details).length > 0,
    season: "2026/27",
    totalManagers: totalPlayers,
    currentEvent: current ? { id: current.id, name: current.name, finished: current.finished } : null,
    nextEvent: next
      ? { id: next.id, name: next.name, deadline: next.deadline_time }
      : null,
    live,
    horizonFrom: fromEvent,
    horizon: FIXTURE_HORIZON,
    events: events
      .filter((e) => !e.finished)
      .slice(0, 14)
      .map((e) => ({ id: e.id, name: e.name, deadline: e.deadline_time })),
    // Every round that has been scored, with what the field managed. This is
    // what lets your season chart plot you against the average rather than
    // against nothing.
    eventStats: events
      .filter((e) => e.finished && e.average_entry_score != null)
      .map((e) => ({ id: e.id, average: e.average_entry_score, highest: e.highest_score || null })),
    // How many fixtures each club has in each remaining gameweek. Two is a
    // double, none is a blank, and both are the whole basis of chip timing —
    // so this covers the rest of the season rather than the six-week ticker.
    schedule: scheduleShape(fixtures, boot.teams, fromEvent),
    teams,
    fixtures: fixturesByTeam,
    players,
    entries,
    // kept for older cached pages, which read snapshot.entry
    entry,
  };

  await mkdir(join(ROOT, "data"), { recursive: true });
  const out = join(ROOT, "data", "snapshot.json");
  await writeFile(out, JSON.stringify(snapshot));
  const kb = Math.round((await readFile(out)).length / 1024);
  console.log(`Wrote data/snapshot.json (${kb} KB)`);

  const gwForHistory = current ? current.id : 1;
  const changes = buildChanges(prevSnapshot, players, teams, gwForHistory);
  await writeFile(join(ROOT, "data", "changes.json"), JSON.stringify(changes));
  console.log(
    `Wrote data/changes.json — ${changes.priceRises.length} up, ${changes.priceFalls.length} down, ` +
    `${changes.statusChanges.length} status, ${changes.formMovers.length} form, ${changes.ownershipMovers.length} ownership`
  );

  const priceLog = updatePriceLog(
    prevPriceLog, prevSnapshot, players, teams, gwForHistory, snapshot.generatedAt);
  await writeFile(join(ROOT, "data", "prices.json"), JSON.stringify(priceLog));
  const added = priceLog.changes.filter((c) => c.seen === snapshot.generatedAt).length;
  console.log(`Wrote data/prices.json — ${added} new change(s), ${priceLog.changes.length} kept`);

  const timeline = updateTimeline(prevTimeline, players, gwForHistory);
  await writeFile(join(ROOT, "data", "timeline.json"), JSON.stringify(timeline));
  const tkb = Math.round(JSON.stringify(timeline).length / 1024);
  console.log(`Wrote data/timeline.json (${tkb} KB, through GW${gwForHistory})`);

  const predictions = updatePredictions(prevPredictions, snapshot, engine);
  await writeFile(join(ROOT, "data", "predictions.json"), JSON.stringify(predictions));
  const pkb = Math.round(JSON.stringify(predictions).length / 1024);
  const recorded = Object.keys(predictions.gws || {}).length;
  console.log(`Wrote data/predictions.json (${pkb} KB, ${recorded} gameweek(s) on record)`);

  const flagged = players.filter((p) => p.status !== "a").length;
  const rising = players.filter((p) => p.price_.band === "rising").length;
  const falling = players.filter((p) => p.price_.band === "falling").length;
  console.log(`Summary: ${flagged} flagged, ${rising} near a rise, ${falling} near a fall`);
}

// Awaited at module scope on purpose: importing this file should not resolve
// until the work is done. Without it a test harness that imports the module and
// then reads data/ races the writes and sees the previous run's files.
await main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
