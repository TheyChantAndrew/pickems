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

module.exports = {weekDataKey, nflSeasonYear, parseEspn, fetchEspnWeek, saveWeekData, setLiveWeek, importEspnWeek};
