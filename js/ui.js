/**
 * FPL Desk — presentation layer.
 *
 * Everything analytical lives in engine.js. This file only fetches, renders and
 * wires. If a calculation appears here, it belongs in the engine instead.
 */

import {
  buildContext, weeklyAdvice, teamHealth, optimalXI, captainRanking,
  transferAlternatives, evaluatePlan, categorise, fixtureSwings,
  ownershipOpportunity, templateDiff, simulatePlayer,
  gameweekState, playerTraits, CHIPS, matchSchedule,
  FORMATIONS, HIT_COST, FIELD_SIGMA_GW, MAX_PER_CLUB,
} from './engine.js?v=8';

/* ───────────────────────────── helpers ──────────────────────────────── */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const signed = (n, dp = 1) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(dp);
const compact = (n) => {
  if (n == null) return '';
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
  if (a >= 1e4) return Math.round(n / 1e3) + 'k';
  return n.toLocaleString();
};
const ordinal = (n) => {
  if (n == null) return '—';
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n.toLocaleString() + (s[(v - 20) % 10] || s[v] || s[0]);
};

let CTX = null, CHANGES = null, DETAILS = {}, TEAM = new Map();
/** Lifecycle of the round, and which gameweek every recommendation targets. */
let GW = null;
/** Which gameweek the visual sandbox is currently editing. */
let SB_GW = null;

/* ───────────────────────────── prefs ────────────────────────────────── */

const DEFAULTS = {
  mode: 'decision', theme: null, freeTransfers: 1,
  pos: 'ALL', sort: 'overall', dir: -1, maxPrice: 16, hideFlag: true, hideOwned: false, q: '',
  pDir: 'all', pQ: '', pMine: false, pOwned: true, pSort: 'ratio', pDirn: -1,
  activePlan: 'A', plans: null, lastSeen: null,
};
function loadPrefs() { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('fpldesk.prefs') || '{}') }; } catch { return { ...DEFAULTS }; } }
function savePrefs() { try { localStorage.setItem('fpldesk.prefs', JSON.stringify(prefs)); } catch {} }
let prefs = loadPrefs();

