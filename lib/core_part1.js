// Fam Bash Pickems: submission rules. Logic over (libSQL client, weekData, now) so tests can drive it directly.
const crypto = require('crypto');

// NAME_MAX / TAG_MAX: the limits for new names and tags, counted after trim + whitespace collapse (build_submit.py mirrors them
// as NAME_MAX / TAG_MAX for maxlength + counters). LEGACY_MAX: the old silent-truncation cap; entries saved before the limits
// can be up to this long and keep working (lookup, edit) unchanged. RAW_MAX only bounds the work on hostile input.
const NAME_MAX = 20, TAG_MAX = 18, LEGACY_MAX = 24, RAW_MAX = 200, TB_MAX = 200, MAX_ENTRIES = 300;
const RATE_WINDOW_S = 600, RATE_MAX = 30;        // per IP: 30 writes / 10 minutes
const BAD_CODE_MAX = 10;                         // per name: 10 wrong edit codes / hour
const ADMIN_BAD_WINDOW_S = 600, ADMIN_BAD_MAX = 10;   // per IP: 10 wrong admin/portal tokens / 10 minutes, then 429
const CODE_ALPHABET = 'ABCDFGHJKMNPQRSTVWXYZ23456789';
const TZ = 'America/Los_Angeles';
const MNF_GRACE_MS = 4 * 3600 * 1000;           // delete guard fallback: last Monday kickoff + 4 h

class UserError extends Error { constructor(msg, code, status) { super(msg); this.code = code; this.status = status || 400; } }

