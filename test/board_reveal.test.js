const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {setDbForTests} = require('../lib/db');
const {revealIfReady} = require('../lib/schedule');

const weeks = {
  8: fs.readFileSync(path.join(__dirname, '../data/week8.json'), 'utf8'),
  9: fs.readFileSync(path.join(__dirname, '../data/week9.json'), 'utf8'),
  10: JSON.stringify({
    week: 10, year: 2026, entry_fee: 10, open: true, sunday_final: false,
    games: [
      {matchup: 'PIT @ CIN', away: 'PIT', home: 'CIN', away_team: 'Steelers', home_team: 'Bengals', kickoff: '2026-11-16T01:20:00Z', kickoff_label: 'Sun 11/15 5:20PM PT', is_monday: false},
      {matchup: 'LAC @ BAL', away: 'LAC', home: 'BAL', away_team: 'Chargers', home_team: 'Ravens', kickoff: '2026-11-17T01:15:00Z', kickoff_label: 'Mon 11/16 5:15PM PT', is_monday: true}
    ]
  })
};
const parsed = Object.fromEntries(Object.entries(weeks).map(([k, v]) => [k, JSON.parse(v)]));

function entry(week) {
  const wd = parsed[week];
  const picks = {};
  wd.games.forEach(g => { picks[g.matchup] = g.home_team; });
  return {id: Number(week), week: Number(week), name: 'Andy', name_key: 'andy', tag: 'Comish',
    picks: JSON.stringify(picks), tiebreaker: 41, edit_code_hash: 'ab'.repeat(32), paid: 1, paid_at: null,
    void: 0, void_at: null, source: 'web', notes: '', version: 1,
    created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z'};
}
const entries = [8, 9, 10].map(entry);

const db = {
  async execute(q) {
    const sql = String(q && q.sql || '');
    const arg = q && q.args && q.args[0];
    if (sql.includes('pragma_table_info')) return {rows: [{n: 1}]};
    if (sql.includes('FROM meta') && arg === 'current_week') return {rows: [{value: '10'}]};
    if (sql.includes('FROM meta') && String(arg || '').startsWith('week_data:')) {
      const n = String(arg).slice('week_data:'.length);
      return weeks[n] ? {rows: [{value: weeks[n]}]} : {rows: []};
    }
    if (sql.includes('deleted_entries')) return {rows: []};
    if (sql.includes('FROM entries')) return {rows: entries.filter(e => e.week === Number(arg))};
    return {rows: []};
  },
  async batch(stmts) {
    const out = [];
    for (const s of stmts || []) out.push(typeof s === 'string' ? {rows: []} : await this.execute(s));
    return out;
  }
};
setDbForTests(db);

let fetchMode = 'final';
global.fetch = async () => {
  if (fetchMode === 'throw') throw new Error('espn down');
  if (fetchMode === 'hang') return new Promise(() => {});
  const wd = parsed[fetchMode] || parsed[10];
  return {ok: true, async json() {
    return {events: wd.games.map(g => ({
      competitions: [{competitors: [
        {homeAway: 'away', team: {abbreviation: g.away}, score: g.is_monday ? '0' : '21'},
        {homeAway: 'home', team: {abbreviation: g.home}, score: g.is_monday ? '0' : '17'}
      ]}],
      status: {type: {state: g.is_monday ? 'pre' : 'post', completed: !g.is_monday, shortDetail: g.is_monday ? 'Mon' : 'Final'}}
    }))};
  }};
};

const board = require('../api/games');
const entriesApi = require('../api/entries');

function call(handler, url) {
  const res = {statusCode: 0, setHeader() {}, end(body) { this.body = body; }};
  return handler({method: 'GET', url, headers: {}}, res).then(() => ({status: res.statusCode, body: JSON.parse(res.body)}));
}

test('reveal shows every Monday game only after the earlier slate is final', () => {
  const wd = {sunday_final: false, games: [
    {matchup: 'PIT @ CIN', away: 'PIT', home: 'CIN', is_monday: false},
    {matchup: 'DAL @ PHI', away: 'DAL', home: 'PHI', is_monday: true},
    {matchup: 'LAC @ BAL', away: 'LAC', home: 'BAL', is_monday: true}
  ]};
  const espn = {
    'CIN|PIT': {state: 'post', done: true, sc: {PIT: 18, CIN: 38}},
    'DAL|PHI': {state: 'pre', done: false, sc: {DAL: 0, PHI: 0}},
    'BAL|LAC': {state: 'pre', done: false, sc: {LAC: 0, BAL: 0}}
  };
  const shown = revealIfReady(wd, espn);
  assert.equal(shown.sunday_final, true);
  assert.notEqual(shown, wd);
  assert.equal(revealIfReady(wd, null), wd);
  espn['CIN|PIT'] = {state: 'in', done: false, sc: {PIT: 7, CIN: 7}};
  assert.equal(revealIfReady(wd, espn).sunday_final, false);
  const forced = Object.assign({}, wd, {sunday_final: true});
  assert.equal(revealIfReady(forced, null), forced);
  const boom = new Proxy({}, {get() { throw new Error('bad scoreboard'); }});
  assert.equal(revealIfReady(wd, boom), wd);
});

test('board stays 200 for weeks 8, 9, and 10, reveals Monday, and hides it if ESPN fails', async () => {
  for (const week of [8, 9, 10]) {
    fetchMode = String(week);
    const res = await call(board, '/api/games?board=1&week=' + week);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.week, week);
    assert.ok(res.body.players.length >= 1, 'players for week ' + week);
    assert.equal(res.body.code, undefined);
  }
  fetchMode = '10';
  const cur = await call(board, '/api/games?board=1');
  assert.equal(cur.status, 200);
  assert.equal(cur.body.week, 10);
  const mon = cur.body.games.find(g => g.matchup === 'LAC @ BAL');
  assert.equal(mon.hidden, false);
  assert.equal(cur.body.players[0].picks['lac-bal'].text, 'BAL');
  const pub = await call(entriesApi, '/api/entries?week=10');
  assert.equal(pub.status, 200);
  assert.equal(pub.body.sunday_final, true);
  assert.equal(pub.body.entries[0].picks['LAC @ BAL'], 'Ravens');

  fetchMode = 'throw';
  const down = await call(board, '/api/games?board=1&week=10');
  assert.equal(down.status, 200, JSON.stringify(down.body));
  assert.equal(down.body.week, 10);
  assert.equal(down.body.players.length, 1);
  const hidden = down.body.games.find(g => g.is_monday);
  assert.equal(hidden.hidden, true);
  assert.equal(down.body.players[0].picks[hidden.key], undefined);
  const pubDown = await call(entriesApi, '/api/entries?week=10');
  assert.equal(pubDown.status, 200);
  assert.equal(pubDown.body.sunday_final, false);
  assert.equal(pubDown.body.entries[0].picks['LAC @ BAL'], undefined);
});
