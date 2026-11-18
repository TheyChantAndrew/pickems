const {test} = require('node:test');
const assert = require('node:assert/strict');
const {submit, codeHash, withLocks} = require('../lib/core');
const {withLocks: rawLocks} = require('../lib/core_part1');
const {tiebreakerGame, pickRevealed} = require('../lib/schedule');

const NOW = Date.parse('2026-11-21T18:00:00Z');
function g(matchup, away, home, kickoff, monday) {
  return {matchup, away, home, away_team: away, home_team: home, kickoff, kickoff_label: 't', is_monday: !!monday};
}
const wd = {
  week: 11, year: 2026, open: true, picks_locked: false,
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
  const early = rawLocks(wd, Date.parse('2026-11-19T00:00:00Z'), {'HOU|IND': {state: 'post', done: false}});
  assert.equal(early.games.find(x => x.matchup === 'IND @ HOU').locked, false);
  assert.equal(early.tiebreaker_game, 'CIN @ WAS');
  assert.equal(early.tiebreaker_locked, false);
  const mid = rawLocks(wd, NOW, {'DET|TB': {state: 'in', done: false}});
  assert.equal(mid.games.find(x => x.matchup === 'IND @ HOU').locked, true);
  assert.equal(mid.games.find(x => x.matchup === 'TB @ DET').locked, true);
  assert.equal(mid.games.find(x => x.matchup === 'CIN @ WAS').locked, false);
  assert.equal(mid.locked, false);
  assert.equal(mid.tiebreaker_locked, false);
  const forced = withLocks(Object.assign({}, wd, {picks_locked: true}), Date.parse('2026-11-19T00:00:00Z'));
  assert.equal(forced.locked, true);
  assert.equal(forced.games.every(x => x.locked), true);
  assert.equal(forced.tiebreaker_locked, true);
});

function memoryDb() {
  const rows = [];
  let id = 0;
  let weekLock = false;
  const db = {
    rows,
    setWeekLock(v) { weekLock = v; },
    async execute(q) {
      const sql = String(q.sql || '');
      const args = q.args || [];
      if (sql.includes('FROM meta') && String(args[0] || '').startsWith('picks_lock')) return {rows: weekLock ? [{value: '1'}] : []};
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

test('a new entry cannot set a started game, and an edit cannot change one', async () => {
  global.fetch = async () => { throw new Error('espn down'); };
  const db = memoryDb();
  const open = {'TB @ DET': 'DET', 'DAL @ PHI': 'PHI', 'CIN @ WAS': 'WAS'};
  await assert.rejects(() => submit(db, wd, 11, {week: 11, name: 'Andy', tag: 'Crew', picks: Object.assign({'IND @ HOU': 'HOU'}, open), tiebreaker: 40, zq7f: ''}, NOW, 'ip'),
    err => err.code === 'STARTED' && /IND @ HOU/.test(err.message));
  const created = await submit(db, wd, 11, {week: 11, name: 'Andy', tag: 'Crew', picks: open, tiebreaker: 40, zq7f: ''}, NOW, 'ip');
  assert.equal(created.ok, true);
  assert.equal(created.picks['IND @ HOU'], undefined);
  assert.equal(created.picks['TB @ DET'], 'DET');
  assert.equal(db.rows[0].notes.includes('IND @ HOU'), true);

  const code = 'ABCD';
  db.rows[0].edit_code_hash = codeHash(11, 'andy', code);
  db.rows[0].picks = JSON.stringify(Object.assign({'IND @ HOU': 'HOU'}, open));
  await assert.rejects(() => submit(db, wd, 11, {week: 11, name: 'Andy', tag: 'Crew', code, picks: Object.assign({'IND @ HOU': 'IND'}, open), tiebreaker: 40, zq7f: ''}, NOW, 'ip'),
    err => err.code === 'STARTED');
  const same = await submit(db, wd, 11, {week: 11, name: 'Andy', tag: 'Crew', code, picks: Object.assign({'IND @ HOU': 'HOU'}, open), tiebreaker: 41, zq7f: ''}, NOW, 'ip');
  assert.equal(same.picks['IND @ HOU'], 'HOU');
  assert.equal(same.picks['TB @ DET'], 'DET');
  assert.equal(same.tiebreaker, 41);

  db.setWeekLock(true);
  await assert.rejects(() => submit(db, wd, 11, {week: 11, name: 'Bea', tag: 'Crew', picks: open, tiebreaker: 40, zq7f: ''}, NOW, 'ip'),
    err => err.code === 'CLOSED');
});
