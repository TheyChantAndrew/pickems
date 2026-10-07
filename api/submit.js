// POST /api/submit  {week, name, tag, picks:{matchup: full team name}, tiebreaker, code?, website(honeypot)}
const {handler} = require('../lib/handler');
const {send, jsonBody, clientIp, ipHash} = require('../lib/http');
const data = require('../lib/data');
const core = require('../lib/core');
module.exports = handler(['POST'], async (req, res, redis, now) => {
  const b = await jsonBody(req);
  const cur = data.currentWeek();
  const r = await core.submit(redis, data.loadWeek(b.week), cur, b, now, ipHash(clientIp(req)));
  send(res, 200, r);
});