function applyTheme() {
  if (prefs.theme) document.documentElement.setAttribute('data-theme', prefs.theme);
  else document.documentElement.removeAttribute('data-theme');
}
function applyMode() {
  document.documentElement.setAttribute('data-mode', prefs.mode);
  $$('#modeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === prefs.mode)));
}

/* ─────────────────────────── shared chips ───────────────────────────── */

const FDR_WORD = { 1: 'very easy', 2: 'easy', 3: 'even', 4: 'tough', 5: 'very tough' };
const fdrClass = (d) => 'f' + Math.min(5, Math.max(1, Math.round(d)));

function fxChip(f) {
  const t = TEAM.get(f.opp) || {}, o = t.short || '?';
  const title = `${t.name || '?'}${f.home ? ' (home)' : ' (away)'} · difficulty ${f.d}, ${FDR_WORD[f.d] || ''}`;
  return `<span class="fx ${fdrClass(f.d)}" title="${esc(title)}">${f.home ? o : o.toLowerCase()}<small>${f.d}</small></span>`;
}
function gwChip(fixture) {
  if (!fixture || fixture.blank) return '<span class="fx f3" title="Blank gameweek">–</span>';
  return fixture.games.map(fxChip).join('');
}
function statusTag(p) {
  if (p.status === 'a') return '';
  if (p.status === 's') return '<span class="tag susp">ban</span>';
  if (p.status === 'd') return `<span class="tag doubt">${p.chance != null ? p.chance + '%' : 'doubt'}</span>`;
  return '<span class="tag out">out</span>';
}
const CAT_LABEL = { buy: 'Buy', hold: 'Hold', monitor: 'Monitor', sell: 'Sell' };
function catTag(p) {
  const c = categorise(p);
  return `<span class="tag cat-${c.tag}" title="${esc(c.why)}">${CAT_LABEL[c.tag]}</span>`;
}

/* club kits, drawn as plain jerseys — no club marks are used */
const KIT = {
  1: { b: '#EF0107', s: '#FFFFFF' }, 2: { b: '#670E36', s: '#95BFE5' },
  3: { b: '#DA291C', s: '#000000', st: 1 }, 4: { b: '#E30613', s: '#FFFFFF', st: 1 },
  5: { b: '#0057B8', s: '#FFFFFF', st: 1 }, 6: { b: '#034694', s: '#034694' },
  7: { b: '#7ACBF0', s: '#FFFFFF' }, 8: { b: '#1B458F', s: '#C4122E', st: 1 },
  9: { b: '#003399', s: '#003399' }, 10: { b: '#FFFFFF', s: '#000000' },
  11: { b: '#F5A12D', s: '#000000', st: 1 }, 12: { b: '#0044A9', s: '#FFFFFF' },
  13: { b: '#FFFFFF', s: '#1D428A' }, 14: { b: '#C8102E', s: '#C8102E' },
  15: { b: '#6CABDD', s: '#FFFFFF' }, 16: { b: '#DA291C', s: '#DA291C' },
  17: { b: '#241F20', s: '#FFFFFF', st: 1 }, 18: { b: '#DD0000', s: '#DD0000' },
  19: { b: '#FFFFFF', s: '#132257' }, 20: { b: '#EB172B', s: '#FFFFFF', st: 1 },
};
let kitSeq = 0;
function kit(teamId, w) {
  const k = KIT[teamId] || { b: '#8892a6', s: '#ffffff' };
  const h = Math.round(w * 1.05), id = 'k' + (++kitSeq);
  let stripes = '';
  if (k.st) for (let i = 0; i < 4; i++) stripes += `<rect x="${10 + i * 5}" y="4" width="2.6" height="38" fill="${k.s}"/>`;
  return `<svg class="kit" width="${w}" height="${h}" viewBox="0 0 40 42" aria-hidden="true">` +
    `<defs><clipPath id="${id}"><path d="M10 8 L10 40 Q20 42 30 40 L30 8 Z"/></clipPath></defs>` +
    `<path d="M14 3 L5 7 L1.5 17 L8.5 20 L10 16 L10 40 Q20 42 30 40 L30 16 L31.5 20 L38.5 17 L35 7 L26 3 Q20 8.5 14 3 Z" fill="${k.b}" stroke="rgba(0,0,0,.3)" stroke-width="1"/>` +
    `<g clip-path="url(#${id})">${stripes}</g>` +
    `<path d="M14 3 L5 7 L1.5 17 L8.5 20 L10 16" fill="${k.s}" stroke="rgba(0,0,0,.3)" stroke-width="1"/>` +
    `<path d="M26 3 L35 7 L38.5 17 L31.5 20 L30 16" fill="${k.s}" stroke="rgba(0,0,0,.3)" stroke-width="1"/>` +
    `<path d="M14 3 Q20 8.5 26 3" fill="none" stroke="rgba(0,0,0,.32)" stroke-width="1.2"/></svg>`;
}

/* ─────────────────────── masthead & headline run ────────────────────── */

function renderHeader() {
  const S = CTX.snapshot, ne = S.nextEvent;
  if (ne) {
    const d = new Date(ne.deadline);
    $('#eyebrow').textContent = 'Next deadline · ' + ne.name;
    $('#deadline').textContent = d.toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    $('#deadlineSub').textContent =
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + ' your time  /  ' +
      d.toLocaleString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' }) + ' UTC';
    const t = d.getTime();
    tick(t); setInterval(() => tick(t), 30000);
  } else {
    $('#eyebrow').textContent = 'Season';
    $('#deadline').textContent = 'No upcoming deadline';
    $('#cd').textContent = '—';
  }

  const flagged = CTX.players.filter((p) => p.status !== 'a' && p.owned >= 1).length;
  const rising = CTX.players.filter((p) => p.progress >= 100).length;
  const falling = CTX.players.filter((p) => p.progress <= -100).length;
  const cells = [];
  if (S.currentEvent) cells.push(['Gameweek', S.currentEvent.name.replace('Gameweek ', '') +
    ` <small>${S.currentEvent.finished ? 'final' : 'live'}</small>`]);
  if (CTX.entry) {
    cells.push(['Overall rank', compact(CTX.entry.overallRank)]);
    cells.push(['Points', `${CTX.entry.overallPoints} <small>${CTX.entry.gwPoints} this GW</small>`]);
    cells.push(['Bank', `£${CTX.entry.bank.toFixed(1)} <small>squad £${CTX.entry.squadValue.toFixed(1)}</small>`]);
  }
  cells.push(['Flagged', `${flagged} <small>1%+ owned</small>`]);
  cells.push(['Changes due', `${rising} up <small>${falling} down</small>`]);
  $('#run').innerHTML = cells.map((c) => `<div><span class="lab">${esc(c[0])}</span><b>${c[1]}</b></div>`).join('');
}
function tick(target) {
  const el = $('#cd'), diff = target - Date.now();
  if (diff <= 0) { el.textContent = 'closed'; return; }
  const d = Math.floor(diff / 864e5), h = Math.floor((diff % 864e5) / 36e5), m = Math.floor((diff % 36e5) / 6e4);
  el.textContent = d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
}

/* ═════════════════ gameweek lifecycle & live status ══════════════════ */

/** How fresh the data is. Said plainly, because the refresh is not live. */
function freshness() {
  if (!GW || GW.ageMin == null) return '';
  const m = GW.ageMin;
  const when = m < 1 ? 'moments ago' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)}h ago`;
  return `updated ${when}`;
}

function renderGwBanner() {
  const bar = $('#gwbar');
  if (!GW) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.className = 'gwbar ' + GW.phase;
  bar.innerHTML =
    '<i class="gwdot"></i>' +
    `<span class="gwstate">${GW.phase === 'live' ? '● ' + esc(GW.headline) : esc(GW.headline)}</span>` +
    `<span class="gwdetail">${esc(GW.detail)}</span>` +
    `<span class="gwage">${esc(freshness())}</span>`;
}

/** The label that pins a recommendation to the gameweek it applies to. */
function scopeTag(gw) {
  return gw ? `<span class="scope">for GW${gw}</span>` : '';
}

/**
 * The score bug. During a live round it leads with the running total; between
 * rounds that number is history, so the bank and the deadline lead instead.
 */
function renderScoreBug() {
  const el = $('#scorebug');
  const e = CTX.entry;
  if (!e || !CTX.squad.length) { el.innerHTML = ''; return; }
  const phase = GW ? GW.phase : 'upcoming';

  const sides = [];
  if (phase === 'live') {
    sides.push(['Played', `${GW.started}/${GW.total}`]);
    if (GW.inPlay) sides.push(['In play', String(GW.inPlay)]);
  } else if (phase === 'settled' && GW.deadlineText) {
    sides.push([`GW${GW.targetGw} deadline`, GW.deadlineText]);
  }
  sides.push(['Overall rank', compact(e.overallRank)]);
  sides.push(['Season', String(e.overallPoints)]);
  sides.push(['Bank', `£${e.bank.toFixed(1)}`]);

  // Before a ball is kicked the gameweek total is zero and means nothing, so
  // the bug leads with the squad's own value instead of a placeholder score.
  const lead = phase === 'upcoming'
    ? { lab: `GW${GW ? GW.targetGw : ''} squad value`, val: `£${(e.squadValue || 0).toFixed(1)}` }
    : { lab: `GW${GW.scoresGw} ${phase === 'live' ? 'live' : 'final'}`, val: String(e.gwPoints) };

  el.innerHTML =
    `<div class="scorebug${phase === 'live' ? ' islive' : ''}">` +
      '<div class="bug-main">' +
        `<span class="lab">${esc(lead.lab)}</span>` +
        `<b>${esc(lead.val)}</b>` +
      '</div>' +
      '<div class="bug-side">' +
        sides.map(([k, v]) => `<div><span class="lab">${esc(k)}</span><b>${v}</b></div>`).join('') +
      '</div>' +
    '</div>';
}

/* ─────────────────────────── status badges ──────────────────────────── */

/** Badge row. Each badge keeps the number it was derived from. */
function badgeRow(traits, opts = {}) {
  if (!traits || !traits.length) return '';
  const max = opts.limit || traits.length;
  return '<div class="badges">' + traits.slice(0, max).map((t) =>
    `<span class="bdg ${t.tone}" title="${esc(t.label + ' — ' + t.raw)}">` +
    `<i>${t.icon}</i>${esc(t.label)}<span class="raw">${esc(t.raw)}</span></span>`).join('') + '</div>';
}

/* ══════════════════ EPIC 1 — the decision dashboard ══════════════════ */

let ADVICE = null;

function renderDashboard() {
  if (!CTX.squad.length) { $('#thisweek').hidden = true; return; }
  $('#thisweek').hidden = false;
  ADVICE = weeklyAdvice(CTX, { freeTransfers: prefs.freeTransfers, simulate: true });
  if (!ADVICE) { $('#thisweek').hidden = true; return; }

  renderHeadline(ADVICE);
  renderHealth(ADVICE.health);
  renderAnswers(ADVICE);
}

function renderHeadline(a) {
  const h = a.headline;
  const players = h.players && h.players.length
    ? `<div class="hl-players">${h.players.slice(0, 5).map((p) =>
        `<button class="chipbtn" data-pid="${p.id}">${esc(p.name)} <span>£${p.price.toFixed(1)}</span></button>`).join('')}</div>`
    : '';
  $('#headline').innerHTML =
    `<span class="lab">${h.kind === 'ok' ? 'Where the margin is' : 'Your biggest problem'}</span>` +
    `<p class="hl-text">${esc(h.text)}</p>${players}`;
}

function renderHealth(health) {
  if (!health) { $('#health').hidden = true; return; }
  $('#health').hidden = false;
  const band = health.score >= 75 ? 'good' : health.score >= 55 ? 'ok' : 'bad';
  $('#health').innerHTML =
    `<div class="hs-num"><span class="lab">Team health</span><b class="${band}">${health.score}</b><span class="of">/100</span></div>` +
    `<div class="hs-bars">` +
    health.components.map((c) => {
      const w = Math.round(c.score);
      const cls = c.score >= 70 ? 'good' : c.score >= 45 ? 'ok' : 'bad';
      return `<div class="hs-row" title="${esc(c.detail)}">` +
        `<span class="hs-k">${esc(c.key)}</span>` +
        `<span class="hs-t"><i class="${cls}" style="width:${w}%"></i></span>` +
        `<span class="hs-v">${w}</span></div>`;
    }).join('') + `</div>` +
    `<p class="hs-weak"><span class="lab">Main weakness</span> ${esc(health.weakness.key)} — ${esc(health.weakness.detail)}.</p>`;
}

/** Each row is a question the week actually poses, with the evidence folded away. */
function renderAnswers(a) {
  const cap = a.captain, vice = a.vice;
  const rows = [];

  rows.push({
    q: 'Start', wide: true, a: `${a.formation}`,
    detail: a.xi.map((p) => `<button class="chipbtn" data-pid="${p.id}">${esc(p.name)}</button>`).join(''),
    why: `Highest-projecting legal XI of the eight formations. Together they project ` +
         `${a.xi.reduce((s, p) => s + p.proj[0], 0).toFixed(1)} points before the captain's double.`,
    raw: a.xi.map((p) => `${esc(p.name)} ${p.proj[0].toFixed(2)}`).join(' · '),
  });

  if (cap) {
    const imp = cap.impact;
    rows.push({
      q: 'Captain', a: `👑 ${esc(cap.player.name)}`,
      badges: badgeRow(cap.player.traits, { limit: 3 }),
      raw: `xPts ${cap.xPts.toFixed(2)} · proj ${cap.player.proj[0].toFixed(2)} · xGI/90 ${cap.xGI90.toFixed(2)} · ` +
           `minutes ${cap.minutes}% · EO ${cap.eo.toFixed(1)}%` +
           (cap.sim ? ` · haul ${(cap.sim.pHaul * 100).toFixed(0)}% · blank ${(cap.sim.pBlank * 100).toFixed(0)}%` : ''),
      detail: `<span class="ans-sub">${cap.xPts.toFixed(1)} xPts · ${cap.profile.toLowerCase()} · ${cap.eo.toFixed(1)}% effective ownership</span>`,
      why: `Projects ${(cap.player.proj[0]).toFixed(2)} before doubling. ${cap.minutes}% projected minutes, ` +
           `${cap.xGI90.toFixed(2)} xGI/90.` +
           (cap.sim ? ` Simulated ${(cap.sim.pHaul * 100).toFixed(0)}% chance of ten or more, ` +
             `${(cap.sim.pBlank * 100).toFixed(0)}% chance of a blank.` : '') +
           (imp ? `<br><span class="assume">Rank impact against the field: median ${signed(imp.rank.p50, 0)} places, ` +
             `${signed(imp.rank.p25, 0)} at the 25th percentile, ${signed(imp.rank.p75, 0)} at the 75th. ` +
             `Assumes manager totals are normally distributed with a ${FIELD_SIGMA_GW}-point single-gameweek spread, ` +
             `and estimates captaincy share from ownership — neither is published by FPL.</span>` : ''),
    });
  }
  if (vice) rows.push({ q: 'Vice', a: esc(vice.player.name),
    badges: badgeRow(vice.player.traits, { limit: 2 }),
    raw: `xPts ${vice.xPts.toFixed(2)} · minutes ${vice.minutes}% · EO ${vice.eo.toFixed(1)}%`,
    detail: `<span class="ans-sub">${vice.xPts.toFixed(1)} xPts if the captain does not play</span>`, why: '' });

  rows.push({
    q: 'Bench', a: a.bench.map((p, i) => `${i + 1}. ${p.name}`).join('  '),
    detail: '', raw: a.bench.map((p) => `${esc(p.name)} ${p.proj[0].toFixed(2)}`).join(' · '),
    why: 'Reserve keeper first, then the outfield three by projected points — the order they would come on.',
  });

  if (a.transfer) {
    const t = a.transfer;
    rows.push({
      q: 'Transfer', a: `${esc(t.out.name)} → ${esc(t.in.name)}`,
      detail: `<span class="ans-sub">${signed(t.horizonGain)} pts over ${CTX.gws.length} GW · ` +
              `${t.spend > 0 ? `costs £${t.spend.toFixed(1)}m` : t.spend < 0 ? `frees £${Math.abs(t.spend).toFixed(1)}m` : 'no cost'}</span>`,
      badges: badgeRow(t.in.traits, { limit: 3 }),
      raw: `out ${esc(t.out.name)} ${t.out.scores.overall.toFixed(2)}/GW · in ${esc(t.in.name)} ${t.in.scores.overall.toFixed(2)}/GW · ` +
           `short ${t.in.scores.short.toFixed(2)} · long ${t.in.scores.long.toFixed(2)} · value ${t.in.scores.value.toFixed(2)}`,
      why: `${esc(t.in.name)} is the best available upgrade: ${esc(t.reason)}. ` +
           `Gain of ${signed(t.perGw, 2)} points per gameweek, ${signed(t.horizonGain)} across the horizon` +
           (a.hit ? `, against a ${a.hit}-point hit.` : ' with a free transfer.'),
    });
    rows.push({ q: 'Expected points', a: a.expectedPoints.toFixed(1), detail: '<span class="ans-sub">best XI plus the captain double</span>', why: '' });
    rows.push({ q: 'Potential hit', a: a.hit ? `−${a.hit}` : '0', detail: `<span class="ans-sub">${prefs.freeTransfers} free transfer${prefs.freeTransfers === 1 ? '' : 's'}</span>`, why: '' });
    rows.push({
      q: 'Confidence', a: a.confidence,
      detail: `<span class="ans-sub">net ${signed(a.worthIt)} after the hit</span>`,
      why: `High above six points of net gain, moderate above two and a half, low below that. ` +
           `A low reading usually means rolling the transfer is the better play.`,
    });
  } else {
    rows.push({ q: 'Transfer', a: 'Roll it', detail: '<span class="ans-sub">nothing clears the bar this week</span>', why: 'No available upgrade projects enough gain to be worth making.' });
  }

  if (a.risk) rows.push({ q: 'Biggest risk', scope: false, a: esc(a.risk.text),
    badges: badgeRow(a.risk.p.traits, { limit: 2 }),
    detail: `<span class="ans-sub">${a.risk.kind}</span>`, why: '' });

  $('#answers').innerHTML = rows.map((r, i) => `
    <div class="ans${r.wide ? ' wide' : ''}">
      <div class="ans-q lab">${esc(r.q)}${r.scope === false ? '' : scopeTag(GW ? GW.targetGw : null)}</div>
      <div class="ans-a">${r.a}${r.detail ? `<div class="ans-d">${r.detail}</div>` : ''}${r.badges || ''}</div>
      ${r.why ? `<button class="whybtn" aria-expanded="false" data-why="${i}">Why?</button>
        <div class="why" id="why${i}" hidden>${r.why}</div>` : '<span></span>'}
      ${r.raw ? `<div class="raw-block raw">${r.raw}</div>` : ''}
    </div>`).join('');

  $$('#answers .whybtn').forEach((b) => b.addEventListener('click', () => {
    const box = $('#why' + b.dataset.why);
    const open = box.hidden;
    box.hidden = !open;
    b.setAttribute('aria-expanded', String(open));
    b.textContent = open ? 'Hide' : 'Why?';
  }));
}

/* ══════════════════ EPIC 1 — what changed ═══════════════════════════ */

function renderChanges() {
  if (!CHANGES) { $('#changed').hidden = true; return; }
  const seen = prefs.lastSeen;
  const groups = [
    { key: 'priceRises', title: 'Price rises', fmt: (r) => `£${r.from.toFixed(1)} → £${r.to.toFixed(1)}`, cls: 'u' },
    { key: 'priceFalls', title: 'Price falls', fmt: (r) => `£${r.from.toFixed(1)} → £${r.to.toFixed(1)}`, cls: 'd' },
    { key: 'statusChanges', title: 'Availability', fmt: (r) => esc(r.news || (r.to === 'a' ? 'back available' : 'flagged')), cls: (r) => (r.worse ? 'd' : 'u') },
    { key: 'formMovers', title: 'Form swings', fmt: (r) => `${r.from.toFixed(1)} → ${r.to.toFixed(1)}`, cls: (r) => (r.delta > 0 ? 'u' : 'd') },
    { key: 'ownershipMovers', title: 'Ownership swings', fmt: (r) => `${r.from.toFixed(1)}% → ${r.to.toFixed(1)}%`, cls: (r) => (r.delta > 0 ? 'u' : 'd') },
  ];
  const total = groups.reduce((s, g) => s + (CHANGES[g.key] || []).length, 0);
  if (!total) { $('#changed').hidden = true; return; }
  $('#changed').hidden = false;

  const mine = new Set(CTX.squad.map((s) => s.id));
  $('#changedNote').textContent = CHANGES.since
    ? `since ${new Date(CHANGES.since).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` +
      (seen ? '' : ' · first visit')
    : 'first refresh';

  $('#changedBody').innerHTML = groups.filter((g) => (CHANGES[g.key] || []).length).map((g) => {
    const rows = CHANGES[g.key].slice(0, 10);
    return `<div class="chg"><span class="lab">${g.title} <i>${CHANGES[g.key].length}</i></span><ul>` +
      rows.map((r) => {
        const cls = typeof g.cls === 'function' ? g.cls(r) : g.cls;
        return `<li${mine.has(r.id) ? ' class="own"' : ''} title="${esc(r.name + ' — ' + g.fmt(r).replace(/<[^>]+>/g, ''))}">` +
          `<span class="badge">${esc(r.team)}</span>` +
          `<span class="who" data-pid="${r.id}">${esc(r.name)}</span>` +
          (mine.has(r.id) ? '<span class="tag mine">yours</span>' : '') +
          `<span class="chg-v ${cls}">${g.fmt(r)}</span></li>`;
      }).join('') + '</ul></div>';
  }).join('');

  prefs.lastSeen = CHANGES.generatedAt;
  savePrefs();
}

