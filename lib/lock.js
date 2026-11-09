// Admin-controlled week lock. Stored in Turso meta as picks_lock:<week> = '1'|'0'.
class UserError extends Error { constructor(msg, code, status) { super(msg); this.code = code; this.status = status || 400; } }

function kickoffPassed(wd, nowMs) {
  if (!wd || !Array.isArray(wd.games) || !wd.games.length) return true;
  if (wd.sunday_final || wd.week_done || wd.monday_final) return true;
  const times = wd.games.map(g => Date.parse(g.kickoff)).filter(t => !isNaN(t));
  return times.length ? nowMs >= Math.min(...times) : false;
}
function lockKey(week) { return 'picks_lock:' + Number(week); }

async function getPicksLocked(db, week, wd, nowMs) {
  if (!db) return kickoffPassed(wd, nowMs);
  const key = lockKey(week);
  const r = await db.execute({sql: 'SELECT value FROM meta WHERE key = ?', args: [key]});
  if (r.rows.length) return r.rows[0].value === '1';
  const locked = kickoffPassed(wd, nowMs);
  await db.execute({sql: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', args: [key, locked ? '1' : '0']});
  const r2 = await db.execute({sql: 'SELECT value FROM meta WHERE key = ?', args: [key]});
  return r2.rows.length ? r2.rows[0].value === '1' : locked;
}

async function setPicksLocked(db, week, locked) {
  if (typeof locked !== 'boolean') throw new UserError('lock must be true or false', 'BAD');
  week = Number(week);
  if (!Number.isInteger(week) || week < 1) throw new UserError('week required', 'BAD');
  const key = lockKey(week), val = locked ? '1' : '0';
  await db.execute({sql: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: [key, val]});
  return {ok: true, week, picks_locked: locked};
}

function applyLock(L, locked) {
  if (locked == null) return L;
  locked = !!locked;
  L.locked = locked;
  L.tiebreaker_locked = !L.tiebreaker_game || locked;
  (L.games || []).forEach(function (g) { g.locked = locked; });
  return L;
}

module.exports = {kickoffPassed, getPicksLocked, setPicksLocked, applyLock};
