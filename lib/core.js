// Fam Bash Pickems: submission rules. Pure logic over (redis, weekData, now) so tests can drive it directly.
const crypto = require('crypto');

const NAME_MAX = 24, TAG_MAX = 24, TB_MAX = 200, MAX_ENTRIES = 300;
const RATE_WINDOW_S = 600, RATE_MAX = 30;        // per IP: 30 writes / 10 minutes
const BAD_CODE_MAX = 10;                         // per name: 10 wrong edit codes / hour
const CODE_ALPHABET = 'ABCDFGHJKMNPQRSTVWXYZ23456789';
const TZ = 'America/Los_Angeles';

class UserError extends Error { constructor(msg, code, status) { super(msg); this.code = code; this.status = status || 400; } }
const kEntries = w => `pk:w${w}:entries`, kLock = (w, n) => `pk:w${w}:lock:${n}`, kBad = (w, n) => `pk:w${w}:bad:${n}`;

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
function newCode() { let s = ''; for (let i = 0; i < 4; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]; return s; }

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

async function readAll(redis, week) {
  const h = (await redis.hgetall(kEntries(week))) || {};
  return Object.values(h).map(v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { return null; } }).filter(Boolean)
    .sort((a, b) => String(a.submitted).localeCompare(String(b.submitted)));
}

async function rateLimit(redis, ipH, nowMs) {
  const k = `pk:rl:${ipH}:${Math.floor(nowMs / 1000 / RATE_WINDOW_S)}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, RATE_WINDOW_S + 60);
  if (n > RATE_MAX) throw new UserError('Too many tries from this connection. Wait a few minutes and try again.', 'RATE', 429);
}

async function withNameLock(redis, week, key, fn) {
  const lk = kLock(week, key), token = crypto.randomUUID();
  let got = false;
  for (let i = 0; i < 25 && !got; i++) {
    got = (await redis.set(lk, token, {nx: true, px: 8000})) === 'OK';
    if (!got) await new Promise(r => setTimeout(r, 120));
  }
  if (!got) throw new UserError('The site is busy, please tap Submit again.', 'BUSY', 503);
  try { return await fn(); }
  finally { if ((await redis.get(lk)) === token) await redis.del(lk); }
}

function publicGames(wd, week, nowMs, entriesCount, currentWeek) {
  const L = withLocks(wd, nowMs);
  return {ok: true, week, now: new Date(nowMs).toISOString(), current_week: currentWeek,
          open: wd.open !== false && week === currentWeek, sunday_final: !!wd.sunday_final, entries_count: entriesCount,
          tiebreaker_game: L.tiebreaker_game, tiebreaker_lock_at: L.tiebreaker_lock_at, tiebreaker_locked: L.tiebreaker_locked,
          games: L.games.map(g => ({matchup: g.matchup, away: g.away, home: g.home, away_team: g.away_team, home_team: g.home_team,
                                    kickoff: g.kickoff, kickoff_label: g.kickoff_label, is_monday: g.is_monday, lock_at: g.lock_at, locked: g.locked}))};
}

async function submit(redis, wd, currentWeek, b, nowMs, ipH) {
  if (b.website) return {ok: true, status: 'created', message: 'Thanks!'};     // honeypot: pretend, store nothing
  await rateLimit(redis, ipH, nowMs);
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
  return withNameLock(redis, week, key, async () => {
    const raw = await redis.hget(kEntries(week), key);
    const existing = raw ? JSON.parse(raw) : null;
    const stamp = fmtTime(new Date(nowMs));
    const openGames = games.filter(g => !g.locked);
    if (!existing) {
      if ((wd.board_names || []).map(nameKey).includes(key))
        throw new UserError(`"${name}" is already on the Week ${week} board (paper entry). If that's you, you're already in. Otherwise add a last initial, like "${name} R".`, 'TAKEN');
      if (!openGames.length || L.tiebreaker_locked) throw new UserError(`Week ${week} entries are closed: the games have started.`, 'CLOSED');
      if ((await redis.hlen(kEntries(week))) >= MAX_ENTRIES) throw new UserError('Entry limit reached for this week. Ask Andy.', 'FULL');
      const missing = openGames.filter(g => !accepted[g.matchup]).map(g => g.matchup);
      if (missing.length) throw new UserError("Pick every game that hasn't started yet. Missing: " + missing.join(', '), 'MISSING');
      if (tb == null) throw new UserError(`Please enter your tiebreaker (total points in ${L.tiebreaker_game}).`, 'TB');
      const entry = {name, tag, picks: accepted, tiebreaker: tb, paid: false, source: 'web', code: newCode(),
                     submitted: stamp, updated: stamp, notes: lockedIgnored.length ? 'Started before entry: ' + lockedIgnored.join(', ') : ''};
      if (!(await redis.hsetnx(kEntries(week), key, JSON.stringify(entry)))) throw new UserError('The site is busy, please tap Submit again.', 'BUSY', 503);
      return result('created', entry, games, lockedIgnored, invalid, tbIgnored, week);
    }
    const code = String(b.code || '').trim().toUpperCase().slice(0, 12);
    if (!code || code !== existing.code) {
      if (code) {
        const n = await redis.incr(kBad(week, key));
        if (n === 1) await redis.expire(kBad(week, key), 3600);
        if (n > BAD_CODE_MAX) throw new UserError('Too many wrong edit codes for that name. Try again in an hour or ask Andy.', 'RATE', 429);
      }
      throw new UserError(`Someone named "${existing.name}" already entered Week ${week}. If that's you, enter your edit code to change picks. If not, add a last initial to your name.`, 'NEED_CODE', 409);
    }
    const merged = {};
    for (const g of games) {
      const old = existing.picks[g.matchup];
      if (g.locked) { if (old) merged[g.matchup] = old; }      // locked picks never change
      else if (accepted[g.matchup]) merged[g.matchup] = accepted[g.matchup];
      else if (old) merged[g.matchup] = old;
    }
    existing.picks = merged;
    if (tb != null) existing.tiebreaker = tb;
    existing.tag = tag; existing.updated = stamp;
    await redis.hset(kEntries(week), {[key]: JSON.stringify(existing)});
    return result('updated', existing, games, lockedIgnored, invalid, tbIgnored, week);
  });
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

