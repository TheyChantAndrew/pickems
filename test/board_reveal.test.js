const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {setDbForTests} = require('../lib/db');
const {revealIfReady} = require('../lib/schedule');

const weeks = {
  8: fs.readFileSync(path.join(__dirname, '../data/week8.json'), 'utf8'),
  9: fs.readFileSync(path.join(__dirname, '../data/week9.json'), 'utf8'),
  5: JSON.stringify({week: 5, year: 2026, sunday_final: true, games: [{matchup: 'TB @ DAL', away: 'TB', home: 'DAL', away_team: 'TB', home_team: 'DAL', kickoff: '2026-10-09T00:15:00Z', kickoff_label: 'Thu', is_monday: false}]}),
  6: JSON.stringify({week: 6, year: 2026, sunday_final: true, games: [{matchup: 'SEA @ DEN', away: 'SEA', home: 'DEN', away_team: 'SEA', home_team: 'DEN', kickoff: '2026-10-16T00:15:00Z', kickoff_label: 'Thu', is_monday: false}]}),
  7: JSON.stringify({week: 7, year: 2026, sunday_final: true, games: [{matchup: 'NE @ CHI', away: 'NE', home: 'CHI', away_team: 'NE', home_team: 'CHI', kickoff: '2026-10-23T00:15:00Z', kickoff_label: 'Thu', is_monday: false}]}),
  10: JSON.stringify({
    week: 10, year: 2026, entry_fee: 10, open: true, sunday_final: false,
    games: [
      {matchup: 'PIT @ CIN', away: 'PIT', home: 'CIN', away_team: 'Steelers', home_team: 'Bengals', kickoff: '2026-11-16T01:20:00Z', kickoff_label: 'Sun 11/15 5:20PM PT', is_monday: false},
      {matchup: 'LAC @ BAL', away: 'LAC', home: 'BAL', away_team: 'Chargers', home_team: 'Ravens', kickoff: '2026-11-17T01:15:00Z', kickoff_label: 'Mon 11/16 5:15PM PT', is_monday: true}
    ]
  }),
  12: JSON.stringify({
    week: 12, year: 2026, sunday_final: false,
    games: [
      {matchup: 'GB @ CHI', away: 'GB', home: 'CHI', away_team: 'GB', home_team: 'CHI', kickoff: '2026-11-26T21:00:00Z', kickoff_label: 'Thu', is_monday: false},
      {matchup: 'BUF @ DEN', away: 'BUF', home: 'DEN', away_team: 'BUF', home_team: 'DEN', kickoff: '2026-11-28T21:30:00Z', kickoff_label: 'Sat', is_monday: false},
      {matchup: 'NE @ DET', away: 'NE', home: 'DET', away_team: 'NE', home_team: 'DET', kickoff: '2026-11-29T14:30:00Z', kickoff_label: 'Sun', is_monday: false}
    ]
  }),
  13: JSON.stringify({
    week: 13, year: 2026, sunday_final: false,
    games: [
      {matchup: 'KC @ ATL', away: 'KC', home: 'ATL', away_team: 'KC', home_team: 'ATL', kickoff: '2026-12-06T18:00:00Z', kickoff_label: 'Sun', is_monday: false},
      {matchup: 'DAL @ PHI', away: 'DAL', home: 'PHI', away_team: 'DAL', home_team: 'PHI', kickoff: '2026-12-07T21:00:00Z', kickoff_label: 'Mon', is_monday: true},
      {matchup: 'LAC @ BAL', away: 'LAC', home: 'BAL', away_team: 'LAC', home_team: 'BAL', kickoff: '2026-12-08T01:15:00Z', kickoff_label: 'Mon', is_monday: true}
    ]
  }),
  14: JSON.stringify({
    week: 14, year: 2026, sunday_final: false,
    games: [
      {matchup: 'GB @ CHI', away: 'GB', home: 'CHI', away_team: 'GB', home_team: 'CHI', kickoff: '2026-11-26T17:30:00Z', kickoff_label: 'Thu', is_monday: false},
      {matchup: 'DAL @ DET', away: 'DAL', home: 'DET', away_team: 'DAL', home_team: 'DET', kickoff: '2026-11-27T21:30:00Z', kickoff_label: 'Fri', is_monday: false},
      {matchup: 'HOU @ LAR', away: 'HOU', home: 'LAR', away_team: 'HOU', home_team: 'LAR', kickoff: '2026-11-28T21:00:00Z', kickoff_label: 'Sat', is_monday: false},
      {matchup: 'NE @ NYJ', away: 'NE', home: 'NYJ', away_team: 'NE', home_team: 'NYJ', kickoff: '2026-11-29T18:00:00Z', kickoff_label: 'Sun', is_monday: false},
      {matchup: 'CIN @ WAS', away: 'CIN', home: 'WAS', away_team: 'CIN', home_team: 'WAS', kickoff: '2026-11-30T01:15:00Z', kickoff_label: 'Mon', is_monday: true}
    ]
  }),
  15: JSON.stringify({
    week: 15, year: 2026, sunday_final: false,
    games: [
      {matchup: 'SEA @ SF', away: 'SEA', home: 'SF', away_team: 'SEA', home_team: 'SF', kickoff: 'not-a-date', kickoff_label: 'Sun', is_monday: false}
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
const entries = [5, 6, 7, 8, 9, 10, 12, 13, 14, 15].map(entry);

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
  if (fetchMode === 'stale') {
    return {ok: true, async json() {
      return {events: [{competitions: [{competitors: [
        {homeAway: 'away', team: {abbreviation: 'TB'}, score: '17'},
        {homeAway: 'home', team: {abbreviation: 'DAL'}, score: '14'}
      ]}], status: {type: {state: 'in', completed: false, shortDetail: '3rd 4:12'}}}]};
    }};
  }
  if (fetchMode === 'live' || fetchMode === 'live-missing') {
    const missing = fetchMode === 'live-missing';
    return {ok: true, async json() {
      return {events: [
        {competitions: [{competitors: [
          {homeAway: 'away', team: {abbreviation: 'PIT'}, score: missing ? '' : '17'},
          {homeAway: 'home', team: {abbreviation: 'CIN'}, score: missing ? null : '14'}
        ]}], status: {type: {state: 'in', completed: false, shortDetail: '3rd 4:12'}}},
        {competitions: [{competitors: [
          {homeAway: 'away', team: {abbreviation: 'LAC'}, score: '0'},
          {homeAway: 'home', team: {abbreviation: 'BAL'}, score: '0'}
        ]}], status: {type: {state: 'pre', completed: false, shortDetail: 'Mon'}}}
      ]};
    }};
  }
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
  const saturday = {sunday_final: false, games: [
    {matchup: 'BUF @ DEN', away: 'BUF', home: 'DEN', is_monday: false},
    {matchup: 'DAL @ PHI', away: 'DAL', home: 'PHI', is_monday: true}
  ]};
  assert.equal(revealIfReady(saturday, {'BUF|DEN': {state: 'pre', done: false}}).sunday_final, false);
  assert.equal(revealIfReady(saturday, {'BUF|DEN': {state: 'post', done: true}}).sunday_final, true);
  const noMonday = {sunday_final: false, games: [{matchup: 'GB @ CHI', away: 'GB', home: 'CHI', is_monday: false}]};
  assert.equal(revealIfReady(noMonday, {'CHI|GB': {state: 'post', done: true}}).sunday_final, true);
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
  assert.equal(cur.body.current_week, 10);
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

  const missing = await call(board, '/api/games?board=1&week=11');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'WEEK');

  fetchMode = '12';
  const none = await call(board, '/api/games?board=1&week=12');
  assert.equal(none.status, 200);
  assert.equal(none.body.games.filter(g => g.is_monday).length, 0);
  assert.ok(none.body.players.length >= 1);

  fetchMode = '13';
  const two = await call(board, '/api/games?board=1&week=13');
  assert.equal(two.status, 200);
  const mons = two.body.games.filter(g => g.is_monday);
  assert.deepEqual(mons.map(g => g.matchup), ['DAL @ PHI', 'LAC @ BAL']);
  assert.equal(mons.every(g => g.hidden === false), true);
  assert.equal(two.body.players[0].picks['dal-phi'].text, 'PHI');
  assert.equal(two.body.players[0].picks['lac-bal'].text, 'BAL');

  fetchMode = '14';
  const feast = await call(board, '/api/games?board=1&week=14');
  assert.equal(feast.status, 200);
  const feastMon = feast.body.games.filter(g => g.is_monday);
  assert.equal(feastMon.length, 1);
  assert.equal(feastMon[0].hidden, false);
  assert.equal(feast.body.games.filter(g => !g.is_monday).length, 4);

  fetchMode = '15';
  const bad = await call(board, '/api/games?board=1&week=15');
  assert.equal(bad.status, 200, JSON.stringify(bad.body));
  assert.equal(bad.body.degraded, true);
  assert.equal(bad.body.week, 15);
  assert.notEqual(bad.body.code, 'ERR');

  for (const week of [5, 6, 7, 8, 9, 10]) {
    if (!parsed[week]) continue;
    fetchMode = String(week);
    const res = await call(board, '/api/games?board=1&week=' + week);
    assert.equal(res.status, 200, 'week ' + week);
    assert.ok(res.body.players.length >= 1);
  }

  fetchMode = 'live';
  const live = await call(board, '/api/games?board=1&week=10');
  assert.equal(live.status, 200);
  assert.equal(live.body.players.length, 1);
  const pit = live.body.games.find(g => g.matchup === 'PIT @ CIN');
  assert.equal(pit.status, 'live');
  assert.equal(pit.away_score, 17);
  assert.equal(pit.home_score, 14);
  assert.equal(pit.score, 'PIT 17 – CIN 14');
  assert.equal(pit.clock, 'Q3 4:12');
  assert.equal(live.body.status.live_games[0].away_score, 17);
  assert.equal(live.body.status.live_games[0].home_score, 14);
  const scheduled = live.body.games.find(g => g.matchup === 'LAC @ BAL');
  assert.equal(scheduled.status, 'pre');
  assert.equal(scheduled.score, null);

  fetchMode = 'stale';
  const past = await call(board, '/api/games?board=1&week=5');
  assert.equal(past.status, 200);
  assert.equal(past.body.players.length, 1);
  assert.equal(past.body.games[0].status, 'pre');
  assert.equal(past.body.games[0].score, null);
  assert.equal(past.body.status.live_games.length, 0);
  fetchMode = '5';
  const pastFinal = await call(board, '/api/games?board=1&week=5');
  assert.equal(pastFinal.status, 200);
  assert.equal(pastFinal.body.games[0].status, 'final');
  assert.equal(pastFinal.body.games[0].score, 'TB 21 – DAL 17');

  fetchMode = 'live-missing';
  const blank = await call(board, '/api/games?board=1&week=10');
  assert.equal(blank.status, 200);
  const nosc = blank.body.games.find(g => g.matchup === 'PIT @ CIN');
  assert.equal(nosc.status, 'live');
  assert.equal(nosc.away_score, null);
  assert.equal(nosc.home_score, null);
  assert.equal(nosc.score, null);
  assert.equal(blank.body.status.live_games[0].away_score, undefined);
  assert.equal(blank.body.players.length, 1);
});
