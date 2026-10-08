// Box admin token only (restore_entry.py), same bad-token rate limit as the portal endpoints.
//   GET  /api/admin/restore?week=N     -> {deleted: [{log_id, name, tag, paid, paid_at, submitted, deleted, deleted_by, restored_at}]}
//   POST /api/admin/restore {week, name} -> puts the latest unrestored deleted row back exactly; 409 if a live entry has that name
const {handler} = require('../../lib/handler');
const {send, query, jsonBody, clientIp, ipHash} = require('../../lib/http');
const {tokenOk, requestToken} = require('../../lib/auth');
const data = require('../../lib/data');
const core = require('../../lib/core');
module.exports = handler(['GET', 'POST'], async (req, res, db, now) => {
  await core.adminGate(db, requestToken(req, {}, false), tokenOk, ipHash(clientIp(req)), now);
  if (req.method === 'GET') {
    const week = Number(query(req).week || data.currentWeek());
    return send(res, 200, {ok: true, week, deleted: await core.listDeleted(db, week)});
  }
  const b = await jsonBody(req);
  const week = Number(b.week);
  if (!Number.isInteger(week) || week < 1 || week > 30) return send(res, 400, {ok: false, error: 'week required', code: 'BAD'});
  send(res, 200, await core.restoreEntry(db, week, b.name));
}, {route: 'admin_restore'});
