const part1 = require('./core_part1');
const part2 = require('./core_part2');
const lock = require('./lock');
function withLocks(wd, nowMs, espn) {
  const L = part1.withLocks(wd, nowMs, espn);
  return wd && wd.picks_locked === true ? lock.applyLock(L, true) : L;
}
module.exports = Object.assign({}, part1, part2, lock, {withLocks});