/* ══════════════════ EPIC 2 — multi-week planner ═════════════════════ */

function blankPlans() {
  return { A: { name: 'Plan A', weeks: [] }, B: { name: 'Plan B', weeks: [] } };
}
function getPlans() {
  if (!prefs.plans || !prefs.plans.A) prefs.plans = blankPlans();
  return prefs.plans;
}

function renderPlanner() {
  if (!CTX.squad.length) { $('#planner').hidden = true; return; }
  $('#planner').hidden = false;
  const plans = getPlans();
  const active = prefs.activePlan;
  const evalA = evaluatePlan(plans.A, CTX, { freeTransfers: 1, startingFree: prefs.freeTransfers });
  const evalB = evaluatePlan(plans.B, CTX, { freeTransfers: 1, startingFree: prefs.freeTransfers });
  const res = active === 'A' ? evalA : evalB;

  $('#planCompare').innerHTML =
    `<div class="cmp">` +
    [['A', evalA], ['B', evalB]].map(([k, e]) => {
      const win = evalA.net !== evalB.net && ((k === 'A') === (evalA.net > evalB.net));
      return `<button class="cmp-col${k === active ? ' on' : ''}${win ? ' win' : ''}" data-plan="${k}">` +
        `<span class="lab">Plan ${k}</span>` +
        `<b>${e.net.toFixed(1)}</b>` +
        `<span class="cmp-sub">${e.points.toFixed(1)} pts${e.hits ? ` − ${e.hits} hit` : ''} · ` +
        `${e.weeks.reduce((s, w) => s + w.transfers.length, 0)} transfer${e.weeks.reduce((s, w) => s + w.transfers.length, 0) === 1 ? '' : 's'}</span></button>`;
    }).join('') +
    `<div class="cmp-delta"><span class="lab">Difference</span><b class="${evalA.net > evalB.net ? 'u' : evalA.net < evalB.net ? 'd' : ''}">` +
    `${signed(evalA.net - evalB.net)}</b><span class="cmp-sub">Plan A versus Plan B over ${CTX.gws.length} gameweeks</span></div>` +
    `</div>`;

  $('#planProblems').innerHTML = [...new Set(res.problems)]
    .map((t) => `<div class="plwarn"><span>${esc(t)}</span></div>`).join('');

  $('#planWeeks').innerHTML = res.weeks.map((w) => {
    const moves = w.transfers.map((t) => {
      const o = CTX.byId.get(t.out), i = CTX.byId.get(t.in);
      if (!o || !i) return '';
      return `<div class="mv"><span class="who" data-pid="${o.id}">${esc(o.name)}</span>` +
        `<span class="arrow">→</span><span class="who" data-pid="${i.id}">${esc(i.name)}</span>` +
        `<span class="mv-cost">${signed(i.price - o.price)}m</span>` +
        `<button class="btn tiny" data-undo="${w.gw}|${t.out}">Remove</button></div>`;
    }).join('');
    const chip = w.chip && CHIPS[w.chip]
      ? `<span class="wk-chip">${CHIPS[w.chip].icon} ${CHIPS[w.chip].name}</span>` : '';
    return `<div class="wk">
      <div class="wk-h"><span class="wk-gw">GW${w.gw}</span>
        <span class="wk-pts">${w.points.toFixed(1)} pts</span>
        ${w.hit ? `<span class="wk-hit">−${w.hit}</span>` : ''}
        ${chip}
        <span class="wk-form">${w.benchCounted ? 'all 15' : (w.formation || '')}</span>
        ${w.captainMultiplier > 2 ? '<span class="wk-form">captain ×3</span>' : ''}
        <span class="wk-bank">£${w.bank.toFixed(1)}</span>
        <button class="btn tiny" data-addgw="${w.gw}">Add transfer</button></div>
      ${moves || '<div class="wk-none">no transfers</div>'}
    </div>`;
  }).join('');

  $$('#planCompare [data-plan]').forEach((b) => b.addEventListener('click', () => {
    prefs.activePlan = b.dataset.plan; savePrefs(); renderPlanner();
  }));
  $$('#planWeeks [data-addgw]').forEach((b) => b.addEventListener('click', () => {
    SB_GW = Number(b.dataset.addgw);
    renderPlanner();
    $('#sandbox').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }));
  $$('#planWeeks [data-undo]').forEach((b) => b.addEventListener('click', () => {
    const [gw, out] = b.dataset.undo.split('|').map(Number);
    const plan = getPlans()[prefs.activePlan];
    const wk = plan.weeks.find((w) => w.gw === gw);
    if (wk) wk.transfers = wk.transfers.filter((t) => t.out !== out);
    savePrefs(); renderPlanner();
  }));
  renderSandbox(res);
  $('#planReset').disabled = res.weeks.every((w) => !w.transfers.length && !w.chip);
}

/* ══════════ EPIC 4 — visual sandbox, chips and onboarding ═══════════ */

/**
 * The pitch you can experiment on. It shows the squad as it would stand in the
 * selected gameweek, including anything already staged, and tapping a player
 * opens the replacement list for that week. The bank above updates as you go.
 */
function renderSandbox(evaluated) {
  const box = $('#sandbox');
  if (!CTX.squad.length) { box.hidden = true; return; }
  box.hidden = false;

  const plan = getPlans()[prefs.activePlan];
  if (SB_GW == null || !CTX.gws.includes(SB_GW)) SB_GW = CTX.gws[0];
  const idx = CTX.gws.indexOf(SB_GW);
  const week = evaluated.weeks.find((w) => w.gw === SB_GW);

  $('#sbGws').innerHTML = CTX.gws.map((g) => {
    const wk = (plan.weeks || []).find((w) => w.gw === g);
    const moves = wk && wk.transfers ? wk.transfers.length : 0;
    return `<button data-sbgw="${g}" aria-pressed="${g === SB_GW}"` +
      `${wk && wk.chip ? ' class="haschip"' : ''} title="GW${g}${moves ? ` · ${moves} transfer${moves === 1 ? '' : 's'}` : ''}">GW${g}</button>`;
  }).join('');

  const bank = week ? week.bank : (CTX.entry ? CTX.entry.bank : 0);
  $('#sbBank').textContent = `£${bank.toFixed(1)}m`;
  $('#sbBank').className = bank < 0 ? 'd' : bank > 0 ? 'u' : '';

  const staged = new Set();
  const wkNow = (plan.weeks || []).find((w) => w.gw === SB_GW);
  if (wkNow) wkNow.transfers.forEach((t) => staged.add(t.in));

  const players = (week ? week.squad : CTX.squad.map((s) => s.id)).map((id) => CTX.byId.get(id)).filter(Boolean);
  const best = optimalXI(players, idx);
  const lines = { GKP: [], DEF: [], MID: [], FWD: [] };
  if (best) best.xi.forEach((p) => lines[p.pos].push(p));

  const opts = (p) => ({ swappable: true, staged: staged.has(p.id), gw: SB_GW, projIdx: idx });
  let html = `<div class="pitch"><span class="shape">${best ? best.formation : ''}</span>`;
  ['GKP', 'DEF', 'MID', 'FWD'].forEach((pos) => {
    if (lines[pos].length) html += `<div class="line">${lines[pos].map((p) => manCard(p, null, opts(p))).join('')}</div>`;
  });
  html += '</div><div class="bench"><span class="lab">Bench</span><div class="line">' +
    (best ? best.bench.map((p) => manCard(p, null, opts(p))).join('') : '') + '</div></div>';
  $('#sbPitch').innerHTML = html;

  const moves = wkNow && wkNow.transfers ? wkNow.transfers.length : 0;
  $('#sbHint').innerHTML =
    `Tap any player to swap him out of your GW${SB_GW} squad. ` +
    (moves ? `<b>${moves} transfer${moves === 1 ? '' : 's'} staged.</b> ` : '') +
    `<button class="linkbtn" id="coachOpen">How this works</button>`;

  // chips: one of each, and only in one gameweek
  const usedElsewhere = {};
  (plan.weeks || []).forEach((w) => { if (w.chip && w.gw !== SB_GW) usedElsewhere[w.chip] = w.gw; });
  $('#sbChips').innerHTML = Object.values(CHIPS).map((c) => {
    const on = wkNow && wkNow.chip === c.key;
    const blockedIn = usedElsewhere[c.key];
    return `<button class="chip" data-chip="${c.key}" aria-pressed="${on}"` +
      `${blockedIn ? ' disabled' : ''} title="${esc(c.blurb)}">` +
      `<i>${c.icon}</i>${esc(c.name)}` +
      (blockedIn ? `<small>GW${blockedIn}</small>` : on ? '<small>on</small>' : '') + '</button>';
  }).join('');

  $$('#sbGws [data-sbgw]').forEach((b) => b.addEventListener('click', () => {
    SB_GW = Number(b.dataset.sbgw); renderPlanner();
  }));
  $$('#sbPitch [data-swapout]').forEach((b) => b.addEventListener('click', () => {
    openReplacements(Number(b.dataset.swapout), SB_GW);
  }));
  $$('#sbChips [data-chip]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.chip;
    const pl = getPlans()[prefs.activePlan];
    let wk = pl.weeks.find((w) => w.gw === SB_GW);
    if (!wk) { wk = { gw: SB_GW, transfers: [] }; pl.weeks.push(wk); pl.weeks.sort((x, y) => x.gw - y.gw); }
    wk.chip = wk.chip === key ? null : key;
    savePrefs(); renderPlanner();
  }));
  const co = $('#coachOpen');
  if (co) co.addEventListener('click', () => openCoach(0));
}

/* ── guided walkthrough ── */
const COACH = [
  { t: 'Try transfers without committing', b: 'The planner is a sandbox. Nothing here touches your real team — it works out what a set of moves would be worth so you can compare before you commit.' },
  { t: 'Pick a gameweek, then tap a player', b: 'Choose the gameweek you want to edit, then tap anyone on the pitch. You will get a ranked list of replacements you can actually afford, each with the reason it beat the others. The bank above updates as you stage moves.' },
  { t: 'Play a chip and watch it recalculate', b: 'Wildcard and Free Hit make a week of transfers free. Triple Captain scores your armband three times instead of twice. Bench Boost counts all fifteen players. Projections update immediately.' },
  { t: 'Run two plans against each other', b: 'Plan A and Plan B are independent. Build a different route in each, and the difference at the top tells you which is worth more once hits are paid.' },
];
let coachStep = 0;
function openCoach(step) {
  coachStep = step;
  const c = COACH[step];
  $('#coachStep').textContent = `Planner · step ${step + 1} of ${COACH.length}`;
  $('#coachTitle').textContent = c.t;
  $('#coachBody').textContent = c.b;
  $('#coachDots').innerHTML = COACH.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('');
  $('#coachNext').textContent = step === COACH.length - 1 ? 'Got it' : 'Next';
  $('#coach').hidden = false;
  $('#coachNext').focus();
}
function closeCoach() {
  $('#coach').hidden = true;
  try { localStorage.setItem('fpldesk.coached', '1'); } catch (e) { /* private mode */ }
}
function maybeCoach() {
  let seen = null;
  try { seen = localStorage.getItem('fpldesk.coached'); } catch (e) { seen = '1'; }
  if (!seen && CTX.squad.length) openCoach(0);
}

