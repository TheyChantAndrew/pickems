// POST /api/submit  {week, name, tag, picks:{matchup: full team name}, tiebreaker, code?, zq7f (honeypot; legacy name: website)}
const {handler} = require('../lib/handler');
const {send, jsonBody, clientIp, ipHash, logCtx} = require('../lib/http');
const data = require('../lib/data');
const core = require('../lib/core');
module.exports = handler(['POST'], async (req, res, db, now) => {
  const b = await jsonBody(req);
  if (res._pkLog) res._pkLog.ctx = logCtx(b);
  const cur = data.currentWeek();
  const r = await core.submit(db, data.loadWeek(b.week), cur, b, now, ipHash(clientIp(req)));
  send(res, 200, r);
}, {route: 'submit'});
