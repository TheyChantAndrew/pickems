// GET /api/games?week=N  schedule + server-side lock times (no picks). Default week = current.
const {handler} = require('../lib/handler');
const {send, query} = require('../lib/http');
const data = require('../lib/data');
const core = require('../lib/core');
const {getDb} = require('../lib/db');
module.exports = handler(['GET'], async (req, res, _r, now) => {
  let db = null;   // optional here: the schedule works before the database is connected
  try { db = await getDb(); } catch (e) { db = null; }
  const cur = data.currentWeek(), week = Number(query(req).week || cur), wd = data.loadWeek(week);
  if (!wd) return send(res, 404, {ok: false, error: `Week ${week || '?'} is not set up yet.`, code: 'WEEK'});
  const n = db ? await core.countEntries(db, week) : null;
  send(res, 200, core.publicGames(wd, week, now, n, cur));
}, {storage: false});
