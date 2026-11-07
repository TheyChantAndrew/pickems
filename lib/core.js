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

/** Lock times (rule since 2026-10-08): EVERYTHING locks at the week's FIRST kickoff (Thursday night): every game,
 *  the Monday picks and the tiebreaker. Hiding of Monday picks/tiebreaker is separate (sunday_final). */
function withLocks(wd, nowMs) {
  const games = wd.games.map(g => Object.assign({}, g));
  let lastSunday = 0;
  for (const g of games) {
    g._t = Date.parse(g.kickoff);
    if (isNaN(g._t)) throw new Error('bad kickoff for ' + g.matchup);
    if (!g.is_monday && g._t > lastSunday) lastSunday = g._t;
  }
  const sundayFinal = !!wd.sunday_final;
  const firstKick = games.length ? Math.min(...games.map(g => g._t)) : 0;
  const weekLocked = false; // temporary: auto Thursday lock removed; admin control to be added later
  for (const g of games) {
    g.lock_at = new Date(firstKick).toISOString();
    g.locked = weekLocked;
    delete g._t;
  }
  const tb = games.find(g => g.is_tiebreaker) || games.find(g => g.is_monday) || games[games.length - 1];
  const tbLockAt = firstKick;
  const tbLocked = !tb || weekLocked;
  return {lock_at: games.length ? new Date(firstKick).toISOString() : null, locked: weekLocked, games, tiebreaker_game: tb ? tb.matchup : null, tiebreaker_lock_at: tb ? new Date(tbLockAt).toISOString() : null,
          tiebreaker_locked: tbLocked, last_sunday_kickoff: lastSunday ? new Date(lastSunday).toISOString() : null};
}
