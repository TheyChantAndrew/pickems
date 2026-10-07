// Fam Bash Pickems: submission rules. Logic over (libSQL client, weekData, now) so tests can drive it directly.
const crypto = require('crypto');

const NAME_MAX = 24, TAG_MAX = 24, TB_MAX = 200, MAX_ENTRIES = 300;
const RATE_WINDOW_S = 600, RATE_MAX = 30;        // per IP: 30 writes / 10 minutes
const BAD_CODE_MAX = 10;                         // per name: 10 wrong edit codes / hour
const CODE_ALPHABET = 'ABCDFGHJKMNPQRSTVWXYZ23456789';
const TZ = 'America/Los_Angeles';

class UserError extends Error { constructor(msg, code, status) { super(msg); this.code = code; this.status = status || 400; } }

function clean(s, max) {
  s = String(s == null ? '' : s).normalize('NFC');
  s = s.replace(/[\u0000-\u001f\u007f<>"`\\{}\[\]]/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[=+\-@'\s]+/, '');
  if (s.length > max) s = s.slice(0, max).trim();
  return s;
}
const cleanTag = s => clean(String(s == null ? '' : s).replace(/[()]/g, ' '), TAG_MAX);
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
          tiebreaker: r.tiebreaker == null ? null : Number(r.tiebreaker), paid: !!Number(r.paid), source: r.source || 'web',
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

function publicGames(wd, week, nowMs, entriesCount, currentWeek) {
  const L = withLocks(wd, nowMs);
  return {ok: true, week, now: new Date(nowMs).toISOString(), current_week: currentWeek,
          open: wd.open !== false && week === currentWeek, sunday_final: !!wd.sunday_final, entries_count: entriesCount,
          tiebreaker_game: L.tiebreaker_game, tiebreaker_lock_at: L.tiebreaker_lock_at, tiebreaker_locked: L.tiebreaker_locked,
          games: L.games.map(g => ({matchup: g.matchup, away: g.away, home: g.home, away_team: g.away_team, home_team: g.home_team,
                                    kickoff: g.kickoff, kickoff_label: g.kickoff_label, is_monday: g.is_monday, lock_at: g.lock_at, locked: g.locked}))};
}

async function submit(db, wd, currentWeek, b, nowMs, ipH) {
  if (b.website) return {ok: true, status: 'created', message: 'Thanks!'};     // honeypot: pretend, store nothing
  await rateLimit(db, ipH, nowMs);
  const week = Number(b.week);
  if (!week || !wd || week !== currentWeek || wd.open === false) throw new UserError(`Week ${b.week || '?'} is not taking picks right now.`, 'WEEK');
  const L = withLocks(wd, nowMs);
  const games = L.games;
  const name = clean(b.name, NAME_MAX), tag = cleanTag(b.tag);
  if (!name) throw new UserError('Please enter your name.', 'NAME');
  if (!/[A-Za-z0-9\u00C0-\uFFFF]/.test(name)) throw new UserError('Please use letters or numbers in your name.', 'NAME');
  if (!tag) throw new UserError('Please enter your tag (your crew, like FAM BASH).', 'TAG');

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
  const key = nameKey(clean(b.name, NAME_MAX)), code = String(b.code || '').trim().toUpperCase().slice(0, 12);
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
  const key = nameKey(clean(name, NAME_MAX));
  const e = key && await getEntry(db, week, key);
  if (!e) throw new UserError('No entry with that name this week.', 'NOT_FOUND', 404);
  const code = newCode();
  await db.batch([{sql: 'UPDATE entries SET edit_code_hash = ?, updated_at = ?, version = version + 1 WHERE id = ?',
                   args: [codeHash(week, key, code), new Date(nowMs).toISOString(), e.id]}], 'write');
  return {ok: true, week, name: e.name, edit_code: code};
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
  return entries.map(e => ({name: e.name, tag: e.tag, picks: e.picks, tiebreaker: e.tiebreaker, paid: !!e.paid,
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

module.exports = {withLocks, readAll, countEntries, submit, lookup, resetCode, publicGames, publicEntries, adminEntries, csv, clean,
                  nameKey, codeHash, UserError, RATE_MAX, BAD_CODE_MAX, MAX_ENTRIES};
