// GET /api/games?week=N  schedule + server-side lock times (no picks). Default week = current.
// GET /api/games?live=1&week=N&dates=YYYY  ESPN scoreboard proxy for live.js.
// GET /api/games?board=1&week=N  dynamic board JSON (Turso + ESPN). Rides on this function so we stay under
//   the Hobby plan 12-function limit (no separate /api/board).
const {handler} = require('../lib/handler');
const {send, query} = require('../lib/http');
const data = require('../lib/data');
const core = require('../lib/core');
const {getDb} = require('../lib/db');
const ESPN = process.env.ESPN_SCOREBOARD_URL || 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const FIX = {WSH: 'WAS', LA: 'LAR', JAC: 'JAX', OAK: 'LV', SD: 'LAC'};
const memo = new Map();

function trim(j) {
  const ev = (Array.isArray(j && j.events) ? j.events : []).map(e => {
    try {
      const c = e.competitions[0], t = e.status.type;
      return {competitions: [{competitors: c.competitors.map(x => ({homeAway: x.homeAway, team: {abbreviation: x.team.abbreviation}, score: x.score}))}],
              status: {type: {state: t.state, completed: t.completed, shortDetail: t.shortDetail}}};
    } catch (err) { return null; }
  }).filter(Boolean);
  return {week: j && j.week && j.week.number != null ? {number: j.week.number} : undefined, events: ev};
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'player';
}
function gameKey(g) { return (g.away + '-' + g.home).toLowerCase(); }
function abbrMap(wd) {
  const m = {};
  (wd.games || []).forEach(g => { m[g.away_team] = g.away; m[g.home_team] = g.home; });
  return m;
}
function normClock(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!s) return 'LIVE';
  const low = s.toLowerCase();
  if (low.startsWith('final')) return low.includes('ot') ? 'Final/OT' : 'Final';
  if (low.includes('half')) return 'Half';
  const clk = /\b(\d{1,2}:\d{2})\b/.exec(s);
  let per = null, m = /\bq\s*([1-4])\b|\b([1-4])(?:st|nd|rd|th)\b/.exec(low);
  if (m) per = 'Q' + (m[1] || m[2]);
  else { m = /\b(\d?)\s*ot\b|\bovertime\b/.exec(low); if (m) per = m[1] ? m[1] + 'OT' : 'OT'; }
  if (low.startsWith('end')) return ('End ' + (per || (low.includes('regulation') ? 'Q4' : ''))).trim();
  if (per && clk) return per + ' ' + clk[1];
  return per || (clk ? clk[1] : s.slice(0, 16));
}

