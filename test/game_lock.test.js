const {test} = require('node:test');
const assert = require('node:assert/strict');
const {submit, codeHash, withLocks} = require('../lib/core');
const {withLocks: rawLocks} = require('../lib/core_part1');
const {tiebreakerGame, pickRevealed} = require('../lib/schedule');
const {applyLock, getPicksLocked, setPicksLocked} = require('../lib/lock');

const NOW = Date.parse('2026-11-21T18:00:00Z');
function g(matchup, away, home, kickoff, monday) {
  return {matchup, away, home, away_team: away, home_team: home, kickoff, kickoff_label: 't', is_monday: !!monday};
}
const wd = {
  week: 11, year: 2026, open: true,
  games: [
    g('IND @ HOU', 'IND', 'HOU', '2026-11-20T01:15:00Z'),
    g('TB @ DET', 'TB', 'DET', '2026-11-23T18:00:00Z'),
    g('DAL @ PHI', 'DAL', 'PHI', '2026-11-23T21:00:00Z', true),
    g('CIN @ WAS', 'CIN', 'WAS', '2026-11-24T01:15:00Z', true)
  ]
};

test('a postponed game is not started, and the tiebreaker is the last Monday game', () => {
  const future = {kickoff: '2026-11-25T18:00:00Z'};
  assert.equal(pickRevealed(future, {state: 'post', done: false}, NOW), false);
  assert.equal(pickRevealed(future, {state: 'in', done: false}, NOW), true);
  assert.equal(pickRevealed(future, {state: 'post', done: true}, NOW), true);
  assert.equal(pickRevealed({kickoff: '2026-11-20T01:15:00Z'}, {state: 'post', done: false}, NOW), true);
  assert.equal(tiebreakerGame(wd).matchup, 'CIN @ WAS');
  const before = Date.parse('2026-11-19T00:00:00Z');
  const early = rawLocks(wd, before, {'HOU|IND': {state: 'post', done: false}});
  assert.equal(early.locked, false);
  assert.equal(early.games.every(x => x.locked === false), true);
  assert.equal(early.lock_at, '2026-11-20T01:15:00.000Z');
  assert.equal(early.games.every(x => x.lock_at === early.lock_at), true);
  assert.equal(early.tiebreaker_game, 'CIN @ WAS');
  assert.equal(early.tiebreaker_locked, false);
  const mid = rawLocks(wd, NOW, {'DET|TB': {state: 'in', done: false}});
  assert.equal(mid.locked, true);
  assert.equal(mid.first_started, true);
  assert.equal(mid.games.every(x => x.locked === true), true);
  assert.equal(mid.tiebreaker_locked, true);
  assert.equal(mid.lock_at, '2026-11-20T01:15:00.000Z');
  const storedOff = rawLocks(Object.assign({}, wd, {picks_locked: false}), NOW);
  assert.equal(storedOff.locked, true);
  assert.equal(storedOff.games.every(x => x.locked === true), true);
  assert.equal(applyLock(storedOff, false).locked, true);
  assert.equal(applyLock(storedOff, false).games.every(x => x.locked === true), true);
  const partial = rawLocks(wd, before, {'HOU|IND': {state: 'post', done: false}, 'DET|TB': {state: 'in', done: false}});
  assert.equal(partial.locked, false);
  assert.equal(partial.games.find(x => x.matchup === 'IND @ HOU').locked, false);
  assert.equal(partial.games.find(x => x.matchup === 'TB @ DET').locked, true);
  assert.equal(partial.games.find(x => x.matchup === 'CIN @ WAS').locked, false);
  assert.equal(applyLock(partial, false).games.find(x => x.matchup === 'TB @ DET').locked, true);
  const forced = withLocks(Object.assign({}, wd, {picks_locked: true}), before);
  assert.equal(forced.locked, true);
  assert.equal(forced.games.every(x => x.locked), true);
  assert.equal(forced.tiebreaker_locked, true);
});

