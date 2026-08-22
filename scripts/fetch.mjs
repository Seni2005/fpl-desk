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

  // ---- squad ------------------------------------------------------------
  let entry = null;
  if (config.teamId) {
    try {
      console.log(`Fetching entry ${config.teamId}…`);
      const info = await get(`/entry/${config.teamId}/`);
      const gw = current ? current.id : 1;
      const picks = await get(`/entry/${config.teamId}/event/${gw}/picks/`);
      const history = await get(`/entry/${config.teamId}/history/`);

      entry = {
        id: config.teamId,
        name: info.name,
        manager: `${info.player_first_name} ${info.player_last_name}`.trim(),
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
      console.log(`  ${entry.name} — ${entry.picks.length} picks, rank ${entry.overallRank ?? "n/a"}`);

      // ---- mini-leagues -------------------------------------------------
      // league_type "x" is a league someone created; "s" is a system league
      // (Overall, country, region). Only the created ones get a standings
      // fetch — the global tables are millions deep and the rank alone is
      // the interesting part.
      const classic = (info.leagues && info.leagues.classic) || [];
      const wanted = classic.filter((l) => l.league_type === "x").slice(0, LEAGUE_LIMIT);
      const systemOnly = classic.filter((l) => l.league_type !== "x");

      console.log(`Fetching standings for ${wanted.length} mini-league(s)…`);
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
              isMe: r.entry === Number(config.teamId),
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
    } catch (err) {
      console.warn(`  squad fetch failed: ${err.message}`);
      entry = { error: err.message, id: config.teamId };
    }
  } else {
    console.log("No teamId in config.json — skipping squad.");
  }

  // ---- per-player history ------------------------------------------------
  // element-summary is one call per player, so we pull it for the squad plus
  // the players most likely to be looked at, rather than all 700.
  const squadIds = entry && entry.picks ? entry.picks.map((p) => p.id) : [];
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
    horizonFrom: fromEvent,
    horizon: FIXTURE_HORIZON,
    events: events
      .filter((e) => !e.finished)
      .slice(0, 14)
      .map((e) => ({ id: e.id, name: e.name, deadline: e.deadline_time })),
    teams,
    fixtures: fixturesByTeam,
    players,
    entry,
  };

  await mkdir(join(ROOT, "data"), { recursive: true });
  const out = join(ROOT, "data", "snapshot.json");
  await writeFile(out, JSON.stringify(snapshot));
  const kb = Math.round((await readFile(out)).length / 1024);
  console.log(`Wrote data/snapshot.json (${kb} KB)`);

  const flagged = players.filter((p) => p.status !== "a").length;
  const rising = players.filter((p) => p.price_.band === "rising").length;
  const falling = players.filter((p) => p.price_.band === "falling").length;
  console.log(`Summary: ${flagged} flagged, ${rising} near a rise, ${falling} near a fall`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
