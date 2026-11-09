// Week schedules: bundled data/weekN.json is the fallback. Live weeks can also live in Turso
// meta (week_data:N + current_week) so a new week does not need a code deploy.
const fs = require('fs'), path = require('path');
const {weekDataKey} = require('./schedule');

function dataDir() {
  if (process.env.PICKEMS_DATA_DIR) return process.env.PICKEMS_DATA_DIR;
  for (const d of [path.join(__dirname, '..', 'data'), path.join(process.cwd(), 'data')]) if (fs.existsSync(d)) return d;
  return path.join(process.cwd(), 'data');
}
function weeks() {
  try {
    return fs.readdirSync(dataDir()).map(f => /^week(\d+)\.json$/.exec(f)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b);
  } catch (e) { return []; }
}
function currentWeek() { const w = weeks(); return w.length ? w[w.length - 1] : null; }
function loadWeek(week) {
  week = Number(week);
  if (!Number.isInteger(week) || week < 1 || week > 30) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), `week${week}.json`), 'utf8')); } catch (e) { return null; }
}

async function metaGet(db, key) {
  if (!db) return null;
  const r = await db.execute({sql: 'SELECT value FROM meta WHERE key = ?', args: [key]});
  return r.rows.length ? r.rows[0].value : null;
}

async function currentWeekAsync(db) {
  const n = Number(await metaGet(db, 'current_week'));
  if (Number.isInteger(n) && n >= 1 && n <= 30) return n;
  return currentWeek();
}

async function loadWeekAsync(db, week) {
  week = Number(week);
  if (!Number.isInteger(week) || week < 1 || week > 30) return null;
  const raw = await metaGet(db, weekDataKey(week));
  if (raw) {
    try {
      const wd = JSON.parse(raw);
      if (wd && Array.isArray(wd.games) && wd.games.length) return wd;
    } catch (e) { /* fall through to file */ }
  }
  return loadWeek(week);
}

async function weeksAsync(db) {
  const set = new Set(weeks());
  if (db) {
    const r = await db.execute({sql: "SELECT key FROM meta WHERE key LIKE 'week_data:%'", args: []});
    for (const row of r.rows) {
      const n = Number(String(row.key).slice('week_data:'.length));
      if (Number.isInteger(n) && n >= 1 && n <= 30) set.add(n);
    }
    const cur = Number(await metaGet(db, 'current_week'));
    if (Number.isInteger(cur) && cur >= 1) set.add(cur);
  }
  const list = [...set].sort((a, b) => a - b);
  const next = (list.length ? list[list.length - 1] : 0) + 1;
  if (next >= 1 && next <= 22) list.push(next);
  return list;
}

module.exports = {weeks, currentWeek, loadWeek, dataDir, currentWeekAsync, loadWeekAsync, weeksAsync};
