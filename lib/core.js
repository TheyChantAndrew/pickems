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

/** Lock times. Each game locks at kickoff; Monday games and the tiebreaker lock at the LAST SUNDAY kickoff
 *  (latest non-Monday kickoff), or immediately once Sunday is final. */
function withLocks(wd, nowMs) {
  const games = wd.games.map(g => Object.assign({}, g));
  let lastSunday = 0;
  for (const g of games) {
    g._t = Date.parse(g.kickoff);
    if (isNaN(g._t)) throw new Error('bad kickoff for ' + g.matchup);
    if (!g.is_monday && g._t > lastSunday) lastSunday = g._t;
  }
  const sundayFinal = !!wd.sunday_final;
  for (const g of games) {
    let lockAt = g._t;
    if (g.is_monday && lastSunday && lastSunday < lockAt) lockAt = lastSunday;
    g.lock_at = new Date(lockAt).toISOString();
    g.locked = nowMs >= lockAt || (g.is_monday && sundayFinal);
    delete g._t;
  }
  const tb = games.find(g => g.is_tiebreaker) || games.find(g => g.is_monday) || games[games.length - 1];
  let tbLockAt = tb ? Date.parse(tb.lock_at) : 0;
  if (lastSunday && lastSunday < tbLockAt) tbLockAt = lastSunday;
  const tbLocked = !tb || nowMs >= tbLockAt || sundayFinal;
  return {games, tiebreaker_game: tb ? tb.matchup : null, tiebreaker_lock_at: tb ? new Date(tbLockAt).toISOString() : null,
          tiebreaker_locked: tbLocked, last_sunday_kickoff: lastSunday ? new Date(lastSunday).toISOString() : null};
}