function clean(s, max) {
  s = String(s == null ? '' : s).normalize('NFC');
  s = s.replace(/[\u0000-\u001f\u007f<>"`\\{}\[\]]/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[=+\-@'\s]+/, '');
  if (s.length > max) s = s.slice(0, max).trim();
  return s;
}
const cleanTag = (s, max = TAG_MAX) => clean(String(s == null ? '' : s).replace(/[()]/g, ' '), max);
const nameKey = n => String(n).toLowerCase().replace(/\s+/g, ' ').trim();
const fmtTime = d => new Intl.DateTimeFormat('sv-SE', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false}).format(d) + ' PT';
const fmtIso = iso => iso ? fmtTime(new Date(iso)) : '';
function newCode() { let s = ''; for (let i = 0; i < 4; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]; return s; }
const codeHash = (week, key, code) => crypto.createHash('sha256').update(`fbp-edit:${week}:${key}:${String(code).toUpperCase()}`).digest('hex');
function codeOk(row, week, key, code) {
  if (!code || !row || !/^[0-9a-f]{64}$/.test(row.edit_code_hash)) return false;
  return crypto.timingSafeEqual(Buffer.from(codeHash(week, key, code), 'hex'), Buffer.from(row.edit_code_hash, 'hex'));
}

/** Lock state is admin-controlled (portal toggle on /admin). Kickoff times stay on
 *  the games for the board clock; they do not close submissions. Monday hide is sunday_final. */
function withLocks(wd, nowMs) {
  const games = wd.games.map(g => Object.assign({}, g));
  let lastSunday = 0;
  for (const g of games) {
    g._t = Date.parse(g.kickoff);
    if (isNaN(g._t)) throw new Error('bad kickoff for ' + g.matchup);
    if (!g.is_monday && g._t > lastSunday) lastSunday = g._t;
  }
  const firstKick = games.length ? Math.min(...games.map(g => g._t)) : 0;
  const weekLocked = wd.picks_locked === true;
  for (const g of games) {
    g.lock_at = firstKick ? new Date(firstKick).toISOString() : null;
    g.locked = weekLocked;
    delete g._t;
  }
  const tb = games.find(g => g.is_tiebreaker) || games.find(g => g.is_monday) || games[games.length - 1];
  return {lock_at: firstKick ? new Date(firstKick).toISOString() : null, locked: weekLocked, games, tiebreaker_game: tb ? tb.matchup : null, tiebreaker_lock_at: firstKick ? new Date(firstKick).toISOString() : null,
          tiebreaker_locked: !tb || weekLocked, last_sunday_kickoff: lastSunday ? new Date(lastSunday).toISOString() : null};
}

function rowToEntry(r) {
  let picks = {};
  try { picks = JSON.parse(r.picks || '{}') || {}; } catch (e) { picks = {}; }
  return {id: Number(r.id), week: Number(r.week), name: r.name, name_key: r.name_key, tag: r.tag, picks,
          tiebreaker: r.tiebreaker == null ? null : Number(r.tiebreaker), paid: !!Number(r.paid), paid_at: r.paid_at || null,
          paid_at_pt: fmtIso(r.paid_at), void: !!Number(r.void || 0), void_at: r.void_at || null, void_at_pt: fmtIso(r.void_at), source: r.source || 'web',
          notes: r.notes || '', version: Number(r.version), edit_code_hash: r.edit_code_hash,
          created_at: r.created_at, updated_at: r.updated_at, submitted: fmtIso(r.created_at), updated: fmtIso(r.updated_at)};
}
async function getEntry(db, week, key) {
  const r = await db.execute({sql: 'SELECT * FROM entries WHERE week = ? AND name_key = ?', args: [week, key]});
  return r.rows.length ? rowToEntry(r.rows[0]) : null;
}
async function readAll(db, week) {
  const r = await db.execute({sql: 'SELECT * FROM entries WHERE week = ? ORDER BY created_at, id', args: [Number(week)]});
  return r.rows.map(rowToEntry);
}
async function countEntries(db, week) {
  const r = await db.execute({sql: 'SELECT COUNT(*) AS n FROM entries WHERE week = ?', args: [Number(week)]});
  return Number(r.rows[0].n);
}

/** Atomic counter in rate_limits (UPSERT ... RETURNING). Returns the new count. */
async function bump(db, bucket, expiresAt, nowMs) {
  const r = await db.execute({sql: `INSERT INTO rate_limits (bucket, count, expires_at) VALUES (?, 1, ?)
                                    ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count`, args: [bucket, expiresAt]});
  if (crypto.randomInt(50) === 0) await db.execute({sql: 'DELETE FROM rate_limits WHERE expires_at < ?', args: [nowMs]});   // housekeeping
  return Number(r.rows[0].count);
}
async function peek(db, bucket, nowMs) {
  const r = await db.execute({sql: 'SELECT count FROM rate_limits WHERE bucket = ? AND expires_at > ?', args: [bucket, nowMs]});
  return r.rows.length ? Number(r.rows[0].count) : 0;
}
async function rateLimit(db, ipH, nowMs) {
  const win = Math.floor(nowMs / 1000 / RATE_WINDOW_S);
  const n = await bump(db, `ip:${ipH}:${win}`, (win + 1) * RATE_WINDOW_S * 1000 + 60000, nowMs);
  if (n > RATE_MAX) throw new UserError('Too many tries from this connection. Wait a few minutes and try again.', 'RATE', 429);
}
const badBucket = (week, key, nowMs) => `bad:${week}:${key}:${Math.floor(nowMs / 3600000)}`;
async function badCodeCheck(db, week, key, nowMs) {
  if (await peek(db, badBucket(week, key, nowMs), nowMs) >= BAD_CODE_MAX)
    throw new UserError('Too many wrong edit codes for that name. Try again in an hour or ask Andy.', 'RATE', 429);
}
async function badCodeHit(db, week, key, nowMs) {
  await bump(db, badBucket(week, key, nowMs), (Math.floor(nowMs / 3600000) + 1) * 3600000 + 60000, nowMs);
}

// ---- paid status (Turso is the source of truth for web entries; see HOOKS.md ADMIN_HOOKS) ----
/** Wrong admin/portal tokens per IP: 429 once ADMIN_BAD_MAX bad tries hit this 10-minute window (checked BEFORE the token,
 *  so a locked-out IP learns nothing more), each bad token counts one. ok(token) is the token check to run. */
async function adminGate(db, token, ok, ipH, nowMs) {
  const win = Math.floor(nowMs / 1000 / ADMIN_BAD_WINDOW_S), bucket = `admbad:${ipH}:${win}`;
  if (await peek(db, bucket, nowMs) >= ADMIN_BAD_MAX)
    throw new UserError('Too many wrong keys from this connection. Wait 10 minutes and try again.', 'RATE', 429);
  if (ok(token)) return;
  await bump(db, bucket, (win + 1) * ADMIN_BAD_WINDOW_S * 1000 + 60000, nowMs);
  throw new UserError(token ? 'That admin link is not valid. Open the exact link you were given.' : 'Not authorized', 'AUTH', 401);
}
/** True once the paid flags of this week live in the DB (paid-seed ran for this week or an earlier one). Until then the
 *  board JSON stays the source and live.js / the sync ignore the DB's paid column. */
async function paidLive(db, week) {
  const r = await db.execute({sql: "SELECT value FROM meta WHERE key = 'paid_db_from_week'", args: []});
  const from = r.rows.length ? Number(r.rows[0].value) : NaN;
  return Number.isInteger(from) && Number(week) >= from;
}
/** Admin portal list: every DB entry of the week (name, tag, submitted, paid, paid_at, void, void_at), never picks/codes. */
function paidEntries(entries) {
  return entries.map(e => ({name: e.name, tag: e.tag, submitted: e.submitted, created_at: e.created_at, paid: !!e.paid,
                            paid_at: e.paid_at, paid_at_pt: e.paid_at_pt, void: !!e.void, void_at: e.void_at, void_at_pt: e.void_at_pt}));
}
/** Admin: set paid on/off. paid_at = now when it turns on, NULL when off. Same value again = no-op (keeps paid_at), so a
 *  retried tap is safe. Never touches picks, version or updated_at. */
async function setPaid(db, week, name, paid, nowMs) {
  if (typeof paid !== 'boolean') throw new UserError('paid must be true or false', 'BAD');
  const key = nameKey(clean(name, LEGACY_MAX));
  if (!key) throw new UserError('name required', 'BAD');
  const nowIso = new Date(nowMs).toISOString();
  const rs = await db.batch([
    {sql: `UPDATE entries SET paid = ?, paid_at = CASE WHEN ? = 1 THEN ? ELSE NULL END
           WHERE week = ? AND name_key = ? AND paid <> ?`, args: [paid ? 1 : 0, paid ? 1 : 0, nowIso, week, key, paid ? 1 : 0]},
    {sql: 'SELECT * FROM entries WHERE week = ? AND name_key = ?', args: [week, key]},
  ], 'write');
  if (!rs[1].rows.length) throw new UserError('No entry with that name this week.', 'NOT_FOUND', 404);
  const e = rowToEntry(rs[1].rows[0]);
  return {ok: true, week, name: e.name, paid: e.paid, paid_at: e.paid_at, paid_at_pt: e.paid_at_pt, changed: rs[0].rowsAffected === 1};
}
/** Admin: void on/off (same auth, rate limit and shape as setPaid; POST /api/admin/paid {week, name, void}). A voided
 *  entry stays on the board with its picks, stamped VOID, and can't lead or win (pickems_status / live.js skip it).
 *  void_at = now when it turns on, NULL when off; same value again = no-op. Never touches picks, paid, version or
 *  updated_at. No finished-week block (unlike delete): the \"voided at first win\" rule is applied once the week is decided. */
async function setVoid(db, week, name, voided, nowMs) {
  if (typeof voided !== 'boolean') throw new UserError('void must be true or false', 'BAD');
  const key = nameKey(clean(name, LEGACY_MAX));
  if (!key) throw new UserError('name required', 'BAD');
  const nowIso = new Date(nowMs).toISOString(), v = voided ? 1 : 0;
  const rs = await db.batch([
    {sql: `UPDATE entries SET void = ?, void_at = CASE WHEN ? = 1 THEN ? ELSE NULL END
           WHERE week = ? AND name_key = ? AND void <> ?`, args: [v, v, nowIso, week, key, v]},
    {sql: 'SELECT * FROM entries WHERE week = ? AND name_key = ?', args: [week, key]},
  ], 'write');
  if (!rs[1].rows.length) throw new UserError('No entry with that name this week.', 'NOT_FOUND', 404);
  const e = rowToEntry(rs[1].rows[0]);
  return {ok: true, week, name: e.name, void: e.void, void_at: e.void_at, void_at_pt: e.void_at_pt, paid: e.paid, changed: rs[0].rowsAffected === 1};
}
/** Admin (box admin token only): one-time copy of weekN_picks.json paid flags into the DB for the switch-over.
 *  flags = {\"<name>\": true|false}. Seeded rows get paid_at NULL (paid before the portal existed). Unknown names are reported,
 *  never created. Marks the week as DB-sourced (meta paid_db_from_week). A second run needs force: true. */
async function seedPaid(db, week, flags, force) {
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) throw new UserError('flags must be {name: true|false}', 'BAD');
  const names = Object.keys(flags);
  if (!names.length || names.length > MAX_ENTRIES || names.some(n => typeof flags[n] !== 'boolean')) throw new UserError('flags must be {name: true|false}', 'BAD');
  const done = await db.execute({sql: 'SELECT value FROM meta WHERE key = ?', args: [`paid_seeded:${week}`]});
  if (done.rows.length && !force) throw new UserError(`Week ${week} paid flags were already seeded at ${done.rows[0].value}.`, 'SEEDED', 409);
  const have = new Set((await readAll(db, week)).map(e => e.name_key));
  const stmts = [], matched = [], unmatched = [];
  for (const n of names) {
    const key = nameKey(clean(n, LEGACY_MAX));
    if (!key || !have.has(key)) { unmatched.push(String(n).slice(0, 40)); continue; }
    matched.push(n);
    stmts.push({sql: 'UPDATE entries SET paid = ?, paid_at = NULL WHERE week = ? AND name_key = ?', args: [flags[n] ? 1 : 0, week, key]});
  }
  const iso = new Date().toISOString();
  stmts.push({sql: `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [`paid_seeded:${week}`, iso]});
  stmts.push({sql: `INSERT INTO meta (key, value) VALUES ('paid_db_from_week', ?)
                    ON CONFLICT(key) DO UPDATE SET value = CASE WHEN CAST(meta.value AS INTEGER) <= CAST(excluded.value AS INTEGER) THEN meta.value ELSE excluded.value END`,
               args: [String(week)]});
  await db.batch(stmts, 'write');
  const after = (await readAll(db, week)).map(e => ({name: e.name, paid: e.paid}));
  return {ok: true, week, matched: matched.length, unmatched, paid_live: await paidLive(db, week), entries: after};
}

module.exports = {
  crypto: require('crypto'),
  UserError, clean, cleanTag, nameKey, fmtTime, fmtIso, newCode, codeHash, codeOk,
  withLocks, rowToEntry, getEntry, readAll, countEntries, bump, peek, rateLimit,
  badBucket, badCodeCheck, badCodeHit, adminGate, paidLive, paidEntries, setPaid,
  setVoid, seedPaid, NAME_MAX, TAG_MAX, LEGACY_MAX, RAW_MAX, TB_MAX, MAX_ENTRIES,
  RATE_WINDOW_S, RATE_MAX, BAD_CODE_MAX, ADMIN_BAD_WINDOW_S, ADMIN_BAD_MAX,
  CODE_ALPHABET, TZ, MNF_GRACE_MS
};