/** Squad state at the start of a gameweek, after earlier weeks' moves. */
function squadAtGw(plan, gw) {
  let squad = CTX.squad.map((s) => s.id);
  (plan.weeks || []).filter((w) => w.gw < gw).forEach((w) => {
    (w.transfers || []).forEach((t) => { squad = squad.map((id) => (id === t.out ? t.in : id)); });
  });
  return squad;
}

/** Ranked replacements with the reason each one beat the rest. */
function openReplacements(outId, gw) {
  const plan = getPlans()[prefs.activePlan];
  const squadIds = squadAtGw(plan, gw);
  const out = CTX.byId.get(outId);
  const spent = squadIds.reduce((s, id) => {
    const orig = CTX.squad.find((x) => x.id === id);
    return s;
  }, 0);
  const evalNow = evaluatePlan(plan, CTX, { freeTransfers: 1, startingFree: prefs.freeTransfers });
  const wk = evalNow.weeks.find((w) => w.gw === gw);
  const bank = wk ? wk.bank : (CTX.entry ? CTX.entry.bank : 0);
  const alts = transferAlternatives(out, CTX, bank, squadIds, 12);

  openDrawer({
    title: `Replace ${out.name}`,
    meta: `GW${gw} · £${(bank + out.price).toFixed(1)}m available`,
    body: `<div class="blk"><span class="lab">${alts.length} options ranked by projected gain</span>` +
      (alts.length ? `<ul class="plist">` + alts.map((a) => {
        const p = a.player;
        return `<li${a.atClubLimit ? ' class="atlimit"' : ''}>` +
          `<span class="badge">${esc((TEAM.get(p.team) || {}).short || '')}</span>` +
          `<span class="who">${esc(p.name)}</span>${statusTag(p)}` +
          (a.atClubLimit ? '<span class="tag mine">3 already</span>' : '') +
          `<span class="alt-why">${esc(a.reason)}</span>` +
          `<span class="rt"><span class="num ${a.gain > 0 ? 'u' : 'd'}">${signed(a.gain, 2)}/GW</span>` +
          `<span class="num">£${p.price.toFixed(1)}</span>` +
          `<button class="btn${a.atClubLimit ? '' : ' go'}" data-buy="${p.id}|${outId}|${gw}">In</button></span></li>`;
      }).join('') + '</ul>'
        : '<p class="note">Nothing in this position fits the budget.</p>') + '</div>',
  });

  $$('#dBody [data-buy]').forEach((b) => b.addEventListener('click', () => {
    const [inId, oId, g] = b.dataset.buy.split('|').map(Number);
    const pl = getPlans()[prefs.activePlan];
    let week = pl.weeks.find((w) => w.gw === g);
    if (!week) { week = { gw: g, transfers: [] }; pl.weeks.push(week); }
    week.transfers = week.transfers.filter((t) => t.out !== oId);
    week.transfers.push({ out: oId, in: inId });
    pl.weeks.sort((a, b2) => a.gw - b2.gw);
    savePrefs(); closeDrawer(); renderPlanner();
  }));
}

/* ═══════════════════ existing sections, engine-backed ════════════════ */

/**
 * A player on the pitch.
 *
 * The plate under the name follows the round.
 *
 *   live      the running score, doubled for the captain with the working
 *             shown, so 24 is never mistaken for 12.
 *   settled   the SAME number, held until the next deadline. This is the
 *             window that used to blank the squad the instant the last
 *             whistle went; the next fixture is still legible from the three
 *             chips underneath, so nothing is lost by keeping the score.
 *   upcoming  no score exists yet, so the plate carries the fixture instead.
 *
 * The sandbox overrides all of this with opts.projIdx, because it is editing
 * a future week and any past score there would be the wrong number.
 */
function manCard(p, pick, opts = {}) {
  const phase = GW ? GW.phase : 'upcoming';
  const scored = phase === 'live' || phase === 'settled';
  // Real picks carry multiplier 2 (or 3 under Triple Captain). Fall back to the
  // captain flag so a card never shows an undoubled captain score.
  const mult = pick && pick.multiplier > 1 ? pick.multiplier : (pick && pick.captain ? 2 : 1);

  let pins = '';
  if (p.status !== 'a') pins += `<span class="pin ${p.status === 's' ? 'susp' : p.status === 'd' ? 'doubt' : 'out'}">!</span>`;
  else if (p.progress >= 55) pins += '<span class="pin up">▲</span>';
  else if (p.progress <= -55) pins += '<span class="pin dn">▼</span>';

  let armband = '';
  if (pick && pick.captain) armband = '<span class="armband">👑 C</span>';
  else if (pick && pick.vice) armband = '<span class="armband v">V</span>';

  let plate;
  if (opts.projIdx != null) {
    // The sandbox edits a future gameweek, so a live score from the round in
    // progress would be the wrong number entirely. Project the week being edited.
    const xp = p.proj && p.proj[opts.projIdx] != null ? p.proj[opts.projIdx] : 0;
    plate = `<span class="sc proj" title="Projected points for GW${opts.gw}">` +
      `${xp.toFixed(1)}<small> xPts</small></span>`;
  } else if (scored) {
    const base = p.gwPts || 0;
    const cls = 'sc' + (mult > 1 ? ' dbl' : '') + (phase === 'settled' ? ' fin' : '');
    const title = `GW${GW.scoresGw} ${phase === 'settled' ? 'final' : 'so far'}` +
      (mult > 1 ? ` — ${base} × ${mult}` : '');
    plate = `<span class="${cls}" title="${esc(title)}">${base * mult}<small> pts</small>` +
      (mult > 1 ? `<span class="mult">${base} pts × ${mult}</span>` : '') + '</span>';
  } else {
    const nf = p.fixtures[0];
    if (nf && !nf.blank) {
      const g = nf.games[0];
      const t = TEAM.get(g.opp) || {};
      const extra = nf.games.length > 1 ? ` +${nf.games.length - 1}` : '';
      plate = `<span class="nextfx f${Math.round(nf.difficulty)}" title="Difficulty ${nf.difficulty} — ${FDR_WORD[Math.round(nf.difficulty)]}">` +
        `${g.home ? 'vs' : 'at'} ${esc(t.short || '?')} ${g.home ? '(H)' : '(A)'}${extra}</span>`;
    } else {
      plate = '<span class="nextfx f3">no fixture</span>';
    }
  }

  let chips = '';
  for (let i = 0; i < 3; i++) chips += gwChip(p.fixtures[i]);

  const cls = 'man' + (opts.swappable ? ' swappable' : '') + (opts.staged ? ' staged' : '');
  const label = opts.swappable
    ? `Swap ${p.full} out of your GW${opts.gw} squad`
    : `${p.full} · ${p.pts} points this season`;
  return `<button class="${cls}" ${opts.swappable ? `data-swapout="${p.id}"` : `data-pid="${p.id}"`} ` +
    `title="${esc(label)}" aria-label="${esc(label)}">` +
    (pins ? `<span class="pins">${pins}</span>` : '') + armband + kit(p.team, 46) +
    `<span class="nm">${esc(p.name)}</span>${plate}` +
    `<span class="fixrow">${chips}</span></button>`;
}

/**
 * What the squad panel is currently showing, in one phrase.
 * `updating` is the honest word for the live phase: this page has no socket,
 * so scores are as fresh as the last refresh and nothing more.
 */
function squadStatus() {
  if (!GW) return { tone: 'idle', dot: '', label: 'Squad' };
  if (GW.phase === 'live') {
    return { tone: 'live', dot: '<i class="dot"></i>',
      label: `GW${GW.scoresGw} updating · ${GW.inPlay ? `${GW.inPlay} in play` : `${GW.started}/${GW.total} played`}` };
  }
  if (GW.phase === 'settled') {
    return { tone: 'done', dot: '', label: `GW${GW.scoresGw} final · all ${GW.total} played` };
  }
  return { tone: 'idle', dot: '', label: `GW${GW.targetGw} not started · showing fixtures` };
}

function renderSquad() {
  const e = CTX.entry;
  if (!CTX.squad.length) {
    $('#squadNote').textContent = 'Not connected';
    $('#fdrKey').hidden = true;
    $('#squadCard').innerHTML =
      '<div class="setup"><h3>Add your team ID and this fills in</h3>' +
      '<p>The rest of the page works without it. With it you get the weekly recommendation, the pitch, the planner and your leagues.</p><ol>' +
      '<li><div>Log in at <code>fantasy.premierleague.com</code>, click <b>Points</b>, and copy the number from the address bar: <code>/entry/<b>1234567</b>/event/2</code></div></li>' +
      '<li><div>Open <code>config.json</code> in your repo and click the pencil.</div></li>' +
      '<li><div>Set <code>"teamId": 1234567</code> and commit.</div></li></ol></div>';
    return;
  }
  const starters = CTX.squad.filter((p) => p.slot <= 11);
  const bench = CTX.squad.filter((p) => p.slot > 11).sort((a, b) => a.slot - b.slot);
  const lines = { GKP: [], DEF: [], MID: [], FWD: [] };
  starters.forEach((pk) => lines[pk.player.pos].push(pk));

  const shape = [lines.DEF.length, lines.MID.length, lines.FWD.length].join('-');
  const chips = e.chipsUsed && e.chipsUsed.length ? e.chipsUsed.map((c) => `${c.name} GW${c.gw}`).join(', ') : 'none used';
  const best = optimalXI(CTX.squad.map((s) => s.player), 0);
  const same = best && new Set(best.xi.map((p) => p.id)).size === 11 &&
    starters.every((s) => best.xi.some((p) => p.id === s.id));

  /* The panel says what it is showing and how current that is. The global
   * banner covers the whole page; this line answers the narrower question
   * you actually have while looking at the pitch — are these numbers moving
   * right now, are they final, or is this a fixture list? */
  const st = squadStatus();
  $('#squadNote').innerHTML =
    `<span class="sq-state ${st.tone}">${st.dot}${esc(st.label)}</span>` +
    `<span>${esc(shape)}</span>` +
    `<span>${same ? 'matches optimal XI' : `optimal ${best ? best.formation : '—'}`}</span>` +
    `<span>chips: ${esc(chips)}</span>` +
    `<span class="gwage">${esc(freshness())}</span>`;

  let html = `<div class="pitch"><span class="shape">${shape}</span>`;
  ['GKP', 'DEF', 'MID', 'FWD'].forEach((pos) => {
    if (lines[pos].length) html += `<div class="line">${lines[pos].map((r) => manCard(r.player, r)).join('')}</div>`;
  });
  html += `</div><div class="bench"><span class="lab">Bench</span><div class="line">` +
    bench.map((pk) => manCard(pk.player, pk)).join('') + '</div></div>';
  $('#squadCard').innerHTML = html;

  const key = $('#fdrKey'); key.hidden = false;
  key.innerHTML = '<span>Fixture difficulty</span>' +
    [1, 2, 3, 4, 5].map((d) => `<span class="fx f${d}" title="${d} — ${FDR_WORD[d]}">${d}</span>`).join('') +
    '<span>easiest to hardest · UPPER CASE is home</span>';
}

