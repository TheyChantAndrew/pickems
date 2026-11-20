// Admin week lock. Stored in Turso meta as picks_lock:<week> = '1', or the key is absent.
// '1' forces the week locked early. Turning the switch off deletes the key. A missing
// key, and any stored '0' from an older unlock, are the same: the week still locks
// itself at the first kickoff. The switch cannot reopen a week after that.
class UserError extends Error { constructor(msg, code, status) { super(msg); this.code = code; this.status = status || 400; } }

function lockKey(week) { return 'picks_lock:' + Number(week); }

async function getPicksLocked(db, week) {
  if (!db) return null;
  const r = await db.execute({sql: 'SELECT value FROM meta WHERE key = ?', args: [lockKey(week)]});
  if (!r.rows.length || r.rows[0].value !== '1') return null;
  return true;
}

async function setPicksLocked(db, week, locked) {
  if (typeof locked !== 'boolean') throw new UserError('lock must be true or false', 'BAD');
  week = Number(week);
  if (!Number.isInteger(week) || week < 1) throw new UserError('week required', 'BAD');
  const key = lockKey(week);
  if (locked) {
    await db.execute({sql: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: [key, '1']});
  } else {
    await db.execute({sql: 'DELETE FROM meta WHERE key = ?', args: [key]});
  }
  return {ok: true, week, picks_locked: locked};
}

function applyLock(L, locked) {
  // Only force a lock. Never clear one: a started game stays locked, and the
  // first-kickoff lock is not something the admin switch can undo.
  if (locked !== true) return L;
  L.locked = true;
  L.tiebreaker_locked = true;
  (L.games || []).forEach(function (g) { g.locked = true; });
  return L;
}

module.exports = {getPicksLocked, setPicksLocked, applyLock};
