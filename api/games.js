// GET /api/games?week=N  schedule + server-side lock times (no picks). Default week = current.
const {handler} = require('../lib/handler');
const {send, query} = require('../lib/http');
const data = require('../lib/data');
const core = require('../lib/core');
const {getRedis} = require('../lib/redis');
module.exports = handler(['GET'], async (req, res, _r, now) => {
  const redis = getRedis();   // optional here: the schedule works before storage is connected
  const cur = data.currentWeek(), week = Number(query(req).week || cur), wd = data.loadWeek(week);
  if (!wd) return send(res, 404, {ok: false, error: `Week ${week || '?'} is not set up yet.`, code: 'WEEK'});
  const n = redis ? await redis.hlen(core.kEntries(week)) : null;
  send(res, 200, core.publicGames(wd, week, now, n, cur));
}, {storage: false});
