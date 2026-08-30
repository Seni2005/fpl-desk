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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://fantasy.premierleague.com/api";
const UA = "Mozilla/5.0 (compatible; fpl-desk/1.0; +https://github.com)";

const FIXTURE_HORIZON = 6; // gameweeks shown in the ticker
const DETAIL_COUNT = 180;  // players we pull full season-by-season history for
const DETAIL_CONCURRENCY = 5; // be a polite guest on someone else's API
const LEAGUE_LIMIT = 8;    // private mini-leagues we pull standings for

async function get(path) {
  const url = `${API}${path}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
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
        rank: h.overall_rank,
        value: h.value / 10,
        bank: h.bank / 10,
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
    timeline.players[key][String(gw)] = [p.price, p.owned, p.pts];
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
    if (e) entries.push(e);
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
