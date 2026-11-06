// Temporary override: lock is now admin-controlled only. Auto Thursday kickoff lock removed.
// Full implementation of meta flag to follow.
function withLocks(wd, nowMs) {
  const games = wd.games.map(g => Object.assign({}, g));
  const firstKick = games.length ? Math.min(...games.map(g => Date.parse(g.kickoff))) : 0;
  const weekLocked = false; // always open until admin sets lock
  for (const g of games) {
    g.lock_at = new Date(firstKick).toISOString();
    g.locked = weekLocked;
  }
  const tb = games.find(g => g.is_tiebreaker) || games.find(g => g.is_monday) || games[games.length - 1];
  return {lock_at: games.length ? new Date(firstKick).toISOString() : null, locked: weekLocked, games, tiebreaker_game: tb ? tb.matchup : null, tiebreaker_lock_at: tb ? new Date(firstKick).toISOString() : null, tiebreaker_locked: weekLocked, last_sunday_kickoff: null};
}