async function lookup(redis, wd, b, nowMs, ipH) {
  await rateLimit(redis, ipH, nowMs);
  const week = Number(b.week);
  if (!wd) throw new UserError('Unknown week.', 'WEEK');
  const key = nameKey(clean(b.name, NAME_MAX)), code = String(b.code || '').trim().toUpperCase().slice(0, 12);
  if (!key || !code) throw new UserError('Enter your name and edit code.', 'NOT_FOUND', 404);
  const bad = Number(await redis.get(kBad(week, key))) || 0;
  if (bad >= BAD_CODE_MAX) throw new UserError('Too many wrong edit codes for that name. Try again in an hour or ask Andy.', 'RATE', 429);
  const raw = await redis.hget(kEntries(week), key);
  const e = raw ? JSON.parse(raw) : null;
  if (!e || e.code !== code) {
    if (e) { const n = await redis.incr(kBad(week, key)); if (n === 1) await redis.expire(kBad(week, key), 3600); }
    throw new UserError('No entry found for that name and edit code.', 'NOT_FOUND', 404);
  }
  return {ok: true, week, name: e.name, tag: e.tag, picks: e.picks, tiebreaker: e.tiebreaker, paid: !!e.paid, edit_code: e.code};
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
                            source: e.source || 'web', submitted: e.submitted, updated: e.updated, code: e.code, notes: e.notes || ''}));
}

function csv(entries, wd) {
  const cell = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                    // no formula injection in Excel
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ['Submitted', 'Updated', 'Name', 'Tag', ...wd.games.map(g => g.matchup), 'Tiebreaker', 'Paid', 'Edit code', 'Notes'];
  const rows = entries.map(e => [e.submitted, e.updated, e.name, e.tag, ...wd.games.map(g => (e.picks || {})[g.matchup] || ''),
                                 e.tiebreaker == null ? '' : e.tiebreaker, e.paid ? 'yes' : 'no', e.code, e.notes || '']);
  return '\uFEFF' + [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = {withLocks, readAll, submit, lookup, publicGames, publicEntries, adminEntries, csv, clean, nameKey, UserError,
                  RATE_MAX, BAD_CODE_MAX, MAX_ENTRIES, kEntries};
