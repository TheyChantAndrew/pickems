// Admin portal (/admin) paid toggles. Authorization: Bearer <portal token> (or the box admin token).
//   GET  /api/admin/paid?week=N            -> {entries: [{name, tag, submitted, paid, paid_at, paid_at_pt}], fee, weeks, ...}
//   POST /api/admin/paid {week, name, paid} -> {name, paid, paid_at, paid_at_pt, changed}
// Wrong tokens are rate-limited per IP (core.adminGate: 401, then 429). No picks, tiebreakers or edit codes here.
const {handler} = require('../../lib/handler');
const {send, query, jsonBody, clientIp, ipHash} = require('../../lib/http');
const {paidTokenOk, requestToken} = require('../../lib/auth');
const data = require('../../lib/data');
const core = require('../../lib/core');
const H = {'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow'};
module.exports = handler(['GET', 'POST'], async (req, res, db, now) => {
  await core.adminGate(db, requestToken(req, {}, false), paidTokenOk, ipHash(clientIp(req)), now);
  if (req.method === 'GET') {
    const q = query(req), week = Number(q.week || data.currentWeek()), wd = data.loadWeek(week);
    if (!wd) return send(res, 404, {ok: false, error: `Week ${q.week || '?'} is not set up yet.`, code: 'WEEK'}, H);
    return send(res, 200, {ok: true, week, current_week: data.currentWeek(), weeks: data.weeks(), fee: Number(wd.entry_fee || 10),
                           paid_live: await core.paidLive(db, week), board_names: wd.board_names || [],
                           entries: core.paidEntries(await core.readAll(db, week))}, H);
  }
  const b = await jsonBody(req);
  const week = Number(b.week);
  if (!data.loadWeek(week)) return send(res, 404, {ok: false, error: `Week ${b.week || '?'} is not set up yet.`, code: 'WEEK'}, H);
  send(res, 200, await core.setPaid(db, week, b.name, b.paid, now), H);
}, {route: 'admin_paid'});