function rowToEntry(r) {
  let picks = {};
  try { picks = JSON.parse(r.picks || '{}') || {}; } catch (e) { picks = {}; }
  return {id: Number(r.id), week: Number(r.week), name: r.name, name_key: r.name_key, tag: r.tag, picks,
          tiebreaker: r.tiebreaker == null ? null : Number(r.tiebreaker), paid: !!Number(r.paid), paid_at: r.paid_at || null,
          paid_at_pt: fmtIso(r.paid_at), source: r.source || 'web',
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
/** Admin portal list: every DB entry of the week (name, tag, submitted, paid, paid_at), never picks/codes. */
function paidEntries(entries) {
  return entries.map(e => ({name: e.name, tag: e.tag, submitted: e.submitted, created_at: e.created_at, paid: !!e.paid,
                            paid_at: e.paid_at, paid_at_pt: e.paid_at_pt}));
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
/** Admin (box admin token only): one-time copy of weekN_picks.json paid flags into the DB for the switch-over.
 *  flags = {"<name>": true|false}. Seeded rows get paid_at NULL (paid before the portal existed). Unknown names are reported,
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
  await db.batch(stmts, 'write');                // one transaction
  const after = (await readAll(db, week)).map(e => ({name: e.name, paid: e.paid}));
  return {ok: true, week, matched: matched.length, unmatched, paid_live: await paidLive(db, week), entries: after};
}

function publicGames(wd, week, nowMs, entriesCount, currentWeek) {
  const L = withLocks(wd, nowMs);
  return {ok: true, week, now: new Date(nowMs).toISOString(), current_week: currentWeek,
          open: wd.open !== false && week === currentWeek, sunday_final: !!wd.sunday_final, entries_count: entriesCount,
          tiebreaker_game: L.tiebreaker_game, tiebreaker_lock_at: L.tiebreaker_lock_at, tiebreaker_locked: L.tiebreaker_locked,
          games: L.games.map(g => ({matchup: g.matchup, away: g.away, home: g.home, away_team: g.away_team, home_team: g.home_team,
                                    kickoff: g.kickoff, kickoff_label: g.kickoff_label, is_monday: g.is_monday, lock_at: g.lock_at, locked: g.locked}))};
}

async function submit(db, wd, currentWeek, b, nowMs, ipH) {
  // honeypot (hidden off-screen field, nonsense name so autofill skips it): an explicit error, never a fake success,
  // so a real player whose browser somehow filled it sees a message instead of thinking they're in
  const hp = b.zq7f != null ? b.zq7f : b.website;
  if (hp != null && String(hp).trim() !== '') throw new UserError("Your entry didn't go through: our spam check tripped. Reload the page and submit again. If it keeps happening, text Andy.", 'BOT', 400);
  await rateLimit(db, ipH, nowMs);
  const week = Number(b.week);
  if (!week || !wd || week !== currentWeek || wd.open === false) throw new UserError(`Week ${b.week || '?'} is not taking picks right now.`, 'WEEK');
  const L = withLocks(wd, nowMs);
  const games = L.games;
  let name = clean(b.name, RAW_MAX), tag = cleanTag(b.tag, RAW_MAX);
  if (!name) throw new UserError('Please enter your name.', 'NAME');
  if (!/[A-Za-z0-9\u00C0-\uFFFF]/.test(name)) throw new UserError('Please use letters or numbers in your name.', 'NAME');
  if (!tag) throw new UserError('Please enter your tag (your crew, like FAM BASH).', 'TAG');
  // Length limits. Grandfathering: before these limits, names/tags were silently cut to LEGACY_MAX and saved. An over-limit
  // name is only accepted when it matches an entry that already exists this week (same legacy-cut name_key the old code
  // used), and that path still needs the right edit code below. Otherwise 400 here: no entries row is written for it.
  if (name.length > NAME_MAX) {
    const legacy = clean(b.name, LEGACY_MAX);
    if (!(await getEntry(db, week, nameKey(legacy)))) throw new UserError(`Name must be ${NAME_MAX} characters or fewer.`, 'NAME_LONG');
    name = legacy;
  }
  const tagLong = tag.length > TAG_MAX;      // checked against the stored tag once we know whether this is a new entry or an edit
  if (tagLong) tag = cleanTag(b.tag, LEGACY_MAX);
  const tagErr = () => new UserError(`Tag must be ${TAG_MAX} characters or fewer.`, 'TAG_LONG');

  const byM = Object.fromEntries(games.map(g => [g.matchup, g]));
  const accepted = {}, lockedIgnored = [], invalid = [];
  const picksIn = (b.picks && typeof b.picks === 'object' && !Array.isArray(b.picks)) ? b.picks : {};
  for (const m of Object.keys(picksIn).slice(0, 40)) {
    const g = byM[m], team = String(picksIn[m] || '').trim();
    if (!team) continue;
    if (!g || (team !== g.away_team && team !== g.home_team)) { invalid.push(String(m).slice(0, 20)); continue; }
    if (g.locked) { lockedIgnored.push(m); continue; }
    accepted[m] = team;
  }
  let tb = null, tbIgnored = false;
  if (b.tiebreaker !== '' && b.tiebreaker != null) {
    tb = Number(b.tiebreaker);
    if (!Number.isInteger(tb) || tb < 0 || tb > TB_MAX) throw new UserError(`Tiebreaker must be a whole number from 0 to ${TB_MAX}.`, 'TB');
    if (L.tiebreaker_locked) { tbIgnored = true; tb = null; }
  }
  const key = nameKey(name);
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await getEntry(db, week, key);
    const nowIso = new Date(nowMs).toISOString();
    const openGames = games.filter(g => !g.locked);
    if (!existing) {
      if (name.length > NAME_MAX) throw new UserError(`Name must be ${NAME_MAX} characters or fewer.`, 'NAME_LONG');   // entry vanished since the check above
      if (tagLong) throw tagErr();                // new entry: no grandfathering, rejected before the INSERT below
      if ((wd.board_names || []).map(nameKey).includes(key))
        throw new UserError(`"${name}" is already on the Week ${week} board (paper entry). If that's you, you're already in. Otherwise add a last initial, like "${name} R".`, 'TAKEN');
      if (!openGames.length || L.tiebreaker_locked) throw new UserError(`Week ${week} entries are closed: the games have started.`, 'CLOSED');
      const missing = openGames.filter(g => !accepted[g.matchup]).map(g => g.matchup);
      if (missing.length) throw new UserError("Pick every game that hasn't started yet. Missing: " + missing.join(', '), 'MISSING');
      if (tb == null) throw new UserError(`Please enter your tiebreaker (total points in ${L.tiebreaker_game}).`, 'TB');
      const code = newCode(), notes = lockedIgnored.length ? 'Started before entry: ' + lockedIgnored.join(', ') : '';
      // one write batch (single transaction): insert only if the name is free AND the week isn't full, then read back
      const rs = await db.batch([
        {sql: `INSERT INTO entries (week, name, name_key, tag, picks, tiebreaker, edit_code_hash, paid, source, notes, version, created_at, updated_at)
               SELECT ?, ?, ?, ?, ?, ?, ?, 0, 'web', ?, 1, ?, ? WHERE (SELECT COUNT(*) FROM entries WHERE week = ?) < ?
               ON CONFLICT(week, name_key) DO NOTHING`,
         args: [week, name, key, tag, JSON.stringify(accepted), tb, codeHash(week, key, code), notes, nowIso, nowIso, week, MAX_ENTRIES]},
        {sql: 'SELECT (SELECT COUNT(*) FROM entries WHERE week = ?) AS n, (SELECT edit_code_hash FROM entries WHERE week = ? AND name_key = ?) AS h',
         args: [week, week, key]},
      ], 'write');
      if (rs[0].rowsAffected === 1) {
        const entry = {name, tag, picks: accepted, tiebreaker: tb, paid: false, code};
        return result('created', entry, games, lockedIgnored, invalid, tbIgnored, week);
      }
      if (!rs[1].rows[0].h && Number(rs[1].rows[0].n) >= MAX_ENTRIES) throw new UserError('Entry limit reached for this week. Ask Andy.', 'FULL');
      continue;                                   // someone just took this name: re-read and treat as an edit
    }
    const code = String(b.code || '').trim().toUpperCase().slice(0, 12);
    if (code) await badCodeCheck(db, week, key, nowMs);
    if (!codeOk(existing, week, key, code)) {
      if (code) await badCodeHit(db, week, key, nowMs);
      throw new UserError(`Someone named "${existing.name}" already entered Week ${week}. If that's you, enter your edit code to change picks. If not, add a last initial to your name.`, 'NEED_CODE', 409);
    }
    // edit with the right code: an over-limit tag is fine only if it's the tag already saved (grandfathered); changing it
    // means picking one within the limit
    if (tagLong) { if (nameKey(tag) !== nameKey(existing.tag || '')) throw tagErr(); tag = existing.tag; }
    const merged = {};
    for (const g of games) {
      const old = existing.picks[g.matchup];
      if (g.locked) { if (old) merged[g.matchup] = old; }      // locked picks never change
      else if (accepted[g.matchup]) merged[g.matchup] = accepted[g.matchup];
      else if (old) merged[g.matchup] = old;
    }
    const newTb = tb != null ? tb : existing.tiebreaker;
    // compare-and-swap on version inside a write batch: a concurrent edit makes rowsAffected 0 and we retry on fresh data
    const rs = await db.batch([
      {sql: `UPDATE entries SET picks = ?, tiebreaker = ?, tag = ?, updated_at = ?, version = version + 1
             WHERE id = ? AND version = ? AND edit_code_hash = ?`,
       args: [JSON.stringify(merged), newTb, tag, nowIso, existing.id, existing.version, existing.edit_code_hash]},
    ], 'write');
    if (rs[0].rowsAffected !== 1) continue;
    const entry = {name: existing.name, tag, picks: merged, tiebreaker: newTb, paid: existing.paid, code};
    return result('updated', entry, games, lockedIgnored, invalid, tbIgnored, week);
  }
  throw new UserError('The site is busy, please tap Submit again.', 'BUSY', 503);
}

function result(status, e, games, lockedIgnored, invalid, tbIgnored, week) {
  const notes = [];
  if (lockedIgnored.length) notes.push('Already started, kept as before: ' + lockedIgnored.join(', '));
  if (invalid.length) notes.push('Ignored unknown picks: ' + invalid.join(', '));
  if (tbIgnored) notes.push('Tiebreaker is locked, kept as before.');
  return {ok: true, status, week, name: e.name, tag: e.tag, edit_code: e.code, picks: e.picks, tiebreaker: e.tiebreaker,
          picked: Object.keys(e.picks).length, games: games.length, locked_ignored: lockedIgnored, invalid, tiebreaker_ignored: tbIgnored,
          paid: !!e.paid, message: (status === 'created' ? `You're in for Week ${week}!` : 'Picks updated.') + (notes.length ? ' ' + notes.join(' ') : '')};
}

async function lookup(db, wd, b, nowMs, ipH) {
  await rateLimit(db, ipH, nowMs);
  const week = Number(b.week);
  if (!wd) throw new UserError('Unknown week.', 'WEEK');
  const key = nameKey(clean(b.name, LEGACY_MAX)), code = String(b.code || '').trim().toUpperCase().slice(0, 12);
  if (!key || !code) throw new UserError('Enter your name and edit code.', 'NOT_FOUND', 404);
  await badCodeCheck(db, week, key, nowMs);
  const e = await getEntry(db, week, key);
  if (!e || !codeOk(e, week, key, code)) {
    if (e) await badCodeHit(db, week, key, nowMs);
    throw new UserError('No entry found for that name and edit code.', 'NOT_FOUND', 404);
  }
  return {ok: true, week, name: e.name, tag: e.tag, picks: e.picks, tiebreaker: e.tiebreaker, paid: e.paid, edit_code: code};
}

/** Admin: issue a new edit code for someone who lost theirs (only the hash is stored, so codes can't be read back). */
async function resetCode(db, week, name, nowMs) {
  const key = nameKey(clean(name, LEGACY_MAX));
  const e = key && await getEntry(db, week, key);
  if (!e) throw new UserError('No entry with that name this week.', 'NOT_FOUND', 404);
  const code = newCode();
  await db.batch([{sql: 'UPDATE entries SET edit_code_hash = ?, updated_at = ?, version = version + 1 WHERE id = ?',
                   args: [codeHash(week, key, code), new Date(nowMs).toISOString(), e.id]}], 'write');
  return {ok: true, week, name: e.name, edit_code: code};
}

// ---- deletes (logged), tombstones, restore ----
/** Finished-week guard for portal deletes. Signal: data/weekN.json (built from weekN_picks.json by publish.sh, so it carries
 *  sync_scores.py's results): monday_final (every Monday game final) or week_done (winner recorded) => closed. Fallback,
 *  for a lagging/missed publish: closed from the last Monday kickoff + 4 h. mnf_started (kickoff passed, not closed) =>
 *  allowed, the portal adds a warning. */
function deleteState(wd, nowMs) {
  const mon = (wd.games || []).filter(g => g.is_monday).map(g => Date.parse(g.kickoff)).filter(t => !isNaN(t));
  const kick = mon.length ? Math.max(...mon) : null;
  let blocked = false, reason = null;
  if (wd.monday_final || wd.week_done) { blocked = true; reason = 'final'; }
  else if (kick != null && nowMs >= kick + MNF_GRACE_MS) { blocked = true; reason = 'mnf_kickoff_plus_4h'; }
  return {blocked, reason, mnf_started: kick != null && nowMs >= kick, mnf_kickoff: kick != null ? new Date(kick).toISOString() : null,
          message: blocked ? `Week ${wd.week} is finished (Monday night's game is over), so entries can't be deleted anymore.` : null};
}
/** Delete one entry: copy the full row into deleted_entries, then delete it, in ONE write transaction (compare-and-swap on
 *  id + version, so the logged copy is exactly the row removed). Also drops its wrong-code counters. by = 'portal'|'admin'. */
async function deleteLogged(db, wd, week, name, by, opts = {}) {
  const key = nameKey(clean(name, LEGACY_MAX));
  if (!key) throw new UserError('name required', 'BAD');
  const tb = (wd && (wd.games || []).find(g => g.is_tiebreaker)) || null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const e = await getEntry(db, week, key);
    if (!e) throw new UserError('No entry with that name this week.', 'NOT_FOUND', 404);
    const monday = tb ? (e.picks[tb.matchup] || null) : null, nowIso = new Date().toISOString();
    const stmts = [
      {sql: `INSERT INTO deleted_entries (entry_id, week, name, name_key, tag, picks, tiebreaker, monday_pick, edit_code_hash, paid, paid_at,
                                          source, notes, version, created_at, updated_at, deleted_at, deleted_by)
             SELECT id, week, name, name_key, tag, picks, tiebreaker, ?, edit_code_hash, paid, paid_at, source, notes, version, created_at,
                    updated_at, ?, ? FROM entries WHERE id = ? AND version = ?`,
       args: [monday, nowIso, by === 'portal' ? 'portal' : 'admin', e.id, e.version]},
      {sql: 'DELETE FROM entries WHERE id = ? AND version = ? AND changes() = 1', args: [e.id, e.version]},
      {sql: "DELETE FROM rate_limits WHERE bucket LIKE ? ESCAPE '\\'", args: [`bad:${week}:${key.replace(/[\\%_]/g, c => '\\' + c)}:%`]},
    ];
    if (opts.clearRateLimits) stmts.push({sql: 'DELETE FROM rate_limits', args: []});
    stmts.push({sql: 'SELECT COUNT(*) AS n FROM entries WHERE week = ?', args: [week]});
    const rs = await db.batch(stmts, 'write');
    if (rs[0].rowsAffected !== 1 || rs[1].rowsAffected !== 1) {
      if (rs[0].rowsAffected !== rs[1].rowsAffected) throw new Error('delete log mismatch');   // batch is one transaction: never half
      continue;                                    // edited meanwhile: re-read, log the new version
    }
    return {ok: true, week, deleted: 1, name: e.name, name_key: key, tag: e.tag, paid: e.paid, paid_at: e.paid_at, deleted_by: by === 'portal' ? 'portal' : 'admin',
            rate_limits_cleared: !!opts.clearRateLimits, remaining: Number(rs[rs.length - 1].rows[0].n)};
  }
  throw new UserError('The site is busy, please try again.', 'BUSY', 503);
}
/** Box admin (delete-entry): same logged delete, old response shape. */
async function deleteEntry(db, week, name, clearRateLimits, wd) {
  const r = await deleteLogged(db, wd || null, week, name, 'admin', {clearRateLimits});
  return {ok: true, week, deleted: r.deleted, name_key: r.name_key, rate_limits_cleared: r.rate_limits_cleared, remaining: r.remaining};
}
const TOMB_SQL = `SELECT MAX(d.name) AS name FROM deleted_entries d WHERE d.week = ? AND d.restored_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.week = d.week AND e.name_key = d.name_key)
                  GROUP BY d.name_key ORDER BY MIN(d.deleted_at)`;
/** Entries + tombstones (deleted names with no live entry) from ONE read snapshot. */
async function readWithTombstones(db, week) {
  const rs = await db.batch([{sql: 'SELECT * FROM entries WHERE week = ? ORDER BY created_at, id', args: [Number(week)]},
                             {sql: TOMB_SQL, args: [Number(week)]}], 'read');
  return {entries: rs[0].rows.map(rowToEntry), tombstones: rs[1].rows.map(r => r.name)};
}
/** Admin (box): deleted rows for a week, newest first. No picks / tiebreaker / code hash. */
async function listDeleted(db, week) {
  const r = await db.execute({sql: `SELECT id, entry_id, name, tag, monday_pick IS NOT NULL AS has_monday, paid, paid_at, created_at, updated_at,
                                           deleted_at, deleted_by, restored_at FROM deleted_entries WHERE week = ? ORDER BY deleted_at DESC, id DESC`,
                                    args: [Number(week)]});
  return r.rows.map(x => ({log_id: Number(x.id), entry_id: Number(x.entry_id), name: x.name, tag: x.tag, paid: !!Number(x.paid), paid_at: x.paid_at || null,
                           submitted: fmtIso(x.created_at), deleted_at: x.deleted_at, deleted: fmtIso(x.deleted_at), deleted_by: x.deleted_by,
                           restored_at: x.restored_at || null}));
}
/** Admin (box): put the latest not-yet-restored deleted row for that name back into entries exactly (same id when free,
 *  edit-code hash, paid, paid_at, version, timestamps) and mark the log row restored (clears the tombstone). 409 if a live
 *  entry has that name (e.g. they resubmitted). One transaction. */
async function restoreEntry(db, week, name) {
  const key = nameKey(clean(name, LEGACY_MAX));
  if (!key) throw new UserError('name required', 'BAD');
  if (await getEntry(db, week, key)) throw new UserError(`A live entry named "${name}" already exists in Week ${week}; delete it first or pick another row.`, 'EXISTS', 409);
  const r = await db.execute({sql: `SELECT * FROM deleted_entries WHERE week = ? AND name_key = ? AND restored_at IS NULL ORDER BY deleted_at DESC, id DESC LIMIT 1`,
                              args: [week, key]});
  if (!r.rows.length) throw new UserError('No deleted entry with that name this week.', 'NOT_FOUND', 404);
  const d = r.rows[0];
  const idFree = !(await db.execute({sql: 'SELECT 1 FROM entries WHERE id = ?', args: [d.entry_id]})).rows.length;
  const cols = 'week, name, name_key, tag, picks, tiebreaker, edit_code_hash, paid, paid_at, source, notes, version, created_at, updated_at';
  const nowIso = new Date().toISOString();
  const rs = await db.batch([
    {sql: `INSERT INTO entries (${idFree ? 'id, ' : ''}${cols}) SELECT ${idFree ? 'entry_id, ' : ''}${cols} FROM deleted_entries
           WHERE id = ? AND restored_at IS NULL ON CONFLICT(week, name_key) DO NOTHING`, args: [d.id]},
    {sql: 'UPDATE deleted_entries SET restored_at = ? WHERE id = ? AND restored_at IS NULL AND changes() = 1', args: [nowIso, d.id]},
  ], 'write');
  if (rs[0].rowsAffected !== 1 || rs[1].rowsAffected !== 1) throw new UserError('Someone else just took that name; nothing restored.', 'EXISTS', 409);
  const e = await getEntry(db, week, key);
  return {ok: true, week, name: e.name, tag: e.tag, paid: e.paid, paid_at: e.paid_at, submitted: e.submitted, id: e.id, same_id: e.id === Number(d.entry_id), log_id: Number(d.id)};
}

/** Public board view: Monday picks + tiebreakers only once Sunday is final; never edit codes. */
function publicEntries(entries, wd) {
  const reveal = !!wd.sunday_final;
  const monday = new Set(wd.games.filter(g => g.is_monday).map(g => g.matchup));
  return entries.map(e => {
    const picks = {};
    for (const [m, t] of Object.entries(e.picks || {})) if (reveal || !monday.has(m)) picks[m] = t;
    const out = {name: e.name, tag: e.tag, picks, paid: !!e.paid, submitted: e.submitted};
    if (reveal) out.tiebreaker = e.tiebreaker;
    return out;
  });
}

function adminEntries(entries) {
  return entries.map(e => ({name: e.name, tag: e.tag, picks: e.picks, tiebreaker: e.tiebreaker, paid: !!e.paid, paid_at: e.paid_at,
                            source: e.source || 'web', submitted: e.submitted, updated: e.updated, notes: e.notes || ''}));
}

function csv(entries, wd) {
  const cell = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                    // no formula injection in Excel
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ['Submitted', 'Updated', 'Name', 'Tag', ...wd.games.map(g => g.matchup), 'Tiebreaker', 'Paid', 'Notes'];
  const rows = entries.map(e => [e.submitted, e.updated, e.name, e.tag, ...wd.games.map(g => (e.picks || {})[g.matchup] || ''),
                                 e.tiebreaker == null ? '' : e.tiebreaker, e.paid ? 'yes' : 'no', e.notes || '']);
  return '\uFEFF' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = {deleteState, deleteLogged, readWithTombstones, listDeleted, restoreEntry, MNF_GRACE_MS, adminGate, paidLive, paidEntries, setPaid, seedPaid, ADMIN_BAD_MAX, withLocks, readAll, countEntries, submit, lookup, resetCode, deleteEntry, publicGames, publicEntries, adminEntries, csv, clean,
                  nameKey, codeHash, UserError, RATE_MAX, BAD_CODE_MAX, MAX_ENTRIES, NAME_MAX, TAG_MAX, LEGACY_MAX};
