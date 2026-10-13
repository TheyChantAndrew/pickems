// GET /api/games?week=N  schedule + server-side lock times (no picks). Default week = current.
// GET /api/games?live=1&week=N&dates=YYYY  ESPN scoreboard proxy for live.js (ESPN's CORS header isn't reliable in real
//   browsers, and the Hobby plan is at its 12-function limit, so this rides on /api/games). Same URL as sync_scores.py;
//   returns only the fields live.js reads; cached 15 s at the edge + 10 s per instance; any ESPN failure -> 502 {ok:false}.
const {handler} = require('../lib/handler');
const {send, query} = require('../lib/http');
const data = require('../lib/data');
const core = require('../lib/core');
const {getDb} = require('../lib/db');
const ESPN = process.env.ESPN_SCOREBOARD_URL || 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
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
  if (q.live === '1') return live(req, res, q, now);
  let db = null;   // optional here: the schedule works before the database is connected
  try { db = await getDb(); } catch (e) { db = null; }
  const cur = data.currentWeek(), week = Number(q.week || cur), wd = data.loadWeek(week);
  if (!wd) return send(res, 404, {ok: false, error: `Week ${week || '?'} is not set up yet.`, code: 'WEEK'});
  const n = db ? await core.countEntries(db, week) : null;
  send(res, 200, core.publicGames(wd, week, now, n, cur));
}, {storage: false});
