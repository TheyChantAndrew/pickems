// GET /api/entries?week=N  public. Monday picks + tiebreakers hidden until Sunday is final. Never edit codes.
const {handler} = require('../lib/handler');
const {send, query} = require('../lib/http');
const data = require('../lib/data');
const core = require('../lib/core');
module.exports = handler(['GET'], async (req, res, redis) => {
  const week = Number(query(req).week || data.currentWeek()), wd = data.loadWeek(week);
  if (!wd) return send(res, 404, {ok: false, error: `Week ${week || '?'} is not set up yet.`, code: 'WEEK'});
  const entries = core.publicEntries(await core.readAll(redis, week), wd);
  send(res, 200, {ok: true, week, sunday_final: !!wd.sunday_final, count: entries.length, entries});
});
