// Admin portal (/admin) paid toggles. Authorization: Bearer <portal token> (or the box admin token).
//   GET  /api/admin/paid?week=N            -> {entries, fee, weeks, picks_locked, games_count, ...}
//   POST /api/admin/paid {week, name, paid} -> paid toggle
//   POST /api/admin/paid {week, name, void} -> void toggle
//   POST /api/admin/paid {week, lock}       -> picks lock
//   POST /api/admin/paid {week, load_espn:true, year?} -> pull schedule from ESPN, store in meta
//   POST /api/admin/paid {week, make_current:true} -> this week is the live submit week
const {handler} = require('../../lib/handler');
const {send, query, jsonBody, clientIp, ipHash} = require('../../lib/http');
const {paidTokenOk, requestToken} = require('../../lib/auth');
const data = require('../../lib/data');
const core = require('../../lib/core');
const schedule = require('../../lib/schedule');
const H = {'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow'};
module.exports = handler(['GET', 'POST'], async (req, res, db, now) => {
  await core.adminGate(db, requestToken(req, {}, false), paidTokenOk, ipHash(clientIp(req)), now);
  if (req.method === 'GET') {
    const q = query(req), cur = await data.currentWeekAsync(db);
    const week = Number(q.week || cur), wd = await data.loadWeekAsync(db, week);
    const weeks = await data.weeksAsync(db);
    if (!wd) {
      return send(res, 200, {ok: true, week, current_week: cur, weeks, fee: 10, paid_live: false,
                             board_names: [], delete_state: {blocked: false}, picks_locked: await core.getPicksLocked(db, week),
                             games_count: 0, missing: true, entries: []}, H);
    }
    return send(res, 200, {ok: true, week, current_week: cur, weeks, fee: Number(wd.entry_fee || 10),
                           paid_live: await core.paidLive(db, week), board_names: wd.board_names || [], delete_state: core.deleteState(wd, now),
                           picks_locked: await core.getPicksLocked(db, week),
                           games_count: (wd.games || []).length, source: wd.source || 'file',
                           entries: core.paidEntries(await core.readAll(db, week))}, H);
  }
  const b = await jsonBody(req);
  const week = Number(b.week);
  if (b.load_espn) {
    try {
      const year = Number(b.year) || schedule.nflSeasonYear();
      const wd = await schedule.importEspnWeek(db, week, year);
      return send(res, 200, {ok: true, week: wd.week, year: wd.year, games_count: wd.games.length,
                             current_week: await data.currentWeekAsync(db), weeks: await data.weeksAsync(db),
                             games: wd.games.map(g => ({matchup: g.matchup, when: g.kickoff_label, is_monday: !!g.is_monday}))}, H);
    } catch (e) {
      return send(res, 502, {ok: false, error: 'Could not load that week from ESPN. ' + (e && e.message ? e.message : ''), code: 'ESPN'}, H);
    }
  }
  if (b.make_current) {
    const wd = await data.loadWeekAsync(db, week);
    if (!wd) return send(res, 404, {ok: false, error: `Week ${b.week || '?'} has no games yet. Load them from ESPN first.`, code: 'WEEK'}, H);
    const live = await schedule.setLiveWeek(db, week);
    return send(res, 200, {ok: true, week: live, current_week: live, weeks: await data.weeksAsync(db)}, H);
  }
  if (!await data.loadWeekAsync(db, week)) return send(res, 404, {ok: false, error: `Week ${b.week || '?'} is not set up yet.`, code: 'WEEK'}, H);
  if (b.lock !== undefined) {
    if (b.paid !== undefined || b.void !== undefined) return send(res, 400, {ok: false, error: 'Send lock by itself.', code: 'BAD'}, H);
    return send(res, 200, await core.setPicksLocked(db, week, b.lock), H);
  }
  if (b.void !== undefined && b.paid !== undefined) return send(res, 400, {ok: false, error: 'Send paid or void, not both.', code: 'BAD'}, H);
  send(res, 200, b.void !== undefined ? await core.setVoid(db, week, b.name, b.void, now) : await core.setPaid(db, week, b.name, b.paid, now), H);
}, {route: 'admin_paid'});
