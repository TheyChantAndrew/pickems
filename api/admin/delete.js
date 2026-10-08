// POST /api/admin/delete {week, name}  Authorization: Bearer <portal token> (or the box admin token). The /admin Delete button.
// Logs the full row to deleted_entries and deletes it in one transaction (core.deleteLogged). Same bad-token rate limit as
// /api/admin/paid. 409 FINISHED once the week is over (core.deleteState), 404 for an unknown entry.
const {handler} = require('../../lib/handler');
const {send, jsonBody, clientIp, ipHash} = require('../../lib/http');
const {paidTokenOk, portalTokenOk, requestToken} = require('../../lib/auth');
const data = require('../../lib/data');
const core = require('../../lib/core');
const H = {'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow'};
module.exports = handler(['POST'], async (req, res, db, now) => {
  const token = requestToken(req, {}, false);
  await core.adminGate(db, token, paidTokenOk, ipHash(clientIp(req)), now);
  const b = await jsonBody(req);
  const week = Number(b.week), wd = data.loadWeek(week);
  if (!wd) return send(res, 404, {ok: false, error: `Week ${b.week || '?'} is not set up yet.`, code: 'WEEK'}, H);
  const st = core.deleteState(wd, now);
  if (st.blocked) return send(res, 409, {ok: false, error: st.message, code: 'FINISHED', reason: st.reason}, H);
  send(res, 200, await core.deleteLogged(db, wd, week, b.name, portalTokenOk(token) ? 'portal' : 'admin'), H);
}, {route: 'admin_delete'});
