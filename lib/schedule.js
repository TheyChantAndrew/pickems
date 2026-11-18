// Pull an NFL week from ESPN and store it in Turso meta so a new week does not need a deploy.
const ESPN = process.env.ESPN_SCOREBOARD_URL || 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const FIX = {WSH: 'WAS', LA: 'LAR', JAC: 'JAX', OAK: 'LV', SD: 'LAC'};
const TZ = 'America/Los_Angeles';

function weekDataKey(week) { return 'week_data:' + Number(week); }

function nflSeasonYear(now) {
  const d = now ? new Date(now) : new Date();
  const y = d.getFullYear(), m = d.getMonth();
  return m <= 2 ? y - 1 : y;
}

function kickoffLabel(iso) {
  const d = new Date(iso);
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).formatToParts(d).forEach(p => { parts[p.type] = p.value; });
  const ap = String(parts.dayPeriod || '').replace(/\s+/g, '').toUpperCase();
  return parts.weekday + ' ' + parts.month + '/' + parts.day + ' ' + parts.hour + ':' + parts.minute + ap + ' PT';
}

function weekdayPt(iso) {
  return new Intl.DateTimeFormat('en-US', {timeZone: TZ, weekday: 'short'}).format(new Date(iso));
}

function abbrOf(comp) {
  let a = String((comp.team && (comp.team.abbreviation || comp.team.abbrev)) || '');
  return FIX[a] || a;
}

function nameOf(comp) {
  const t = comp.team || {};
  return String(t.shortDisplayName || t.displayName || t.name || abbrOf(comp)).replace(/\s+/g, ' ').trim();
}

function parseEspn(j, week, year) {
  const events = Array.isArray(j && j.events) ? j.events : [];
  const games = [];
  events.forEach((ev, i) => {
    try {
      const c = ev.competitions && ev.competitions[0];
      if (!c) return;
      const home = c.competitors.find(x => x.homeAway === 'home');
      const away = c.competitors.find(x => x.homeAway === 'away');
      if (!home || !away) return;
      const kickoff = ev.date || c.date;
      if (!kickoff || isNaN(Date.parse(kickoff))) return;
      games.push({
        game_no: i + 1,
        matchup: abbrOf(away) + ' @ ' + abbrOf(home),
        away: abbrOf(away),
        home: abbrOf(home),
        away_team: nameOf(away),
        home_team: nameOf(home),
        kickoff,
        kickoff_label: kickoffLabel(kickoff),
        is_monday: weekdayPt(kickoff) === 'Mon',
        is_tiebreaker: false
      });
    } catch (e) { /* skip one bad event */ }
  });
  games.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  games.forEach((g, i) => { g.game_no = i + 1; });
  const mons = games.filter(g => g.is_monday);
  const tb = mons.length ? mons[mons.length - 1] : games[games.length - 1];
  if (tb) tb.is_tiebreaker = true;
  return {
    week: Number(week),
    year: Number(year),
    entry_fee: 10,
    open: true,
    sunday_final: false,
    monday_final: false,
    week_done: false,
    board_names: [],
    games,
    source: 'espn',
    generated_at: new Date().toISOString()
  };
}

