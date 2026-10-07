// Week schedules published by publish.sh as data/weekN.json (games + kickoffs + sunday_final + paper names, no picks).
// Bundled into every function via vercel.json "includeFiles": "data/**". The highest N present is the current week.
const fs = require('fs'), path = require('path');
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
module.exports = {weeks, currentWeek, loadWeek, dataDir};
