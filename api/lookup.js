// POST /api/lookup  {week, name, code}  -> your own entry, only with your edit code
const {handler} = require('../lib/handler');
const {send, jsonBody, clientIp, ipHash, logCtx} = require('../lib/http');
const data = require('../lib/data');
const core = require('../lib/core');
module.exports = handler(['POST'], async (req, res, db, now) => {
  const b = await jsonBody(req);
  if (res._pkLog) res._pkLog.ctx = logCtx(b);
  send(res, 200, await core.lookup(db, data.loadWeek(b.week), b, now, ipHash(clientIp(req))));
}, {route: 'lookup'});
