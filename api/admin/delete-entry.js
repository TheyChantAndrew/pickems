// POST /api/admin/delete-entry  {week, name, clear_rate_limits?}  Authorization: Bearer <admin token>
// Removes one entry (e.g. a live test entry). clear_rate_limits: true also empties the rate-limit table.
const {handler} = require('../../lib/handler');
const {send, jsonBody} = require('../../lib/http');
const {tokenOk, requestToken} = require('../../lib/auth');
const data = require('../../lib/data');
const core = require('../../lib/core');
module.exports = handler(['POST'], async (req, res, db) => {
  if (!tokenOk(requestToken(req, {}, false))) return send(res, 401, {ok: false, error: 'Not authorized', code: 'AUTH'});
  const b = await jsonBody(req);
  const week = Number(b.week);
  if (!data.loadWeek(week)) return send(res, 404, {ok: false, error: `Week ${b.week || '?'} is not set up yet.`, code: 'WEEK'});
  send(res, 200, await core.deleteEntry(db, week, b.name, b.clear_rate_limits === true));
});