function memoryDb() {
  const rows = [];
  let id = 0;
  const meta = {};
  const db = {
    rows,
    setWeekLock(v) {
      const key = 'picks_lock:11';
      if (v === true || v === '1') meta[key] = '1';
      else if (v === false || v === '0') meta[key] = '0';
      else delete meta[key];
    },
    async execute(q) {
      const sql = String(q.sql || '');
      const args = q.args || [];
      if (sql.includes('DELETE FROM meta')) { delete meta[args[0]]; return {rows: []}; }
      if (sql.includes('INSERT INTO meta')) { meta[args[0]] = String(args[1]); return {rows: []}; }
      if (sql.includes('FROM meta') && String(args[0] || '').startsWith('picks_lock')) {
        return {rows: meta[args[0]] == null ? [] : [{value: meta[args[0]]}]};
      }
      if (sql.includes('rate_limits') && sql.includes('INSERT')) return {rows: [{count: 1}]};
      if (sql.includes('rate_limits')) return {rows: []};
      if (sql.includes('FROM entries WHERE week = ? AND name_key')) {
        const hit = rows.filter(r => r.week === Number(args[0]) && r.name_key === args[1]);
        return {rows: hit};
      }
      if (sql.includes('COUNT(*) FROM entries')) return {rows: [{n: rows.length}]};
      return {rows: []};
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) {
        const sql = String(s.sql || '');
        if (sql.includes('INSERT INTO entries')) {
          id += 1;
          rows.push({id, week: s.args[0], name: s.args[1], name_key: s.args[2], tag: s.args[3], picks: s.args[4],
            tiebreaker: s.args[5], edit_code_hash: s.args[6], paid: 0, source: 'web', notes: s.args[7], version: 1,
            created_at: s.args[8], updated_at: s.args[9]});
          out.push({rowsAffected: 1, rows: []});
        } else if (sql.includes('UPDATE entries SET picks')) {
          const row = rows.find(r => r.id === s.args[4]);
          if (row && row.version === s.args[5] && row.edit_code_hash === s.args[6]) {
            row.picks = s.args[0]; row.tiebreaker = s.args[1]; row.tag = s.args[2]; row.updated_at = s.args[3]; row.version += 1;
            out.push({rowsAffected: 1, rows: []});
          } else out.push({rowsAffected: 0, rows: []});
        } else out.push(await this.execute(s));
      }
      return out;
    }
  };
  return db;
}

test('the week stays editable before the first kickoff and closes after it', async () => {
  global.fetch = async () => { throw new Error('espn down'); };
  const db = memoryDb();
  const before = Date.parse('2026-11-19T00:00:00Z');
  const all = {'IND @ HOU': 'HOU', 'TB @ DET': 'DET', 'DAL @ PHI': 'PHI', 'CIN @ WAS': 'WAS'};
  const created = await submit(db, wd, 11, {week: 11, name: 'Andy', tag: 'Crew', picks: all, tiebreaker: 40, zq7f: ''}, before, 'ip');
  assert.equal(created.ok, true);
  assert.equal(created.picks['TB @ DET'], 'DET');
  const code = 'ABCD';
  db.rows[0].edit_code_hash = codeHash(11, 'andy', code);
  const edited = await submit(db, wd, 11, {week: 11, name: 'Andy', tag: 'Crew', code, picks: Object.assign({}, all, {'TB @ DET': 'TB'}), tiebreaker: 41, zq7f: ''}, before, 'ip');
  assert.equal(edited.picks['TB @ DET'], 'TB');
  assert.equal(edited.tiebreaker, 41);

  const laterOnly = {'TB @ DET': 'DET', 'DAL @ PHI': 'PHI', 'CIN @ WAS': 'WAS'};
  await assert.rejects(() => submit(db, wd, 11, {week: 11, name: 'Bea', tag: 'Crew', picks: laterOnly, tiebreaker: 40, zq7f: ''}, NOW, 'ip'),
    err => err.code === 'CLOSED');
  await assert.rejects(() => submit(db, wd, 11, {week: 11, name: 'Andy', tag: 'Crew', code, picks: all, tiebreaker: 42, zq7f: ''}, NOW, 'ip'),
    err => err.code === 'CLOSED');

  db.setWeekLock('0');
  await assert.rejects(() => submit(db, wd, 11, {week: 11, name: 'Bea', tag: 'Crew', picks: all, tiebreaker: 40, zq7f: ''}, NOW, 'ip'),
    err => err.code === 'CLOSED');

  db.setWeekLock(true);
  await assert.rejects(() => submit(db, wd, 11, {week: 11, name: 'Cam', tag: 'Crew', picks: all, tiebreaker: 40, zq7f: ''}, before, 'ip'),
    err => err.code === 'CLOSED');
});

