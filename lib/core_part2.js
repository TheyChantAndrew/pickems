const {
  UserError, clean, cleanTag, nameKey, fmtIso, newCode, codeHash, codeOk,
  withLocks, getEntry, rateLimit, badCodeCheck, badCodeHit, rowToEntry,
  NAME_MAX, TAG_MAX, LEGACY_MAX, RAW_MAX, TB_MAX, MAX_ENTRIES, MNF_GRACE_MS
} = require('./core_part1');

function publicGames(wd, week, nowMs, entriesCount, currentWeek) {
  const L = withLocks(wd, nowMs);
  return {ok: true, week, now: new Date(nowMs).toISOString(), current_week: currentWeek,
          open: wd.open !== false && week === currentWeek, sunday_final: !!wd.sunday_final, entries_count: entriesCount,
          lock_at: L.lock_at, locked: L.locked, tiebreaker_game: L.tiebreaker_game, tiebreaker_lock_at: L.tiebreaker_lock_at, tiebreaker_locked: L.tiebreaker_locked,
          games: L.games.map(g => ({matchup: g.matchup, away: g.away, home: g.home, away_team: g.away_team, home_team: g.home_team,
                                    kickoff: g.kickoff, kickoff_label: g.kickoff_label, is_monday: g.is_monday, lock_at: g.lock_at, locked: g.locked}))};
}

async function submit(db, wd, currentWeek, b, nowMs, ipH) {
  const hp = b.zq7f != null ? b.zq7f : b.website;
  if (hp != null && String(hp).trim() !== '') throw new UserError("Your entry didn't go through: our spam check tripped. Reload the page and submit again. If it keeps happening, text Andy.", 'BOT', 400);
  const week = Number(b.week);
  if (!week || !wd || week !== currentWeek || wd.open === false) throw new UserError(`Week ${b.week || '?'} is not taking picks right now.`, 'WEEK');
  const L = withLocks(wd, nowMs);
  if (L.locked) throw new UserError(`Week ${week} picks are locked: Pickems started at the first kickoff.`, 'CLOSED', 403);
  await rateLimit(db, ipH, nowMs);
  const games = L.games;
  let name = clean(b.name, RAW_MAX), tag = cleanTag(b.tag, RAW_MAX);
  if (!name) throw new UserError('Please enter your name.', 'NAME');
  if (!/[A-Za-z0-9\u00C0-\uFFFF]/.test(name)) throw new UserError('Please use letters or numbers in your name.', 'NAME');
  if (!tag) throw new UserError('Please enter your tag (your crew, like FAM BASH).', 'TAG');
  if (name.length > NAME_MAX) {
    const legacy = clean(b.name, LEGACY_MAX);
    if (!(await getEntry(db, week, nameKey(legacy)))) throw new UserError(`Name must be ${NAME_MAX} characters or fewer.`, 'NAME_LONG');
    name = legacy;
  }
  const tagLong = tag.length > TAG_MAX;
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
      if (name.length > NAME_MAX) throw new UserError(`Name must be ${NAME_MAX} characters or fewer.`, 'NAME_LONG');
      if (tagLong) throw tagErr();
      if ((wd.board_names || []).map(nameKey).includes(key))
        throw new UserError(`"${name}" is already on the Week ${week} board (paper entry). If that's you, you're already in. Otherwise add a last initial, like "${name} R".`, 'TAKEN');
      if (!openGames.length || L.tiebreaker_locked) throw new UserError(`Week ${week} entries are closed: the games have started.`, 'CLOSED');
      const missing = openGames.filter(g => !accepted[g.matchup]).map(g => g.matchup);
      if (missing.length) throw new UserError("Pick every game that hasn't started yet. Missing: " + missing.join(', '), 'MISSING');
      if (tb == null) throw new UserError(`Please enter your tiebreaker (total points in ${L.tiebreaker_game}).`, 'TB');
      const code = newCode(), notes = lockedIgnored.length ? 'Started before entry: ' + lockedIgnored.join(', ') : '';
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
      continue;
    }
    const code = String(b.code || '').trim().toUpperCase().slice(0, 12);
    if (code) await badCodeCheck(db, week, key, nowMs);
    if (!codeOk(existing, week, key, code)) {
      if (code) await badCodeHit(db, week, key, nowMs);
      throw new UserError(`Someone named "${existing.name}" already entered Week ${week}. If that's you, enter your edit code to change picks. If not, add a last initial to your name.`, 'NEED_CODE', 409);
    }
    if (tagLong) { if (nameKey(tag) !== nameKey(existing.tag || '')) throw tagErr(); tag = existing.tag; }
    const merged = {};
    for (const g of games) {
      const old = existing.picks[g.matchup];
      if (g.locked) { if (old) merged[g.matchup] = old; }
      else if (accepted[g.matchup]) merged[g.matchup] = accepted[g.matchup];
      else if (old) merged[g.matchup] = old;
    }
    const newTb = tb != null ? tb : existing.tiebreaker;
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

