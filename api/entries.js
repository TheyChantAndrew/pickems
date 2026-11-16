// GET /api/entries?week=N  public. Monday picks + tiebreakers hidden until Sunday is final. Never edit codes or paid_at.
// paid_live: true once this week's paid flags live in the DB (live.js then applies each entry's paid to the board).
// tombstones: names deleted in /admin (or by the box) that have no live entry now. Names only, nothing else from the row.
const {handler} = require('../lib/handler');
const {send, query} = require('../lib/http');
const data = require('../lib/data');
const core = require('../lib/core');
const schedule = require('../lib/schedule');
module.exports = handler(['GET'], async (req, res, db) => {
  const week = Number(query(req).week || await data.currentWeekAsync(db));
  const wd = await data.loadWeekAsync(db, week);
  if (!wd) return send(res, 404, {ok: false, error: `Week ${week || '?'} is not set up yet.`, code: 'WEEK'});
  let view = wd;
  try {
    const espn = await schedule.fetchEspnScores(wd.year, week, 4000);
    view = schedule.revealIfReady(wd, espn);
  } catch (e) { view = wd; }
  try {
    const all = await core.readWithTombstones(db, week), entries = core.publicEntries(all.entries, view);
    send(res, 200, {ok: true, week, sunday_final: !!view.sunday_final, paid_live: await core.paidLive(db, week), count: entries.length, entries,
                    tombstones: all.tombstones});
  } catch (e) {
    console.error(e);
    send(res, 200, {ok: true, week, sunday_final: !!wd.sunday_final, paid_live: false, count: 0, entries: [], tombstones: [], degraded: true});
  }
});
