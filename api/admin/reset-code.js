// POST /api/admin/reset-code  {week, name}  Authorization: Bearer <admin token>  -> {edit_code} (new code for a player who lost theirs)
const {handler} = require('../../lib/handler');
const {send, jsonBody} = require('../../lib/http');
const {tokenOk, requestToken} = require('../../lib/auth');
const data = require('../../lib/data');
const core = require('../../lib/core');
module.exports = handler(['POST'], async (req, res, db, now) => {
  if (!tokenOk(requestToken(req, {}, false))) return send(res, 401, {ok: false, error: 'Not authorized', code: 'AUTH'});
  const b = await jsonBody(req);
  const week = Number(b.week || data.currentWeek());
  if (!data.loadWeek(week)) return send(res, 404, {ok: false, error: `Week ${week || '?'} is not set up yet.`, code: 'WEEK'});
  send(res, 200, await core.resetCode(db, week, b.name, now));
});