async function resetCode(db, week, name, nowMs) {
  const key = nameKey(clean(name, LEGACY_MAX));
  const e = key && await getEntry(db, week, key);
  if (!e) throw new UserError('No entry with that name this week.', 'NOT_FOUND', 404);
  const code = newCode();
  await db.batch([{sql: 'UPDATE entries SET edit_code_hash = ?, updated_at = ?, version = version + 1 WHERE id = ?',
                   args: [codeHash(week, key, code), new Date(nowMs).toISOString(), e.id]}], 'write');
  return {ok: true, week, name: e.name, edit_code: code};
}

function deleteState(wd, nowMs) {
  const mon = (wd.games || []).filter(g => g.is_monday).map(g => Date.parse(g.kickoff)).filter(t => !isNaN(t));
  const kick = mon.length ? Math.max(...mon) : null;
  let blocked = false, reason = null;
  if (wd.monday_final || wd.week_done) { blocked = true; reason = 'final'; }
  else if (kick != null && nowMs >= kick + MNF_GRACE_MS) { blocked = true; reason = 'mnf_kickoff_plus_4h'; }
  return {blocked, reason, mnf_started: kick != null && nowMs >= kick, mnf_kickoff: kick != null ? new Date(kick).toISOString() : null,
          message: blocked ? `Week ${wd.week} is finished (Monday night's game is over), so entries can't be deleted anymore.` : null};
}
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
                                          void, void_at, source, notes, version, created_at, updated_at, deleted_at, deleted_by)
             SELECT id, week, name, name_key, tag, picks, tiebreaker, ?, edit_code_hash, paid, paid_at, void, void_at, source, notes, version, created_at,
                    updated_at, ?, ? FROM entries WHERE id = ? AND version = ?`,
       args: [monday, nowIso, by === 'portal' ? 'portal' : 'admin', e.id, e.version]},
      {sql: 'DELETE FROM entries WHERE id = ? AND version = ? AND changes() = 1', args: [e.id, e.version]},
      {sql: "DELETE FROM rate_limits WHERE bucket LIKE ? ESCAPE '\\'", args: [`bad:${week}:${key.replace(/[\\%_]/g, c => '\\' + c)}:%`]},
    ];
    if (opts.clearRateLimits) stmts.push({sql: 'DELETE FROM rate_limits', args: []});
    stmts.push({sql: 'SELECT COUNT(*) AS n FROM entries WHERE week = ?', args: [week]});
    const rs = await db.batch(stmts, 'write');
    if (rs[0].rowsAffected !== 1 || rs[1].rowsAffected !== 1) {
      if (rs[0].rowsAffected !== rs[1].rowsAffected) throw new Error('delete log mismatch');
      continue;
    }
    return {ok: true, week, deleted: 1, name: e.name, name_key: key, tag: e.tag, paid: e.paid, paid_at: e.paid_at, deleted_by: by === 'portal' ? 'portal' : 'admin',
            rate_limits_cleared: !!opts.clearRateLimits, remaining: Number(rs[rs.length - 1].rows[0].n)};
  }
  throw new UserError('The site is busy, please try again.', 'BUSY', 503);
}
async function deleteEntry(db, week, name, clearRateLimits, wd) {
  const r = await deleteLogged(db, wd || null, week, name, 'admin', {clearRateLimits});
  return {ok: true, week, deleted: r.deleted, name_key: r.name_key, rate_limits_cleared: r.rate_limits_cleared, remaining: r.remaining};
}
const TOMB_SQL = `SELECT MAX(d.name) AS name FROM deleted_entries d WHERE d.week = ? AND d.restored_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.week = d.week AND e.name_key = d.name_key)
                  GROUP BY d.name_key ORDER BY MIN(d.deleted_at)`;
async function readWithTombstones(db, week) {
  const rs = await db.batch([{sql: 'SELECT * FROM entries WHERE week = ? ORDER BY created_at, id', args: [Number(week)]},
                             {sql: TOMB_SQL, args: [Number(week)]}], 'read');
  return {entries: rs[0].rows.map(rowToEntry), tombstones: rs[1].rows.map(r => r.name)};
}
async function listDeleted(db, week) {
  const r = await db.execute({sql: `SELECT id, entry_id, name, tag, monday_pick IS NOT NULL AS has_monday, paid, paid_at, created_at, updated_at,
                                           deleted_at, deleted_by, restored_at FROM deleted_entries WHERE week = ? ORDER BY deleted_at DESC, id DESC`,
                                    args: [Number(week)]});
  return r.rows.map(x => ({log_id: Number(x.id), entry_id: Number(x.entry_id), name: x.name, tag: x.tag, paid: !!Number(x.paid), paid_at: x.paid_at || null,
                           submitted: fmtIso(x.created_at), deleted_at: x.deleted_at, deleted: fmtIso(x.deleted_at), deleted_by: x.deleted_by,
                           restored_at: x.restored_at || null}));
}
async function restoreEntry(db, week, name) {
  const key = nameKey(clean(name, LEGACY_MAX));
  if (!key) throw new UserError('name required', 'BAD');
  if (await getEntry(db, week, key)) throw new UserError(`A live entry named "${name}" already exists in Week ${week}; delete it first or pick another row.`, 'EXISTS', 409);
  const r = await db.execute({sql: `SELECT * FROM deleted_entries WHERE week = ? AND name_key = ? AND restored_at IS NULL ORDER BY deleted_at DESC, id DESC LIMIT 1`,
                              args: [week, key]});
  if (!r.rows.length) throw new UserError('No deleted entry with that name this week.', 'NOT_FOUND', 404);
  const d = r.rows[0];
  const idFree = !(await db.execute({sql: 'SELECT 1 FROM entries WHERE id = ?', args: [d.entry_id]})).rows.length;
  const cols = 'week, name, name_key, tag, picks, tiebreaker, edit_code_hash, paid, paid_at, void, void_at, source, notes, version, created_at, updated_at';
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

function publicEntries(entries, wd) {
  const reveal = !!wd.sunday_final;
  const monday = new Set(wd.games.filter(g => g.is_monday).map(g => g.matchup));
  return entries.map(e => {
    const picks = {};
    for (const [m, t] of Object.entries(e.picks || {})) if (reveal || !monday.has(m)) picks[m] = t;
    const out = {name: e.name, tag: e.tag, picks, paid: !!e.paid, void: !!e.void, submitted: e.submitted};
    if (reveal) out.tiebreaker = e.tiebreaker;
    return out;
  });
}

function adminEntries(entries) {
  return entries.map(e => ({name: e.name, tag: e.tag, picks: e.picks, tiebreaker: e.tiebreaker, paid: !!e.paid, paid_at: e.paid_at, void: !!e.void,
                            source: e.source || 'web', submitted: e.submitted, updated: e.updated, notes: e.notes || ''}));
}

function csv(entries, wd) {
  const cell = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ['Submitted', 'Updated', 'Name', 'Tag', ...wd.games.map(g => g.matchup), 'Tiebreaker', 'Paid', 'Notes'];
  const rows = entries.map(e => [e.submitted, e.updated, e.name, e.tag, ...wd.games.map(g => (e.picks || {})[g.matchup] || ''),
                                 e.tiebreaker == null ? '' : e.tiebreaker, e.paid ? 'yes' : 'no', e.notes || '']);
  return '\uFEFF' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = {deleteState, deleteLogged, readWithTombstones, listDeleted, restoreEntry, submit, lookup, resetCode, deleteEntry, publicGames, publicEntries, adminEntries, csv};
