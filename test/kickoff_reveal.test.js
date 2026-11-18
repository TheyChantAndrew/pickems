const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setDbForTests} = require('../lib/db');
const {setClockForTests} = require('../lib/handler');
const {adminEntries} = require('../lib/core');

function game(matchup, away, home, awayTeam, homeTeam, kickoff, extra) {
  return Object.assign({matchup, away, home, away_team: awayTeam, home_team: homeTeam, kickoff, kickoff_label: 't', is_monday: false}, extra);
}

const weeks = {
  11: {
    week: 11, year: 2026, entry_fee: 10, open: true, sunday_final: false,
    games: [
      game('IND @ HOU', 'IND', 'HOU', 'Colts', 'Texans', '2026-11-20T01:15:00Z'),
      game('DAL @ NYJ', 'DAL', 'NYJ', 'Cowboys', 'Jets', '2026-11-25T18:00:00Z'),
      game('TB @ DET', 'TB', 'DET', 'Buccaneers', 'Lions', '2026-11-23T18:00:00Z'),
      game('CIN @ WAS', 'CIN', 'WAS', 'Bengals', 'Commanders', '2026-11-24T01:15:00Z', {is_monday: true, is_tiebreaker: true})
    ]
  },
  10: {
    week: 10, year: 2026, entry_fee: 10, open: true, sunday_final: false,
    games: [
      game('PIT @ CIN', 'PIT', 'CIN', 'Steelers', 'Bengals', '2026-11-16T01:20:00Z'),
      game('LAC @ BAL', 'LAC', 'BAL', 'Chargers', 'Ravens', '2026-11-17T01:15:00Z', {is_monday: true, is_tiebreaker: true})
    ]
  }
};

function row(id, week, name, picks, tb) {
  return {id, week, name, name_key: name.toLowerCase(), tag: 'Crew', picks: JSON.stringify(picks), tiebreaker: tb,
    edit_code_hash: 'ab'.repeat(32), paid: 1, paid_at: null, void: 0, void_at: null, source: 'web',
    notes: '', version: 1, created_at: '2026-11-17T00:00:00Z', updated_at: '2026-11-17T00:00:00Z'};
}

const entries = [
  row(1, 11, 'Andy', {'IND @ HOU': 'Texans', 'DAL @ NYJ': 'Jets', 'TB @ DET': 'Lions', 'CIN @ WAS': 'Bengals'}, 40),
  row(2, 11, 'Martin', {'IND @ HOU': 'Colts', 'DAL @ NYJ': 'Cowboys', 'TB @ DET': 'Buccaneers', 'CIN @ WAS': 'Commanders'}, 51),
  row(3, 10, 'Andy', {'PIT @ CIN': 'Bengals', 'LAC @ BAL': 'Ravens'}, 42)
];

setDbForTests({
  async execute(q) {
    const sql = String(q && q.sql || '');
    const arg = q && q.args && q.args[0];
    if (sql.includes('pragma_table_info')) return {rows: [{n: 1}]};
    if (sql.includes('FROM meta') && arg === 'current_week') return {rows: [{value: '11'}]};
    if (sql.includes('FROM meta') && String(arg || '').startsWith('week_data:')) {
      const n = String(arg).slice('week_data:'.length);
      return weeks[n] ? {rows: [{value: JSON.stringify(weeks[n])}]} : {rows: []};
    }
    if (sql.includes('FROM meta')) return {rows: []};
    if (sql.includes('deleted_entries')) return {rows: []};
    if (sql.includes('FROM entries')) return {rows: entries.filter(e => e.week === Number(arg))};
    return {rows: []};
  },
  async batch(stmts) {
    const out = [];
    for (const s of stmts || []) out.push(await this.execute(s));
    return out;
  }
});

let fetchMode = 'live-early';
global.fetch = async () => {
  if (fetchMode === 'throw') throw new Error('espn down');
  const events = fetchMode === 'live-early' ? [
    {competitions: [{competitors: [
      {homeAway: 'away', team: {abbreviation: 'TB'}, score: '7'},
      {homeAway: 'home', team: {abbreviation: 'DET'}, score: '3'}
    ]}], status: {type: {state: 'in', completed: false, shortDetail: '1st 10:00'}}},
    {competitions: [{competitors: [
      {homeAway: 'away', team: {abbreviation: 'DAL'}, score: ''},
      {homeAway: 'home', team: {abbreviation: 'NYJ'}, score: ''}
    ]}], status: {type: {state: 'post', completed: false, shortDetail: 'Postponed'}}}
  ] : [];
  return {ok: true, async json() { return {events}; }};
};

const board = require('../api/games');
const entriesApi = require('../api/entries');