async function fetchEspnRaw(year, week) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${ESPN}?dates=${year}&seasontype=2&week=${week}`, {signal: ctl.signal, headers: {Accept: 'application/json'}});
    if (!r.ok) return null;
    const j = await r.json();
    const games = {};
    (j.events || []).forEach(ev => {
      try {
        const c = ev.competitions[0], st = ev.status.type, sc = {}, ks = [];
        c.competitors.forEach(x => {
          let a = String(x.team.abbreviation); a = FIX[a] || a;
          const v = parseInt(x.score, 10); sc[a] = isFinite(v) ? v : 0; ks.push(a);
        });
        if (ks.length === 2) games[ks.slice().sort().join('|')] = {sc, state: String(st.state || ''), done: st.completed !== false, detail: String(st.shortDetail || '')};
      } catch (e) { /* skip */ }
    });
    return games;
  } catch (e) { return null; }
  finally { clearTimeout(to); }
}

function buildGames(wd, espn) {
  const sundayFinal = !!wd.sunday_final;
  return (wd.games || []).map(g => {
    const key = gameKey(g);
    const hidden = g.is_monday && !sundayFinal;
    const pair = [g.away, g.home].sort().join('|');
    const e = espn && espn[pair];
    let status = 'pre', score = null, winner = null, clock = null;
    if (e && e.sc[g.away] != null && e.sc[g.home] != null) {
      const A = e.sc[g.away], H = e.sc[g.home];
      const line = g.away + ' ' + A + ' – ' + g.home + ' ' + H;
      if (e.state === 'post' && e.done) {
        status = 'final'; score = line;
        winner = A > H ? g.away_team : H > A ? g.home_team : 'TIE';
      } else if (e.state === 'in') {
        status = 'live'; score = line + ' (' + e.detail + ')'; clock = normClock(e.detail);
      }
    }
    return {key, matchup: g.matchup, away: g.away, home: g.home, when: g.kickoff_label, hidden,
            status, score, winner, clock, is_monday: !!g.is_monday};
  });
}

function scorePlayers(entries, games, abbr, sundayFinal) {
  const players = entries.map(e => {
    const picks = {};
    let score = 0;
    for (const [matchup, team] of Object.entries(e.picks || {})) {
      const g = games.find(gg => gg.matchup === matchup);
      if (!g) continue;
      const ab = abbr[team] || team;
      let cls = 'pick-pending', text = ab;
      if (g.hidden) { cls = 'pick-hidden'; text = '🔒'; }
      else if (g.status === 'final') {
        if (g.winner === 'TIE') cls = 'pick-split';
        else {
          const wab = abbr[g.winner] || g.winner;
          cls = text === wab ? 'pick-win' : 'pick-loss';
          if (cls === 'pick-win') score++;
        }
      }
      picks[g.key] = {cls, text};
    }
    if (e.tiebreaker != null && sundayFinal) {
      picks.tb = {cls: 'pick-tb', text: String(e.tiebreaker)};
    }
    const display = e.tag ? `${e.name} (${e.tag})` : e.name;
    return {key: slug(e.name + (e.tag ? '-' + e.tag : '')), name: e.name, tag: e.tag || '', display,
            rank: 0, score, leader: false, paid: !!e.paid, void: !!e.void,
            picks, online: true, entry: e.name, tiebreaker: e.tiebreaker};
  });
  const ranked = players.filter(p => !p.void).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let rank = 1;
  ranked.forEach((p, i) => {
    if (i > 0 && p.score < ranked[i - 1].score) rank = i + 1;
    p.rank = rank;
    p.leader = rank === 1 && p.score > 0;
  });
  players.filter(p => p.void).forEach(p => { p.rank = players.length; });
  return players.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

function buildStatus(wd, games, players, nowMs, currentWeek) {
  const fee = Number(wd.entry_fee || 10);
  const paid = players.filter(p => p.paid && !p.void);
  const pot = paid.length * fee;
  const gamesFinal = games.filter(g => g.status === 'final' && !g.hidden).length;
  const gamesTotal = games.filter(g => !g.hidden).length;
  const leaders = players.filter(p => p.leader);
  const state = gamesFinal === gamesTotal && gamesTotal ? 'final' : games.some(g => g.status === 'live') ? 'live' : 'open';
  const L = core.withLocks(Object.assign({}, wd, {picks_locked: wd.picks_locked}), nowMs);
  const locked = L.locked;
  const submitOpen = wd.open !== false && wd.week === currentWeek && !locked;
  const text = {
    pot: '$' + pot,
    payout: '$' + pot,
    entries: players.length + ' entries',
    leader: leaders.length ? leaders.map(l => l.name).join(' & ') + ' · ' + leaders[0].score : '—',
    leader_short: leaders.length > 1 ? 'Tied: ' + leaders.map(l => l.name).join(', ') : (leaders[0] ? leaders[0].name : '—'),
    lock: locked ? 'All picks locked' : 'Picks open',
    updated: 'Updated ' + new Date(nowMs).toLocaleString('en-US', {timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit'}) + ' PT'
  };
  return {
    week: wd.week, year: wd.year, state,
    next_lock_iso: L.lock_at, next_game: null,
    live_games: games.filter(g => g.status === 'live').map(g => ({away: g.away, home: g.home, clock: g.clock})),
    pot, payout: pot, entries: players.length,
    leaders: leaders.map(l => ({key: l.key, name: l.name, display: l.display, score: l.score})),
    leaders_count: leaders.length,
    games_final: gamesFinal, games_total: gamesTotal,
    sunday_final: !!wd.sunday_final,
    last_updated_iso: new Date(nowMs).toISOString(),
    submit_open: submitOpen, submit_url: '/submit',
    lock_day: 'Admin', submit_close_iso: L.lock_at,
    picks_locked: locked,
    text
  };
}

async function board(req, res, q, nowMs) {
  let db = null;
  try { db = await getDb(); } catch (e) { db = null; }
  if (!db) return send(res, 503, {ok: false, error: 'Picks storage is not connected yet.', code: 'NO_STORAGE'});
  const cur = data.currentWeek();
  const week = Number(q.week || cur);
  const wd = data.loadWeek(week);
  if (!wd) return send(res, 404, {ok: false, error: `Week ${week || '?'} is not set up yet.`, code: 'WEEK'});
  wd.picks_locked = await core.getPicksLocked(db, week, wd, nowMs);
  const all = await core.readWithTombstones(db, week);
  const entries = core.publicEntries(all.entries, wd);
  const espn = await fetchEspnRaw(wd.year, week);
  const games = buildGames(wd, espn);
  const abbr = abbrMap(wd);
  const players = scorePlayers(entries, games, abbr, !!wd.sunday_final);
  const status = buildStatus(wd, games, players, nowMs, cur);
  const out = {version: 1, week, year: wd.year, status, games, players, fee: Number(wd.entry_fee || 10), abbr};
  send(res, 200, out, {'Cache-Control': 'public, max-age=0, s-maxage=15, stale-while-revalidate=30'});
}

async function live(req, res, q, nowMs) {
  const week = Number(q.week || data.currentWeek()), wd = data.loadWeek(week);
  const year = Number(q.dates || (wd && wd.year) || new Date(nowMs).getFullYear());
  if (!wd || !Number.isInteger(week) || !Number.isInteger(year) || year < 2020 || year > 2100)
    return send(res, 404, {ok: false, error: 'Week is not set up.', code: 'WEEK'});
  const key = `${year}:${week}`, hit = memo.get(key);
  let body = hit && nowMs - hit.at < 10000 ? hit.body : null;
  if (!body) {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(`${ESPN}?dates=${year}&seasontype=2&week=${week}`, {signal: ctl.signal, headers: {Accept: 'application/json'}});
      if (!r.ok) throw new Error('ESPN HTTP ' + r.status);
      body = Object.assign({ok: true, fetched_at: new Date(nowMs).toISOString()}, trim(await r.json()));
      memo.set(key, {at: nowMs, body});
    } catch (e) {
      return send(res, 502, {ok: false, error: 'Live scores unavailable right now.', code: 'ESPN'});
    } finally { clearTimeout(to); }
  }
  send(res, 200, body, {'Cache-Control': 'public, max-age=0, s-maxage=15, stale-while-revalidate=15'});
}

module.exports = handler(['GET'], async (req, res, _r, now) => {
  const q = query(req);
  if (q.board === '1') return board(req, res, q, now);
  if (q.live === '1') return live(req, res, q, now);
  let db = null;
  try { db = await getDb(); } catch (e) { db = null; }
  const cur = data.currentWeek(), week = Number(q.week || cur), wd = data.loadWeek(week);
  if (!wd) return send(res, 404, {ok: false, error: `Week ${week || '?'} is not set up yet.`, code: 'WEEK'});
  wd.picks_locked = await core.getPicksLocked(db, week, wd, now);
  const n = db ? await core.countEntries(db, week) : null;
  send(res, 200, core.publicGames(wd, week, now, n, cur));
}, {storage: false});
