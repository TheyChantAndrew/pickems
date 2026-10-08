// POST /api/admin/paid-seed {week, flags: {"<name>": true|false}, force?}  Authorization: Bearer <box admin token> (NOT the portal token)
// One-time switch-over: copies weekN_picks.json paid flags (web entries) into the DB and marks the week DB-sourced. Run by
// seed_paid.py on the box. A second run for the same week needs force: true (409 SEEDED otherwise).
const {handler} = require('../../lib/handler');
const {send, jsonBody, clientIp, ipHash} = require('../../lib/http');
const {tokenOk, requestToken} = require('../../lib/auth');
const data = require('../../lib/data');
const core = require('../../lib/core');
module.exports = handler(['POST'], async (req, res, db, now) => {
  await core.adminGate(db, requestToken(req, {}, false), tokenOk, ipHash(clientIp(req)), now);
  const b = await jsonBody(req);
  const week = Number(b.week);
  if (!data.loadWeek(week)) return send(res, 404, {ok: false, error: `Week ${b.week || '?'} is not set up yet.`, code: 'WEEK'});
  send(res, 200, await core.seedPaid(db, week, b.flags, b.force === true));
}, {route: 'admin_paid_seed'});