function movement(rank, last) {
  if (rank == null || last == null || last === 0) return '<span class="delta n">–</span>';
  const d = last - rank;
  if (d > 0) return `<span class="delta u">▲&#8202;${compact(d)}</span>`;
  if (d < 0) return `<span class="delta d">▼&#8202;${compact(Math.abs(d))}</span>`;
  return '<span class="delta n">–</span>';
}
function renderLeagues() {
  const list = CTX.entry && CTX.entry.leagues ? CTX.entry.leagues : [];
  if (!list.length) { $('#leagueSec').hidden = true; return; }
  $('#leagueSec').hidden = false;
  const priv = list.filter((l) => l.type === 'private');
  const ordered = priv.concat(list.filter((l) => l.type !== 'private'));
  $('#leagueNote').textContent = priv.length ? `${priv.length} mini-league${priv.length === 1 ? '' : 's'} · select for the table` : 'global only';
  $('#leagues').innerHTML = ordered.map((l, i) => {
    const big = l.myRank != null && l.myRank >= 1e5;
    const rank = l.myRank == null ? '—' : big ? compact(l.myRank) : ordinal(l.myRank);
    return `<button class="lgrow" data-league="${i}">` +
      `<span class="pos${rank.length > 6 ? ' sm' : ''}">${rank}</span>` +
      `<span class="mid"><span class="lgname">${esc(l.name)}</span>` +
      `<span class="of">${l.type === 'private' ? 'mini-league' : 'global'}${l.size ? ' · ' + compact(l.size) + ' managers' : ''}</span></span>` +
      movement(l.myRank, l.myLastRank) + '</button>';
  }).join('');
  $$('#leagues [data-league]').forEach((b) => b.addEventListener('click', () => openLeague(ordered[Number(b.dataset.league)])));
}
function openLeague(l) {
  if (!l) return;
  let body;
  if (!l.standings || !l.standings.length) {
    body = `<div class="blk"><p class="note">${l.type === 'private'
      ? 'No table yet. Standings appear once a gameweek has been scored.'
      : `Global leagues run to millions of managers, so only your position is tracked. You are ${ordinal(l.myRank)}${l.size ? ' of ' + l.size.toLocaleString() : ''}.`}</p></div>`;
  } else {
    const meShown = l.standings.some((r) => r.isMe);
    body = `<div class="blk"><span class="lab">Top ${l.standings.length}</span>` +
      '<table class="st"><thead><tr><th class="l">#</th><th class="l">Team</th><th>GW</th><th>Total</th></tr></thead><tbody>' +
      l.standings.map((r) => `<tr class="${r.isMe ? 'me' : ''}"><td class="l rk">${r.rank}</td>` +
        `<td class="l"><span>${esc(r.team)}</span><span class="mg">${esc(r.manager)}</span></td>` +
        `<td class="num">${r.gw}</td><td class="num">${r.total.toLocaleString()}</td></tr>`).join('') +
      '</tbody></table>' +
      (!meShown && l.myRank ? `<p class="note" style="margin-top:14px">You are ${ordinal(l.myRank)}, outside the top ${l.standings.length} shown.</p>` : '') +
      '</div>';
  }
  openDrawer({ title: l.name, meta: `${l.type === 'private' ? 'Mini-league' : 'Global'} · you are ${ordinal(l.myRank)}${l.size ? ' of ' + compact(l.size) : ''}`, body });
}

function renderShelves() {
  const pool = CTX.players.filter((p) => p.status === 'a' && p.avail > 0.35);
  const mine = (p) => !CTX.squad.some((s) => s.id === p.id);
  const spread = (list, perTeam, limit) => {
    const seen = {}, out = [];
    for (const p of list) {
      if (out.length >= limit) break;
      const t = p.player ? p.player.team : p.team;
      if ((seen[t] || 0) >= perTeam) continue;
      seen[t] = (seen[t] || 0) + 1; out.push(p);
    }
    return out;
  };
  const shelves = [
    { t: 'In form', d: 'Scoring now, not yet widely owned.',
      rows: spread(pool.filter((p) => p.form >= 3 && p.owned < 20 && mine(p)).sort((a, b) => b.form - a.form), 2, 12),
      why: (p) => `form ${p.form.toFixed(1)}` },
    { t: 'Best value', d: 'Most projected points per million.',
      rows: spread(pool.filter(mine).sort((a, b) => b.scores.value - a.scores.value), 2, 12),
      why: (p) => `${p.scores.value.toFixed(2)} per £10m` },
    { t: 'Opportunity', d: 'Highest return the field is not already exposed to.',
      rows: spread(ownershipOpportunity(CTX, 60).filter((o) => mine(o.player)), 2, 12).map((o) => o.player),
      why: (p) => `${p.scores.differential.toFixed(2)} above the field` },
    { t: 'Long-term holds', d: 'Strong across the whole horizon, not just next week.',
      rows: spread(pool.filter(mine).sort((a, b) => b.scores.long - a.scores.long), 2, 12),
      why: (p) => `${p.scores.long.toFixed(2)} long-term` },
  ].filter((s) => s.rows.length >= 3);
  if (!shelves.length) { $('#picks').hidden = true; return; }
  $('#picks').hidden = false;
  $('#shelves').innerHTML = shelves.map((s) => `<div class="shelf"><h3>${esc(s.t)}</h3><p>${esc(s.d)}</p><div class="rail">` +
    s.rows.map((p) => `<button class="stub" data-pid="${p.id}">` +
      `<span class="top">${kit(p.team, 20)}<span class="nm">${esc(p.name)}</span></span>` +
      `<span class="why2">${esc(s.why(p))}</span>` +
      `<span class="fig"><span>£<b>${p.price.toFixed(1)}</b></span><span>own <b>${p.owned.toFixed(1)}</b></span>` +
      `<span>x<b>${p.scores.overall.toFixed(1)}</b></span></span></button>`).join('') + '</div></div>').join('');
}

/* price watch, now with the cost of waiting */
function priceState(p) {
  if (p.progress >= 100) return ['u', 'rise due'];
  if (p.progress >= 55) return ['u', 'rising'];
  if (p.progress <= -100) return ['d', 'fall due'];
  if (p.progress <= -55) return ['d', 'falling'];
  return ['n', 'steady'];
}
function renderPrices() {
  const q = prefs.pQ.trim().toLowerCase();
  const mine = new Set(CTX.squad.map((s) => s.id));
  let rows = CTX.players.filter((p) => {
    if (prefs.pOwned && p.owned < 0.5) return false;
    if (prefs.pMine && !mine.has(p.id)) return false;
    if (prefs.pDir === 'up' && p.progress < 55) return false;
    if (prefs.pDir === 'down' && p.progress > -55) return false;
    if (prefs.pDir === 'all' && Math.abs(p.progress) < 5 && p.seasonDelta === 0) return false;
    if (q) {
      const t = TEAM.get(p.team) || {};
      if (`${p.full} ${p.name} ${t.name || ''} ${t.short || ''}`.toLowerCase().indexOf(q) === -1) return false;
    }
    return true;
  });
  rows.sort((a, b) => {
    const k = prefs.pSort === 'ratio2' ? 'ratio' : prefs.pSort;
    if (k === 'name') return prefs.pDirn * String(a.name).localeCompare(String(b.name));
    if (k === 'ratio') return prefs.pDirn * (Math.abs(a.ratio) - Math.abs(b.ratio));
    return prefs.pDirn * ((a[k] || 0) - (b[k] || 0));
  });

  const CAP = 150;
  const up = rows.filter((p) => p.progress >= 100).length;
  const dn = rows.filter((p) => p.progress <= -100).length;
  const mineDue = rows.filter((p) => mine.has(p.id) && p.progress <= -100).length;
  $('#priceNote').textContent = `${rows.length.toLocaleString()} moving · ${up} due up, ${dn} due down` +
    (mineDue ? ` · ${mineDue} of yours about to drop` : '') + (rows.length > CAP ? ` · top ${CAP}` : '');

  $('#priceRows').innerHTML = rows.slice(0, CAP).map((p) => {
    const t = TEAM.get(p.team) || {}, st = priceState(p);
    const w = Math.min(50, (Math.abs(p.progress) / 200) * 50);
    const bar = '<span class="mk l"></span><span class="mk r"></span>' +
      (p.progress === 0 ? '' : `<i class="${p.progress > 0 ? 'u' : 'd'}" style="width:${w.toFixed(1)}%"></i>`);
    // what waiting actually costs, in the direction that matters to you
    let impact = '<span class="dimtxt">–</span>';
    if (p.progress >= 100 && !mine.has(p.id)) impact = '<span class="pc d">−£0.1m to wait</span>';
    else if (p.progress <= -100 && mine.has(p.id)) impact = '<span class="pc d">−£0.1m if you hold</span>';
    else if (p.progress >= 100 && mine.has(p.id)) impact = '<span class="pc u">+£0.1m coming</span>';
    return `<tr>` +
      `<td class="l"><span class="who" data-pid="${p.id}">${esc(p.name)}</span>${statusTag(p)}` +
      (mine.has(p.id) ? '<span class="tag mine">mine</span>' : '') +
      `<span class="sub">${esc(t.short || '')} · ${p.pos}</span></td>` +
      `<td class="num">£${p.price.toFixed(1)}</td>` +
      `<td class="num hide-sm">${p.seasonDelta === 0 ? '<span class="dimtxt">–</span>' : `<span class="pc ${p.seasonDelta > 0 ? 'u' : 'd'}" style="width:auto">${signed(p.seasonDelta)}</span>`}</td>` +
      `<td><span class="prog"><span class="track">${bar}</span><span class="pc ${st[0]}">${p.progress > 0 ? '+' : p.progress < 0 ? '−' : ''}${Math.abs(p.progress)}%</span></span></td>` +
      `<td class="l hide-xs"><span class="state ${st[0]}"><b>${st[1]}</b></span></td>` +
      `<td class="l hide-sm">${impact}</td>` +
      `<td class="num hide-xs">${p.owned.toFixed(1)}%</td>` +
      `<td class="num hide-sm"><span class="pc ${p.ownDelta > 0.005 ? 'u' : p.ownDelta < -0.005 ? 'd' : 'n'}" style="width:auto">${Math.abs(p.ownDelta) < 0.005 ? '–' : signed(p.ownDelta, 2)}</span></td>` +
      `<td class="num hide-sm"><span class="pc ${p.net > 0 ? 'u' : p.net < 0 ? 'd' : 'n'}" style="width:auto">${p.net === 0 ? '–' : (p.net > 0 ? '+' : '−') + compact(Math.abs(p.net))}</span></td>` +
      `</tr>`;
  }).join('') || '<tr><td colspan="9" class="dimtxt" style="padding:30px 0;text-align:left">Nothing matches those filters.</td></tr>';
}

