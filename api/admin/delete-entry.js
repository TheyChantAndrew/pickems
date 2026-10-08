// POST /api/admin/delete-entry  {week, name, clear_rate_limits?}  Authorization: Bearer <admin token>
// Removes one entry (e.g. a live test entry), logged to deleted_entries (deleted_by 'admin') like the portal Delete.
// clear_rate_limits: true also empties the rate-limit table. No finished-week guard here (box tool).
const {handler} = require('../../lib/handler');
const {send, jsonBody} = require('../../lib/http');
const {tokenOk, requestToken} = require('../../lib/auth');
const data = require('../../lib/data');
const core = require('../../lib/core');
module.exports = handler(['POST'], async (req, res, db) => {
  if (!tokenOk(requestToken(req, {}, false))) return send(res, 401, {ok: false, error: 'Not authorized', code: 'AUTH'});
  const b = await jsonBody(req);
  const week = Number(b.week);
  const wd = data.loadWeek(week);
  if (!wd) return send(res, 404, {ok: false, error: `Week ${b.week || '?'} is not set up yet.`, code: 'WEEK'});
  send(res, 200, await core.deleteEntry(db, week, b.name, b.clear_rate_limits === true, wd));
});