function scoreboard(events) {
  global.fetch = async () => ({ok: true, async json() { return {events}; }});
}
function event(away, home, state, done) {
  return {competitions: [{competitors: [
    {team: {abbreviation: away}, score: '0'},
    {team: {abbreviation: home}, score: '0'}
  ]}], status: {type: {state, completed: !!done, shortDetail: state}}};
}

test('lock then unlock still auto-locks at the first kickoff, and a started game cannot be edited', async () => {
  global.fetch = async () => { throw new Error('espn down'); };
  const db = memoryDb();
  const before = Date.parse('2026-11-19T00:00:00Z');
  const all = {'IND @ HOU': 'HOU', 'TB @ DET': 'DET', 'DAL @ PHI': 'PHI', 'CIN @ WAS': 'WAS'};
  await setPicksLocked(db, 11, true);
  assert.equal(await getPicksLocked(db, 11), true);
  await assert.rejects(() => submit(db, wd, 11, {week: 11, name: 'Andy', tag: 'Crew', picks: all, tiebreaker: 40, zq7f: ''}, before, 'ip'),
    err => err.code === 'CLOSED');
  const cleared = await setPicksLocked(db, 11, false);
  assert.equal(cleared.picks_locked, false);
  assert.equal(await getPicksLocked(db, 11), null);
  db.setWeekLock('0');
  assert.equal(await getPicksLocked(db, 11), null);
  const created = await submit(db, wd, 11, {week: 11, name: 'Andy', tag: 'Crew', picks: all, tiebreaker: 40, zq7f: ''}, before, 'ip');
  assert.equal(created.ok, true);
  await assert.rejects(() => submit(db, wd, 11, {week: 11, name: 'Bea', tag: 'Crew', picks: all, tiebreaker: 40, zq7f: ''}, NOW, 'ip'),
    err => err.code === 'CLOSED');

  const code = 'WXYZ';
  db.rows[0].edit_code_hash = codeHash(11, 'andy', code);
  const partialAt = Date.parse('2026-11-19T12:00:00Z');
  scoreboard([
    event('IND', 'HOU', 'post', false),
    event('TB', 'DET', 'in', false)
  ]);
  for (const flag of [null, '0', true]) {
    db.setWeekLock(flag);
    const changed = Object.assign({}, all, {'TB @ DET': 'TB'});
    await assert.rejects(() => submit(db, wd, 11, {week: 11, name: 'Andy', tag: 'Crew', code, picks: changed, tiebreaker: 40, zq7f: ''}, partialAt, 'ip'),
      err => flag === true ? err.code === 'CLOSED' : err.code === 'STARTED' && /TB @ DET/.test(err.message));
  }
  db.setWeekLock(null);
  const kept = await submit(db, wd, 11, {week: 11, name: 'Andy', tag: 'Crew', code, picks: Object.assign({}, all, {'CIN @ WAS': 'CIN'}), tiebreaker: 44, zq7f: ''}, partialAt, 'ip');
  assert.equal(kept.picks['TB @ DET'], 'DET');
  assert.equal(kept.picks['CIN @ WAS'], 'CIN');
  assert.equal(kept.tiebreaker, 44);
});
