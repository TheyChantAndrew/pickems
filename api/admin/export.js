// GET /api/admin/export.csv?week=N&key=<admin token>  (or Authorization: Bearer). CSV for Excel. Rewritten from /api/admin/export.csv.
const {handler} = require('../../lib/handler');
const {send, query} = require('../../lib/http');
const {tokenOk, requestToken} = require('../../lib/auth');
const data = require('../../lib/data');
const core = require('../../lib/core');
module.exports = handler(['GET'], async (req, res, redis) => {
  const q = query(req);
  if (!tokenOk(requestToken(req, q, true))) return send(res, 401, {ok: false, error: 'Not authorized', code: 'AUTH'});
  const week = Number(q.week || data.currentWeek()), wd = data.loadWeek(week);
  if (!wd) return send(res, 404, {ok: false, error: `Week ${week || '?'} is not set up yet.`, code: 'WEEK'});
  send(res, 200, core.csv(await core.readAll(redis, week), wd), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="fambash-pickems-week${week}-entries.csv"`,
    'Referrer-Policy': 'no-referrer'});
});
