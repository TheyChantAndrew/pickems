// GET /api/admin/entries?week=N  full entries (incl. Monday picks, tiebreakers, edit codes). Authorization: Bearer <admin token>
const {handler} = require('../../lib/handler');
const {send, query} = require('../../lib/http');
const {tokenOk, requestToken} = require('../../lib/auth');
const data = require('../../lib/data');
const core = require('../../lib/core');
module.exports = handler(['GET'], async (req, res, db, now) => {
  const q = query(req);
  if (!tokenOk(requestToken(req, q, false))) return send(res, 401, {ok: false, error: 'Not authorized', code: 'AUTH'}, {'WWW-Authenticate': 'Bearer'});
  const week = Number(q.week || data.currentWeek()), wd = data.loadWeek(week);
  if (!wd) return send(res, 404, {ok: false, error: `Week ${week || '?'} is not set up yet.`, code: 'WEEK'});
  const L = core.withLocks(wd, now);
  send(res, 200, {ok: true, week, now: new Date(now).toISOString(), current_week: data.currentWeek(), sunday_final: !!wd.sunday_final,
                  paid_live: await core.paidLive(db, week),
                  board_names: wd.board_names || [], tiebreaker_game: L.tiebreaker_game, games: L.games,
                  entries: core.adminEntries(await core.readAll(db, week))});
});