/* targets, now with the six deconstructed scores */
function renderTargets() {
  const q = prefs.q.trim().toLowerCase();
  const mine = new Set(CTX.squad.map((s) => s.id));
  const rows = CTX.players.filter((p) => {
    if (p.pts === 0 && p.mins === 0 && p.epNext === 0) return false;
    if (prefs.pos !== 'ALL' && p.pos !== prefs.pos) return false;
    if (p.price > prefs.maxPrice) return false;
    if (prefs.hideFlag && p.status !== 'a') return false;
    if (prefs.hideOwned && mine.has(p.id)) return false;
    if (q) {
      const t = TEAM.get(p.team) || {};
      if (`${p.full} ${p.name} ${t.name || ''} ${t.short || ''}`.toLowerCase().indexOf(q) === -1) return false;
    }
    return true;
  });
  const key = prefs.sort;
  rows.sort((a, b) => {
    if (key === 'name') return prefs.dir * String(a.name).localeCompare(String(b.name));
    if (key === 'price' || key === 'owned') return prefs.dir * ((a[key] || 0) - (b[key] || 0));
    return prefs.dir * ((a.scores[key] || 0) - (b.scores[key] || 0));
  });
  const CAP = 120;
  $('#targetNote').textContent = rows.length > CAP ? `top ${CAP} of ${rows.length}` : `${rows.length} player${rows.length === 1 ? '' : 's'}`;
  renderScatter(rows);

  $('#targetRows').innerHTML = rows.slice(0, CAP).map((p) => {
    const t = TEAM.get(p.team) || {}, s = p.scores;
    return `<tr data-row="${p.id}">` +
      `<td class="l"><button class="disc" data-open="${p.id}" aria-expanded="false"` +
        ` aria-controls="drill${p.id}" title="Show ${esc(p.full)}'s underlying numbers"></button>` +
      `<span class="who" data-pid="${p.id}">${esc(p.name)}</span>${statusTag(p)}` +
      (mine.has(p.id) ? catTag(p) : '') +
      `<span class="sub">${esc(t.short || '')} · ${p.pos}</span></td>` +
      `<td class="spk hide-xs">${sparkline(p)}</td>` +
      `<td class="num">${p.price.toFixed(1)}</td>` +
      `<td class="num strong">${s.overall.toFixed(2)}</td>` +
      `<td class="num hide-xxs">${s.short.toFixed(2)}</td>` +
      `<td class="num">${s.long.toFixed(2)}</td>` +
      `<td class="num hide-sm">${s.value.toFixed(2)}</td>` +
      `<td class="num hide-sm">${s.differential.toFixed(2)}</td>` +
      `<td class="num hide-xs">${s.captain.toFixed(2)}</td>` +
      `<td class="num hide-sm">${p.owned.toFixed(1)}</td></tr>` +
      `<tr class="drill" id="drill${p.id}" hidden><td colspan="10">${drillBody(p)}</td></tr>`;
  }).join('') || '<tr><td colspan="10" class="dimtxt" style="padding:30px 0;text-align:left">No players match.</td></tr>';

  $$('#targetRows .disc').forEach((b) => b.addEventListener('click', () => {
    const row = $('#drill' + b.dataset.open);
    const open = row.hidden;
    row.hidden = !open;
    b.setAttribute('aria-expanded', String(open));
  }));
}

/* ═══════════════════════════ the scatter ════════════════════════════ */

/**
 * Price against projected points, for the players currently filtered.
 *
 * The chart answers one question a table cannot: who is cheap for what they
 * produce. That is a two-variable comparison, and a ranked column can only
 * ever show one variable at a time.
 *
 * Three things make it readable without a stats background:
 *   · both axes are named in words with units, not symbols;
 *   · a value line runs through the origin at the median points-per-million,
 *     so "above the line" literally means better value than the middle of
 *     this list — the reading is positional, not numerical;
 *   · every point is a link with a title, and your own players are ringed.
 */
