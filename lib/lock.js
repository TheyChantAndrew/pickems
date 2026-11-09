// Admin-controlled week lock. Stored in Turso meta as picks_lock:<week> = '1'|'0'.
// Missing key = open. Kickoff time never writes this flag.
class UserError extends Error { constructor(msg, code, status) { super(msg); this.code = code; this.status = status || 400; } }

function lockKey(week) { return 'picks_lock:' + Number(week); }

async function getPicksLocked(db, week) {
  if (!db) return false;
  const r = await db.execute({sql: 'SELECT value FROM meta WHERE key = ?', args: [lockKey(week)]});
  return r.rows.length ? r.rows[0].value === '1' : false;
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

module.exports = {getPicksLocked, setPicksLocked, applyLock};
