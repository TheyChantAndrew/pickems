const part1 = require('./core_part1');
const part2 = require('./core_part2');
const lock = require('./lock');
function withLocks(wd, nowMs) {
  return lock.applyLock(part1.withLocks(wd, nowMs), wd && wd.picks_locked != null ? !!wd.picks_locked : null);
}
module.exports = Object.assign({}, part1, part2, lock, {withLocks});