function call(handler, url) {
  const res = {statusCode: 0, setHeader() {}, end(body) { this.body = body; }};
  return handler({method: 'GET', url, headers: {}}, res).then(() => ({status: res.statusCode, body: JSON.parse(res.body)}));
}
function cell(body, name, key) {
  return body.players.find(p => p.name === name).picks[key];
}

test('picks stay locked until kickoff, and a started or past game is revealed', async () => {
  setClockForTests(() => Date.parse('2026-11-20T00:00:00Z'));
  const early = await call(board, '/api/games?board=1&week=11');
  assert.equal(early.status, 200);
  assert.equal(early.body.status.games_total, 4);
  const players = JSON.stringify(early.body.players);
  const postponed = early.body.games.find(g => g.matchup === 'DAL @ NYJ');
  assert.equal(postponed.hidden, true);
  assert.equal(cell(early.body, 'Andy', 'dal-nyj').text, '🔒');
  assert.equal(players.includes('Jets'), false);
  assert.equal(early.body.games.find(g => g.matchup === 'IND @ HOU').hidden, true);
  assert.equal(cell(early.body, 'Andy', 'ind-hou').text, '🔒');
  assert.equal(cell(early.body, 'Andy', 'ind-hou').cls, 'pick-hidden');
  assert.equal(cell(early.body, 'Martin', 'ind-hou').text, '🔒');
  assert.equal(players.includes('Texans'), false);
  assert.equal(players.includes('Colts'), false);
  assert.equal(players.includes('Bengals'), false);
  assert.equal(players.includes('Commanders'), false);
  assert.equal(players.includes('"tiebreaker":40'), false);
  assert.equal(players.includes('"tiebreaker":51'), false);
  const started = early.body.games.find(g => g.matchup === 'TB @ DET');
  assert.equal(started.hidden, false);
  assert.equal(started.status, 'live');
  assert.equal(cell(early.body, 'Andy', 'tb-det').text, 'DET');
  assert.equal(cell(early.body, 'Martin', 'tb-det').text, 'TB');
  assert.equal(cell(early.body, 'Andy', 'tb-det').cls, 'pick-split');
  assert.equal(cell(early.body, 'Martin', 'tb-det').cls, 'pick-split');
  assert.equal(cell(early.body, 'Andy', 'cin-was').text, '🔒');
  const pub = await call(entriesApi, '/api/entries?week=11');
  assert.equal(pub.status, 200);
  assert.equal(pub.body.entries[0].picks['IND @ HOU'], undefined);
  assert.equal(pub.body.entries[0].picks['DAL @ NYJ'], undefined);
  assert.equal(pub.body.entries[0].picks['CIN @ WAS'], undefined);
  assert.equal(pub.body.entries[0].picks['TB @ DET'], 'Lions');
  assert.equal(pub.body.entries[0].tiebreaker, undefined);

  setClockForTests(() => Date.parse('2026-11-24T01:15:00Z'));
  fetchMode = 'quiet';
  const monday = await call(board, '/api/games?board=1&week=11');
  assert.equal(monday.status, 200);
  const mon = monday.body.games.find(g => g.is_monday);
  assert.equal(mon.hidden, false);
  assert.equal(cell(monday.body, 'Andy', 'cin-was').text, 'CIN');
  assert.equal(cell(monday.body, 'Martin', 'cin-was').text, 'WAS');
  assert.equal(cell(monday.body, 'Andy', 'cin-was').cls, 'pick-split');
  assert.equal(monday.body.players.find(p => p.name === 'Andy').tiebreaker, 40);
  assert.equal(monday.body.players.find(p => p.name === 'Andy').picks.tb.text, '40');
  assert.equal(cell(monday.body, 'Andy', 'ind-hou').text, 'HOU');

  setClockForTests(() => Date.parse('2026-11-18T20:00:00Z'));
  fetchMode = 'throw';
  const past = await call(board, '/api/games?board=1&week=10');
  assert.equal(past.status, 200);
  assert.equal(past.body.games.every(g => g.hidden === false), true);
  assert.equal(past.body.status.games_total, 2);
  assert.equal(cell(past.body, 'Andy', 'lac-bal').text, 'BAL');
  assert.equal(cell(past.body, 'Andy', 'pit-cin').text, 'CIN');
  assert.equal(past.body.players[0].tiebreaker, 42);
  const pastPub = await call(entriesApi, '/api/entries?week=10');
  assert.equal(pastPub.body.entries[0].picks['LAC @ BAL'], 'Ravens');
  assert.equal(pastPub.body.entries[0].tiebreaker, 42);

  const kept = adminEntries([{name: 'Andy', tag: 'Crew', picks: {'CIN @ WAS': 'Bengals'}, tiebreaker: 40, paid: true, void: false, source: 'web', submitted: '', updated: '', notes: ''}]);
  assert.equal(kept[0].picks['CIN @ WAS'], 'Bengals');
  assert.equal(kept[0].tiebreaker, 40);
});