function renderScatter(rows) {
  const el = $('#scatter');
  const pts = rows.slice(0, 90).filter((p) => p.scores.overall > 0);
  if (pts.length < 6) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;

  const W = 900, H = 260, L = 46, R = 12, T = 14, B = 34;
  const xs = pts.map((p) => p.price), ys = pts.map((p) => p.scores.overall);
  const x0 = Math.floor(Math.min(...xs) * 2) / 2 - 0.2, x1 = Math.ceil(Math.max(...xs) * 2) / 2 + 0.2;
  const y0 = 0, y1 = Math.ceil(Math.max(...ys) * 1.1 * 2) / 2;
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => H - B - ((v - y0) / (y1 - y0)) * (H - T - B);

  const ratios = pts.map((p) => p.scores.overall / p.price).sort((a, b) => a - b);
  const med = ratios[Math.floor(ratios.length / 2)];

  const xticks = [];
  for (let v = Math.ceil(x0); v <= x1; v += x1 - x0 > 8 ? 2 : 1) xticks.push(v);
  const yticks = [];
  for (let v = 0; v <= y1; v += y1 > 8 ? 2 : 1) yticks.push(v);

  const mine = new Set(CTX.squad.map((s) => s.id));
  const dots = pts.map((p) => {
    const t = TEAM.get(p.team) || {};
    const good = p.scores.overall / p.price > med;
    return `<circle class="dot ${good ? 'up' : 'dn'}${mine.has(p.id) ? ' mine' : ''}" ` +
      `cx="${X(p.price).toFixed(1)}" cy="${Y(p.scores.overall).toFixed(1)}" r="4" ` +
      `data-pid="${p.id}" tabindex="0" role="button"><title>${esc(p.full)} · ${esc(t.short || '')} ${p.pos}\n` +
      `£${p.price.toFixed(1)}m · ${p.scores.overall.toFixed(2)} projected points per gameweek\n` +
      `${(p.scores.overall / p.price).toFixed(2)} points per £1m — ${good ? 'above' : 'below'} the median of this list` +
      `</title></circle>`;
  }).join('');

  el.innerHTML =
    '<div class="sc-head"><span class="lab">Price against projected points</span>' +
      `<span class="sc-key"><i class="k up"></i>better value than the median` +
      `<i class="k dn"></i>worse<i class="k mine"></i>yours</span></div>` +
    `<svg class="scatter" viewBox="0 0 ${W} ${H}" role="img" ` +
      `aria-label="Scatter plot of price against projected points for ${pts.length} players. ` +
      `Points above the diagonal give more expected points per pound than the median.">` +
      yticks.map((v) => `<g><line class="grid" x1="${L}" y1="${Y(v)}" x2="${W - R}" y2="${Y(v)}"/>` +
        `<text class="ax" x="${L - 7}" y="${Y(v) + 3.5}" text-anchor="end">${v}</text></g>`).join('') +
      xticks.map((v) => `<text class="ax" x="${X(v)}" y="${H - B + 15}" text-anchor="middle">£${v}</text>`).join('') +
      `<line class="medline" x1="${X(x0)}" y1="${Y(x0 * med)}" x2="${X(x1)}" y2="${Y(Math.min(y1, x1 * med))}"/>` +
      `<text class="medlab" x="${W - R - 4}" y="${Math.max(T + 10, Y(Math.min(y1, x1 * med)) - 6)}" text-anchor="end">` +
        `median value · ${med.toFixed(2)} pts per £1m</text>` +
      dots +
      `<text class="axlab" x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">Price (£m)</text>` +
      `<text class="axlab" transform="translate(11 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">` +
        `Projected points per gameweek</text>` +
    '</svg>';

  $$('#scatter .dot').forEach((c) => {
    const open = () => openPlayer(Number(c.dataset.pid));
    c.addEventListener('click', open);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

/* ═══════════════ progressive disclosure and in-row charts ═══════════════ */

/**
 * The second layer of the table. Everything here is derived from figures the
 * snapshot already carries — no estimate is introduced at this level, because
 * a number you had to drill for should be the most trustworthy one on screen.
 * xMin is the exception and is labelled as a projection.
 */
function drillBody(p) {
  const t = TEAM.get(p.team) || {};
  const cells = [
    ['xG / 90', p.per90.xG.toFixed(2), 'expected goals per 90 minutes. Includes penalties — FPL does not publish a non-penalty split.'],
    ['xA / 90', p.per90.xA.toFixed(2), 'expected assists per 90 minutes'],
    ['xGI / 90', p.per90.xGI.toFixed(2), 'goal involvements: xG and xA together'],
    ['xGC / 90', p.per90.xGC.toFixed(2), 'expected goals conceded by his team per 90 — lower is a better clean-sheet bet'],
    ['xMin', Math.round((p.minsPct || 0) * 90) + "'", 'projected minutes: his share of available minutes so far, applied to a full match'],
    ['Starts', `${p.starts || 0}/${CTX.gwPlayed}`, 'matches started out of matches played'],
    ['Minutes', String(p.mins || 0), 'total minutes this season'],
    ['BPS', String(p.bps || 0), 'bonus point system total — the raw score bonus is awarded from'],
    ['Def. actions', String(p.defCon || 0), 'defensive contributions: the tackles-and-interceptions metric FPL scores from'],
    ['Form', String(p.form || 0), 'FPL form: average points over the last 30 days'],
    ['Owned', p.owned.toFixed(1) + '%', 'share of all managers who own him'],
    ['EO', p.eo.toFixed(1) + '%', 'effective ownership: ownership plus an ESTIMATE of captaincy, which FPL does not publish'],
    ['Net transfers', (p.net > 0 ? '+' : '') + compact(p.net), 'transfers in minus out this gameweek'],
    ['Season Δ', (p.seasonDelta > 0 ? '+' : '') + p.seasonDelta.toFixed(1), 'price change since the season started'],
  ];
  const fx = p.fixtures.map((f, i) => {
    if (f.blank) return `<span class="fx f3">GW${f.gw} —</span>`;
    const g = f.games[0], o = TEAM.get(g.opp) || {};
    const nm = g.home ? (o.short || '').toUpperCase() : (o.short || '').toLowerCase();
    return `<span class="fx f${Math.round(f.difficulty)}" title="GW${f.gw} · difficulty ${f.difficulty}">${esc(nm)}<small>${Math.round(f.difficulty)}</small></span>`;
  }).join('');
  return '<div class="drill-in">' +
    `<div class="drill-h"><span class="lab">${esc(p.full)} · ${esc(t.name || '')}</span>` +
      `<button class="linkbtn" data-pid="${p.id}">Full breakdown</button></div>` +
    '<div class="drill-grid">' + cells.map(([k, v, tip]) =>
      `<div class="dcell" title="${esc(tip)}"><span class="lab">${esc(k)}</span><b>${esc(v)}</b></div>`).join('') +
    '</div>' +
    `<div class="drill-fx"><span class="lab">Next ${p.fixtures.length}</span>${fx}` +
      `<span class="proj">projected ${p.proj.map((v) => v.toFixed(1)).join(' · ')} pts</span></div>` +
    '</div>';
}

/**
 * Points per gameweek so far, as a bar sparkline.
 *
 * Bars rather than a line: gameweek points are discrete events, and a line
 * between them implies a continuum that does not exist. A blank (no fixture)
 * is drawn as a hairline at the baseline so it reads as "no match", not "nil".
 * Every bar carries its own title, so the chart is inspectable without a
 * tooltip library.
 */
function sparkline(p) {
  const d = DETAILS[p.id];
  if (!d || !d.gws || d.gws.length < 2) return '<span class="spk-none" title="no per-gameweek history stored for this player">—</span>';
  const g = d.gws.slice(-10);
  const max = Math.max(4, ...g.map((x) => x.pts || 0));
  const W = 62, H = 16, gap = 1;
  const bw = (W - gap * (g.length - 1)) / g.length;
  const bars = g.map((x, i) => {
    const v = x.pts || 0;
    const h = Math.max(v === 0 ? 1 : 2, (v / max) * H);
    const cls = v >= 8 ? 'hi' : v >= 4 ? 'mid' : v > 0 ? 'lo' : 'nil';
    const o = TEAM.get(x.opp) || {};
    return `<rect class="sp ${cls}" x="${(i * (bw + gap)).toFixed(1)}" y="${(H - h).toFixed(1)}" ` +
      `width="${bw.toFixed(1)}" height="${h.toFixed(1)}"><title>GW${x.gw} ` +
      `${x.home ? 'v' : 'at'} ${esc(o.short || '?')} — ${v} pts, ${x.mins}'</title></rect>`;
  }).join('');
  const last = g[g.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" ` +
    `aria-label="Points in the last ${g.length} gameweeks, most recent ${last.pts}">` +
    `<line class="spbase" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/>${bars}</svg>`;
}

function renderTicker() {
  const swings = new Map(fixtureSwings(CTX, 0.7).map((s) => [s.team.id, s]));
  $('#tickerNote').textContent = `GW ${CTX.gws[0]}–${CTX.gws[CTX.gws.length - 1]} · lower total is easier`;
  $('#tickHead').innerHTML = '<th class="l">Club</th>' + CTX.gws.map((g) => `<th>${g}</th>`).join('') +
    '<th>Total</th><th class="l hide-sm">Swing</th>';
  const rows = CTX.snapshot.teams.map((t) => {
    const list = CTX.snapshot.fixtures[t.id] || [];
    let sum = 0;
    const cells = CTX.gws.map((g) => {
      const games = list.filter((f) => f.gw === g);
      if (!games.length) { sum += 3; return null; }
      games.forEach((f) => { sum += f.d; });
      return games;
    });
    return { t, cells, sum, swing: swings.get(t.id) };
  }).sort((a, b) => a.sum - b.sum || a.t.name.localeCompare(b.t.name));

  $('#ticker').innerHTML = rows.map((r) => `<tr><td class="l"><span class="badge">${esc(r.t.short)}</span> ${esc(r.t.name)}</td>` +
    r.cells.map((c) => `<td style="text-align:center">${c ? c.map(fxChip).join(' ') : '<span class="fx f3">–</span>'}</td>`).join('') +
    `<td class="num" style="font-weight:600">${r.sum}</td>` +
    `<td class="l hide-sm">${r.swing ? `<span class="swing ${r.swing.direction === 'easier' ? 'u' : 'd'}">${r.swing.direction === 'easier' ? '↗' : '↘'} GW${r.swing.gw}</span>` : '<span class="dimtxt">–</span>'}</td></tr>`).join('');
  $('#fixtures').hidden = false;
}

function renderInjuries() {
  const byTeam = {};
  CTX.players.filter((p) => p.status !== 'a').forEach((p) => { (byTeam[p.team] = byTeam[p.team] || []).push(p); });
  const keys = Object.keys(byTeam);
  if (!keys.length) { $('#news').hidden = true; return; }
  $('#news').hidden = false;
  const rank = { u: 0, i: 1, s: 2, d: 3, n: 4 };
  $('#clubs').innerHTML = keys.sort((a, b) => byTeam[b].length - byTeam[a].length).map((tid) => {
    const t = TEAM.get(Number(tid)) || {};
    const items = byTeam[tid].sort((a, b) => ((rank[a.status] ?? 9) - (rank[b.status] ?? 9)) || b.owned - a.owned);
    return `<div class="club"><h4><span class="badge">${esc(t.short || '')}</span>${esc(t.name || '')}<span class="n">${items.length}</span></h4><ul>` +
      items.map((p) => `<li><span class="nm" data-pid="${p.id}">${esc(p.name)}</span>${statusTag(p)}` +
        (p.owned >= 3 ? `<span class="sub">${p.owned.toFixed(1)}%</span>` : '') +
        `<span class="ds">${esc(p.news || 'No detail given')}</span></li>`).join('') + '</ul></div>';
  }).join('');
}

/* ─────────────────────────── charts & drawer ────────────────────────── */

function barChart(data, opts = {}) {
  const w = opts.width || 400, h = opts.height || 92, pad = 18, gap = 3, maxBar = opts.maxBar || 40;
  if (!data.length) return '';
  let max = Math.max(...data.map((d) => d.value)) || 1;
  if (max <= 0) max = 1;
  const bw = Math.min(maxBar, (w - (data.length - 1) * gap) / data.length);
  const span = data.length * bw + (data.length - 1) * gap, x0 = (w - span) / 2;
  const plot = h - pad - (opts.values ? 14 : 6);
  const bars = data.map((d, i) => {
    const bh = Math.max(2, (d.value / max) * plot), x = x0 + i * (bw + gap), y = h - pad - bh;
    return `<rect class="cbar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" data-t="${esc(d.label + ' · ' + d.value + (opts.unit || ''))}"></rect>` +
      (opts.labels ? `<text class="lbl" x="${(x + bw / 2).toFixed(1)}" y="${h - 5}" text-anchor="middle">${esc(d.short || d.label)}</text>` : '') +
      (opts.values ? `<text class="val" x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${d.value}</text>` : '');
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" style="max-height:${h}px">` +
    `<line class="axis" x1="${Math.max(0, x0 - 6)}" y1="${h - pad}" x2="${Math.min(w, x0 + span + 6)}" y2="${h - pad}"/>${bars}</svg>`;
}

const tipEl = () => $('#tip');
function showTip(html, x, y) {
  const t = tipEl(); t.innerHTML = html; t.classList.add('on');
  const r = t.getBoundingClientRect();
  t.style.left = Math.max(6, Math.min(window.innerWidth - r.width - 6, x - r.width / 2)) + 'px';
  t.style.top = Math.max(6, y - r.height - 9) + 'px';
}
function hideTip() { tipEl().classList.remove('on'); }

let lastFocus = null;
function openDrawer(o) {
  lastFocus = document.activeElement;
  $('#dName').textContent = o.title;
  $('#dMeta').textContent = o.meta || '';
  $('#dBody').innerHTML = o.body;
  $('#scrim').classList.add('on'); $('#drawer').classList.add('on'); $('#drawer').focus();
  $$('#dBody .cbar').forEach((b) => {
    b.addEventListener('mouseenter', () => {
      const r = b.getBoundingClientRect();
      showTip(esc(b.dataset.t), r.left + r.width / 2, r.top);
    });
    b.addEventListener('mouseleave', hideTip);
  });
}
function closeDrawer() {
  $('#scrim').classList.remove('on'); $('#drawer').classList.remove('on'); hideTip();
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

/** Player detail, now leading with why the algorithm rates him. */
function openPlayer(pid) {
  const p = CTX.byId.get(pid); if (!p) return;
  const t = TEAM.get(p.team) || {}, det = DETAILS[pid], s = p.scores, st = priceState(p);
  const cat = categorise(p);
  let b = '';

  if (p.news) b += `<div class="newsbox">${esc(p.news)}</div>`;

  b += `<div class="blk"><span class="lab">Why it rates him</span>` +
    `<div class="factors">` + s.breakdown.factors.map((f) => {
      const cls = f.value >= 70 ? 'good' : f.value >= 45 ? 'ok' : 'bad';
      return `<div class="fac"><span class="fac-k">${esc(f.key)}</span>` +
        `<span class="fac-t"><i class="${cls}" style="width:${Math.round(f.value)}%"></i></span>` +
        `<span class="fac-v">${esc(f.raw)}</span></div>`;
    }).join('') + `</div>` +
    (s.breakdown.concern ? `<p class="concern">Main concern: ${esc(s.breakdown.concern)}.</p>` : '<p class="note">No obvious weakness in his profile.</p>') +
    `</div>`;

  b += `<div class="blk"><span class="lab">Scores</span><div class="kv">` +
    [['Overall', s.overall.toFixed(2)], ['Short term', s.short.toFixed(2)], ['Long term', s.long.toFixed(2)],
     ['Value', s.value.toFixed(2)], ['Differential', s.differential.toFixed(2)], ['Captain', s.captain.toFixed(2)]]
      .map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('') +
    `</div><p class="note">All but Value are expected points per gameweek. Verdict: <b>${CAT_LABEL[cat.tag]}</b> — ${esc(cat.why)}.</p></div>`;

  b += `<div class="blk"><span class="lab">This season</span><div class="kv">` +
    [['Price', '£' + p.price.toFixed(1)], ['Points', p.pts], ['Per game', p.ppg.toFixed(1)],
     ['Owned', p.owned.toFixed(1) + '%'], ['Effective', p.eo.toFixed(1) + '%'], ['Minutes', p.mins]]
      .map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('') + '</div></div>';

  b += `<div class="blk"><span class="lab">Underlying</span><div class="kv">` +
    [['xG', p.xG.toFixed(2)], ['xA', p.xA.toFixed(2)], ['xGI / 90', p.per90.xGI.toFixed(2)],
     ['Goals', p.goals], ['Assists', p.assists], ['Bonus', p.bonus]]
      .map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('') + '</div></div>';

  if (p.avail > 0) {
    const sim = simulatePlayer(p, 0, CTX, 1200);
    b += `<div class="blk"><span class="lab">Next gameweek, simulated</span><div class="kv">` +
      [['Median', sim.p50], ['25th', sim.p25], ['75th', sim.p75],
       ['Mean', sim.mean.toFixed(1)], ['Haul 10+', (sim.pHaul * 100).toFixed(0) + '%'], ['Blank ≤2', (sim.pBlank * 100).toFixed(0) + '%']]
        .map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('') +
      `</div><p class="assume">1,200 draws over goals, assists, clean sheets and minutes from his per-90 rates and this fixture.</p></div>`;
  }

  b += `<div class="blk"><span class="lab">Price</span><div class="kv">` +
    [['Started', '£' + p.priceStart.toFixed(1)], ['Season', p.seasonDelta === 0 ? '–' : signed(p.seasonDelta)],
     ['Progress', `${p.progress > 0 ? '+' : p.progress < 0 ? '−' : ''}${Math.abs(p.progress)}%`],
     ['Net transfers', p.net === 0 ? '–' : (p.net > 0 ? '+' : '−') + compact(Math.abs(p.net))],
     ['Own change', Math.abs(p.ownDelta) < 0.005 ? '–' : signed(p.ownDelta, 2)], ['Status', st[1]]]
      .map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join('') + '</div></div>';

  if (det && det.gws && det.gws.length) {
    b += `<div class="blk"><span class="lab">Points by gameweek</span>` +
      barChart(det.gws.map((g) => ({ label: 'GW' + g.gw, short: String(g.gw), value: g.pts })), { labels: true, unit: ' pts' }) + '</div>';
  }
  if (det && det.past && det.past.length) {
    const seasons = det.past.slice(-6);
    b += `<div class="blk"><span class="lab">Previous seasons</span>` +
      barChart(seasons.map((x) => ({ label: x.season, short: x.season.slice(0, 2) + '/' + x.season.slice(-2), value: x.pts })), { height: 104, labels: true, values: true, unit: ' pts' }) +
      '<table class="seasons">' + seasons.slice().reverse().map((x) =>
        `<tr><td>${esc(x.season)}</td><td>${x.mins} mins · ${x.goals}g ${x.assists}a · ended £${x.endCost.toFixed(1)}</td><td>${x.pts}</td></tr>`).join('') +
      '</table></div>';
  }

  b += `<div class="blk"><span class="lab">Next ${p.fixtures.length} fixtures</span><div class="fxlist">` +
    p.fixtures.map((f) => gwChip(f)).join('') + '</div></div>';

  openDrawer({ title: p.full || p.name, meta: `${t.name || ''} · ${p.pos} · £${p.price.toFixed(1)}m` +
    (CTX.squad.some((s2) => s2.id === p.id) ? ' · in your squad' : ''), body: b });
}

/* ──────────────────────────── wiring ────────────────────────────────── */

function segment(sel, key, onChange) {
  $$(sel + ' button').forEach((b) => {
    const v = b.dataset.pos || b.dataset.dir || b.dataset.mode;
    b.setAttribute('aria-pressed', String(v === prefs[key]));
    b.addEventListener('click', () => {
      prefs[key] = v;
      $$(sel + ' button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      savePrefs(); onChange();
    });
  });
}
function bindSort(scope, sortKey, dirKey, onChange) {
  $$(scope + ' thead th.s').forEach((th) => {
    if (prefs[sortKey] === th.dataset.k) th.setAttribute('aria-sort', prefs[dirKey] === 1 ? 'ascending' : 'descending');
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (prefs[sortKey] === k) prefs[dirKey] = -prefs[dirKey];
      else { prefs[sortKey] = k; prefs[dirKey] = k === 'name' ? 1 : -1; }
      $$(scope + ' thead th.s').forEach((x) => x.removeAttribute('aria-sort'));
      th.setAttribute('aria-sort', prefs[dirKey] === 1 ? 'ascending' : 'descending');
      savePrefs(); onChange();
    });
  });
}

function wire() {
  segment('#posSeg', 'pos', renderTargets);
  segment('#priceSeg', 'pDir', renderPrices);
  segment('#modeSeg', 'mode', () => { applyMode(); renderAll(); showModeHint(); });
  bindSort('#targets', 'sort', 'dir', renderTargets);
  bindSort('#prices', 'pSort', 'pDirn', renderPrices);

  const bindInput = (sel, key, fn, num) => {
    const el = $(sel); if (!el) return;
    el.value = prefs[key];
    el.addEventListener('input', () => {
      prefs[key] = num ? (parseFloat(el.value) || 0) : el.value;
      savePrefs(); fn();
    });
  };
  bindInput('#search', 'q', renderTargets);
  bindInput('#priceSearch', 'pQ', renderPrices);
  bindInput('#maxPrice', 'maxPrice', renderTargets, true);

  [['#hideFlag', 'hideFlag', renderTargets], ['#hideOwned', 'hideOwned', renderTargets],
   ['#priceMine', 'pMine', renderPrices], ['#priceOwned', 'pOwned', renderPrices]].forEach(([sel, key, fn]) => {
    const el = $(sel); el.checked = !!prefs[key];
    el.addEventListener('change', () => { prefs[key] = el.checked; savePrefs(); fn(); });
  });

  const ft = $('#ftIn');
  ft.value = prefs.freeTransfers;
  ft.addEventListener('change', () => {
    prefs.freeTransfers = Math.max(0, Math.min(5, parseInt(ft.value, 10) || 0));
    savePrefs(); renderDashboard(); renderPlanner();
  });

  $('#planReset').addEventListener('click', () => {
    getPlans()[prefs.activePlan] = { name: `Plan ${prefs.activePlan}`, weeks: [] };
    savePrefs(); renderPlanner();
  });
  $('#planCopy').addEventListener('click', () => {
    const from = prefs.activePlan, to = from === 'A' ? 'B' : 'A';
    getPlans()[to] = JSON.parse(JSON.stringify(getPlans()[from]));
    getPlans()[to].name = `Plan ${to}`;
    prefs.activePlan = to; savePrefs(); renderPlanner();
  });

  // Dark is the default with no media query behind it, so "currently dark"
  // means simply: no explicit light choice on the root.
  $('#themeBtn').addEventListener('click', () => {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    prefs.theme = light ? 'dark' : 'light';
    applyTheme(); savePrefs();
  });

  $('#coachNext').addEventListener('click', () => {
    if (coachStep >= COACH.length - 1) closeCoach(); else openCoach(coachStep + 1);
  });
  $('#coachSkip').addEventListener('click', closeCoach);
  $('#coach').addEventListener('click', (e) => { if (e.target.id === 'coach') closeCoach(); });

  $$('#modeSeg button').forEach((b) => {
    b.addEventListener('mouseenter', () => showModeHint(b.dataset.mode));
    b.addEventListener('focus', () => showModeHint(b.dataset.mode));
    b.addEventListener('mouseleave', hideModeHint);
    b.addEventListener('blur', hideModeHint);
  });

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-pid]');
    if (el && !el.hasAttribute('data-buy')) openPlayer(Number(el.dataset.pid));
  });
  $('#dClose').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#coach').hidden) closeCoach(); else closeDrawer();
  });
}

const MODE_COPY = {
  decision: { icon: '🎯', title: 'Decision Mode',
    body: 'Just tell me what to do — simplified advice for starting XI, captaincy and recommended transfers.' },
  analyst: { icon: '📊', title: 'Analyst Mode',
    body: 'Deep dive into the maths — full tables of xGI, xPts, fixture difficulty ratings and probabilistic simulations.' },
};
let hintTimer = null;
function showModeHint(which) {
  const m = MODE_COPY[which || prefs.mode];
  const el = $('#modehint');
  el.innerHTML = `<b>${m.icon} ${esc(m.title)}</b>${esc(m.body)}`;
  el.classList.add('on');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.remove('on'), 3200);
}
function hideModeHint() { clearTimeout(hintTimer); $('#modehint').classList.remove('on'); }

