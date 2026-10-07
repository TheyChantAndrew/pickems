// POST /api/lookup  {week, name, code}  -> your own entry, only with your edit code
const {handler} = require('../lib/handler');
const {send, jsonBody, clientIp, ipHash} = require('../lib/http');
const data = require('../lib/data');
const core = require('../lib/core');
module.exports = handler(['POST'], async (req, res, redis, now) => {
  const b = await jsonBody(req);
  send(res, 200, await core.lookup(redis, data.loadWeek(b.week), b, now, ipHash(clientIp(req))));
});
