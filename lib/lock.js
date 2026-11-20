// Admin week lock. Stored in Turso meta as picks_lock:<week> = '1'|'0'.
// '1' forces the week locked. '0' is an explicit unlock and overrides the automatic
// lock at the first kickoff. A missing key means automatic: lock once that game has started.
class UserError extends Error { constructor(msg, code, status) { super(msg); this.code = code; this.status = status || 400; } }

function lockKey(week) { return 'picks_lock:' + Number(week); }

async function getPicksLocked(db, week) {
  if (!db) return null;
  const r = await db.execute({sql: 'SELECT value FROM meta WHERE key = ?', args: [lockKey(week)]});
  if (!r.rows.length) return null;
  return r.rows[0].value === '1';
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
  L.locked = !!locked;
  L.tiebreaker_locked = locked ? true : !L.tiebreaker_game;
  (L.games || []).forEach(function (g) { g.locked = !!locked; });
  return L;
}

module.exports = {getPicksLocked, setPicksLocked, applyLock};