/* ══════════════════════ the match schedule ═════════════════════ */

/** Sydney, because that is where this is read. Everything else is UTC. */
const TZ = 'Australia/Sydney';
let MS_GW = null;

const tzTime = (iso) => new Date(iso).toLocaleTimeString('en-AU',
  { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

/** "Sat 30 Aug", or "Today" / "Tomorrow" when that is the more useful label. */
function dayLabel(key) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = f.format(new Date());
  const tmr = f.format(new Date(Date.now() + 864e5));
  if (key === today) return 'Today';
  if (key === tmr) return 'Tomorrow';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-AU',
    { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
}

function renderMatches() {
  const sec = $('#matches');
  if (!GW) { sec.hidden = true; return; }

  // The rounds worth offering: the one being played, and the one you can
  // still act on. During a live round those differ, which is exactly when
  // you want both.
  const opts = [];
  if (GW.scoresGw != null) opts.push(GW.scoresGw);
  if (GW.targetGw != null && !opts.includes(GW.targetGw)) opts.push(GW.targetGw);
  if (!opts.length) { sec.hidden = true; return; }
  if (MS_GW == null || !opts.includes(MS_GW)) MS_GW = GW.phase === 'live' ? GW.scoresGw : opts[opts.length - 1];

  const sched = matchSchedule(CTX, MS_GW, TZ);
  sec.hidden = sched.count === 0;
  if (!sched.count) return;

  $('#msGw').innerHTML = opts.map((g) =>
    `<button data-msgw="${g}" aria-pressed="${g === MS_GW}">GW${g}</button>`).join('');
  const anyLive = sched.days.some((d) => d.matches.some((m) => m.inPlay));
  $('#msNote').textContent =
    `${sched.count} matches · ${sched.yours} with your players · Sydney time` +
    (anyLive ? ` · clocks ${freshness()}` : '');

  $('#msBody').innerHTML = sched.days.map((d) => {
    const rows = d.matches.map((m) => {
      const hs = m.home ? m.home.short : '???';
      const as = m.away ? m.away.short : '???';
      // state cell: the clock while it runs, FT after, kickoff time before
      let state, cls, tip;
      if (m.inPlay) {
        state = `${m.minutes}'`; cls = 'ms-live';
        // The clock is only as fresh as the last refresh — say so rather than
        // letting a static number read as a live ticker.
        tip = `${m.minutes} minutes played as of the last refresh (${freshness()})`;
      } else if (m.finished) { state = 'FT'; cls = 'ms-done'; tip = 'Full time'; }
      else { state = tzTime(m.ko); cls = 'ms-soon'; tip = `Kick-off ${tzTime(m.ko)} Sydney`; }
      const score = m.started
        ? `<span class="ms-score">${m.hScore == null ? '–' : m.hScore}<i>–</i>${m.aScore == null ? '–' : m.aScore}</span>`
        : '<span class="ms-v">v</span>';
      const chip = (t, d2) => d2 == null
        ? `<span class="ms-fdr none" title="difficulty not published for this round">${esc(t)}</span>`
        : `<span class="ms-fdr f${Math.round(d2)}" title="Difficulty ${d2} — ${FDR_WORD[Math.round(d2)]}">${esc(t)}<small>${Math.round(d2)}</small></span>`;
      return `<div class="ms-row${m.yours ? ' mine' : ''}${m.inPlay ? ' onnow' : ''}">` +
        `<span class="ms-state ${cls}" title="${esc(tip)}">${esc(state)}</span>` +
        `<span class="ms-side h${m.yourSide === 'h' || m.yourSide === 'both' ? ' you' : ''}">${chip(hs, m.dh)}</span>` +
        score +
        `<span class="ms-side a${m.yourSide === 'a' || m.yourSide === 'both' ? ' you' : ''}">${chip(as, m.da)}</span>` +
        `<span class="ms-names">${esc(m.home ? m.home.name : '')} <i>v</i> ${esc(m.away ? m.away.name : '')}</span>` +
        '</div>';
    }).join('');
    const n = d.matches.length;
    return `<div class="ms-day"><div class="ms-daylab"><span class="lab">${esc(dayLabel(d.key))}</span>` +
      `<span class="ms-count">${n} match${n === 1 ? '' : 'es'}</span></div>${rows}</div>`;
  }).join('');

  $$('#msGw [data-msgw]').forEach((b) => b.addEventListener('click', () => {
    MS_GW = Number(b.dataset.msgw); renderMatches();
  }));
}

/** Everything that depends on data or mode. Called on boot and on mode change. */
function renderAll() {
  renderGwBanner();
  renderHeader();
  renderDashboard();
  renderScoreBug();
  renderSquad();
  renderMatches();
  renderLeagues();
  renderPlanner();
  renderChanges();
  renderShelves();
  renderPrices();
  renderTargets();
  renderTicker();
  renderInjuries();
}

/* ──────────────────────────── boot ──────────────────────────────────── */

applyTheme();
// Surface the build the browser actually loaded, so a stale cache is visible
// rather than mysterious.
(() => {
  const m = document.querySelector('meta[name="build"]');
  const el = document.getElementById('buildTag');
  if (m && el) el.textContent = 'b' + m.content;
})();
const bust = '?v=' + Date.now();
const grab = (f, fallback) => fetch(f + bust).then((r) => (r.ok ? r.json() : fallback)).catch(() => fallback);

Promise.all([
  fetch('data/snapshot.json' + bust).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
  grab('data/details.json', {}),
  grab('data/changes.json', null),
]).then(([snap, details, changes]) => {
  DETAILS = details || {};
  CHANGES = changes;
  CTX = buildContext(snap, DETAILS);
  CTX.teams.forEach((t) => TEAM.set(t.id, t));

  GW = gameweekState(CTX);
  applyMode();
  renderAll();
  $('#prices').hidden = false; $('#targets').hidden = false;
  wire();
  maybeCoach();

  const mins = Math.round((Date.now() - new Date(snap.generatedAt).getTime()) / 60000);
  $('#stamp').textContent = 'updated ' + (mins < 60 ? mins + ' min ago' : Math.round(mins / 60) + 'h ago');
  document.documentElement.classList.add('ready');
}).catch((err) => {
  $('#deadline').textContent = 'No data yet';
  $('#deadlineSub').textContent = 'The refresh job has not produced a snapshot.';
  $('#squadCard').innerHTML = '<div class="setup"><h3>Waiting on the first refresh</h3>' +
    '<p>The page loaded, but <code>data/snapshot.json</code> is not there yet. On a new repo that is normal.</p><ol>' +
    '<li><div>Open the <b>Actions</b> tab in your repo.</div></li>' +
    '<li><div>Pick <b>Refresh FPL data</b>, then <b>Run workflow</b>.</div></li>' +
    '<li><div>Give it a minute, then reload.</div></li></ol>' +
    `<p class="note" style="margin-top:16px">${esc(err.message)}</p></div>`;
});