async function fetchEspnWeek(year, week) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${ESPN}?dates=${year}&seasontype=2&week=${week}`, {signal: ctl.signal, headers: {Accept: 'application/json'}});
    if (!r.ok) throw new Error('ESPN HTTP ' + r.status);
    return parseEspn(await r.json(), week, year);
  } finally { clearTimeout(to); }
}

async function saveWeekData(db, wd) {
  const week = Number(wd && wd.week);
  if (!db || !Number.isInteger(week) || week < 1) throw new Error('week required');
  if (!Array.isArray(wd.games) || !wd.games.length) throw new Error('no games');
  await db.execute({
    sql: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    args: [weekDataKey(week), JSON.stringify(wd)]
  });
  return wd;
}

async function setLiveWeek(db, week) {
  week = Number(week);
  if (!Number.isInteger(week) || week < 1 || week > 30) throw new Error('week required');
  await db.execute({
    sql: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    args: ['current_week', String(week)]
  });
  return week;
}

async function importEspnWeek(db, week, year) {
  week = Number(week);
  year = Number(year);
  if (!Number.isInteger(week) || week < 1 || week > 22) throw new Error('week required');
  if (!Number.isInteger(year) || year < 2020 || year > 2100) year = nflSeasonYear();
  const wd = await fetchEspnWeek(year, week);
  if (!wd.games.length) throw new Error('ESPN returned no games for that week');
  await saveWeekData(db, wd);
  return wd;
}

const ESPN_URL = process.env.ESPN_SCOREBOARD_URL || 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

function pairKey(away, home) {
  return [away, home].slice().sort().join('|');
}

/** Scoreboard index keyed by sorted abbreviations. null on any failure. Never throws. */
async function fetchEspnScores(year, week, timeoutMs) {
  const ms = Math.min(8000, Math.max(500, Number(timeoutMs) || 8000));
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${ESPN_URL}?dates=${year}&seasontype=2&week=${week}`, {signal: ctl.signal, headers: {Accept: 'application/json'}});
    if (!r.ok) return null;
    const j = await r.json();
    const games = {};
    (Array.isArray(j && j.events) ? j.events : []).forEach(ev => {
      try {
        const c = ev.competitions[0], st = ev.status.type, sc = {}, ks = [];
        c.competitors.forEach(x => {
          let a = String(x.team.abbreviation); a = FIX[a] || a;
          const v = parseInt(x.score, 10); sc[a] = isFinite(v) ? v : 0; ks.push(a);
        });
        if (ks.length === 2) games[ks.slice().sort().join('|')] = {sc, state: String(st.state || ''), done: st.completed !== false, detail: String(st.shortDetail || '')};
      } catch (e) { /* skip one event */ }
    });
    return games;
  } catch (e) { return null; }
  finally { clearTimeout(to); }
}

/** True once a game has started: kickoff has arrived, ESPN says it is in progress, or ESPN
 *  marks it completed. A postponed or canceled game is `post` with completed false, and stays
 *  locked until its kickoff. */
function pickRevealed(g, espnEvent, nowMs) {
  const kick = Date.parse(g && g.kickoff);
  if (Number.isFinite(kick) && Number(nowMs) >= kick) return true;
  if (!espnEvent) return false;
  if (espnEvent.state === 'in') return true;
  return espnEvent.done === true;
}

function tiebreakerGame(wd) {
  const games = (wd && wd.games) || [];
  return games.find(g => g && g.is_tiebreaker) || [...games].reverse().find(g => g && g.is_monday) || games[games.length - 1] || null;
}

/** Matchups whose picks are public, plus whether the tiebreaker number is public. */
function revealedMatchups(wd, espn, nowMs) {
  const matchups = new Set();
  for (const g of (wd && wd.games) || []) {
    if (!g) continue;
    const e = espn && espn[pairKey(g.away, g.home)];
    if (pickRevealed(g, e, nowMs)) matchups.add(g.matchup);
  }
  const tb = tiebreakerGame(wd);
  return {matchups, tiebreaker: !!(tb && matchups.has(tb.matchup)), tiebreakerGame: tb ? tb.matchup : null};
}

/** Copy of wd with sunday_final set when every non-Monday game is final on the scoreboard.
 *  Stored sunday_final is left alone. This flag no longer hides picks; each game reveals at its kickoff. */
function revealIfReady(wd, espn) {
  try {
    if (!wd || wd.sunday_final) return wd;
    const games = Array.isArray(wd.games) ? wd.games : [];
    const earlier = games.filter(g => g && !g.is_monday);
    if (!earlier.length || !espn || typeof espn !== 'object') return wd;
    for (const g of earlier) {
      const e = espn[pairKey(g.away, g.home)];
      if (!e || e.state !== 'post' || !e.done) return wd;
    }
    return Object.assign({}, wd, {sunday_final: true});
  } catch (e) {
    return wd;
  }
}

module.exports = {weekDataKey, nflSeasonYear, parseEspn, fetchEspnWeek, saveWeekData, setLiveWeek, importEspnWeek, fetchEspnScores, revealIfReady, pickRevealed, tiebreakerGame, revealedMatchups, pairKey};
