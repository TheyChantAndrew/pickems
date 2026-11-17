const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {setDbForTests} = require('../lib/db');

function game(matchup, away, home, awayTeam, homeTeam, kickoff, monday) {
  return {matchup, away, home, away_team: awayTeam, home_team: homeTeam, kickoff, kickoff_label: monday ? 'Mon' : 'Sun', is_monday: !!monday};
}

const weeks = {
  11: {
    week: 11, year: 2026, entry_fee: 10, open: true, sunday_final: false,
    games: [
      game('TB @ DET', 'TB', 'DET', 'Buccaneers', 'Lions', '2026-11-22T18:00:00Z'),
      game('BAL @ CAR', 'BAL', 'CAR', 'Ravens', 'Panthers', '2026-11-22T18:00:00Z'),
      game('IND @ HOU', 'IND', 'HOU', 'Colts', 'Texans', '2026-11-22T18:00:00Z'),
      game('SEA @ GB', 'SEA', 'GB', 'Seahawks', 'Packers', '2026-11-22T18:00:00Z'),
      game('NE @ NYJ', 'NE', 'NYJ', 'Patriots', 'Jets', '2026-11-22T18:00:00Z'),
      game('PIT @ CIN', 'PIT', 'CIN', 'Steelers', 'Bengals', '2026-11-22T21:20:00Z'),
      game('LAC @ BAL', 'LAC', 'BAL', 'Chargers', 'Ravens', '2026-11-23T01:15:00Z'),
      game('CIN @ WAS', 'CIN', 'WAS', 'Bengals', 'Commanders', '2026-11-24T01:15:00Z', true)
    ]
  },
  5: {
    week: 5, year: 2026, entry_fee: 10, open: true, sunday_final: true,
    games: [
      game('TB @ DAL', 'TB', 'DAL', 'Buccaneers', 'Cowboys', '2026-10-09T00:15:00Z'),
      game('SEA @ GB', 'SEA', 'GB', 'Seahawks', 'Packers', '2026-10-12T17:00:00Z')
    ]
  }
};

function row(id, week, name, picks, voided) {
  return {id, week, name, name_key: name.toLowerCase(), tag: '', picks: JSON.stringify(picks), tiebreaker: null,
    edit_code_hash: 'ab'.repeat(32), paid: 0, paid_at: null, void: voided ? 1 : 0, void_at: null, source: 'web',
    notes: '', version: 1, created_at: '2026-11-17T00:00:00Z', updated_at: '2026-11-17T00:00:00Z'};
}

const entries = [
  row(1, 11, 'Andy', {'TB @ DET': 'Lions', 'BAL @ CAR': 'Ravens', 'IND @ HOU': 'Texans', 'SEA @ GB': 'Seahawks', 'NE @ NYJ': 'Patriots', 'PIT @ CIN': 'Bengals', 'LAC @ BAL': 'Chargers', 'CIN @ WAS': 'Bengals'}),
  row(2, 11, 'Martin', {'TB @ DET': 'Buccaneers', 'BAL @ CAR': 'Panthers', 'IND @ HOU': 'Texans', 'SEA @ GB': 'Seahawks', 'PIT @ CIN': 'Steelers', 'LAC @ BAL': 'Ravens', 'CIN @ WAS': 'Commanders'}),
  row(3, 11, 'Ghost', {'TB @ DET': 'Lions', 'BAL @ CAR': 'Ravens', 'IND @ HOU': 'Texans', 'SEA @ GB': 'Packers', 'PIT @ CIN': 'Steelers'}, true),
  row(4, 5, 'Andy', {'TB @ DAL': 'Cowboys', 'SEA @ GB': 'Seahawks'}),
  row(5, 5, 'Martin', {'TB @ DAL': 'Buccaneers', 'SEA @ GB': 'Packers'})
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

global.fetch = async (url) => {
  const week = (/[?&]week=(\d+)/.exec(String(url)) || [])[1];
  const events = week === '11' ? [
    event('PIT', 'CIN', 'post', true, '10', '24', 'Final'),
    event('LAC', 'BAL', 'in', false, '7', '3', '3rd 4:12')
  ] : week === '5' ? [
    event('TB', 'DAL', 'post', true, '14', '21', 'Final')
  ] : [];
  return {ok: true, async json() { return {events}; }};
};

function event(away, home, state, done, awayScore, homeScore, detail) {
  return {competitions: [{competitors: [
    {homeAway: 'away', team: {abbreviation: away}, score: awayScore},
    {homeAway: 'home', team: {abbreviation: home}, score: homeScore}
  ]}], status: {type: {state, completed: done, shortDetail: detail}}};
}

const board = require('../api/games');

function call(url) {
  const res = {statusCode: 0, setHeader() {}, end(body) { this.body = body; }};
  return board({method: 'GET', url, headers: {}}, res).then(() => ({status: res.statusCode, body: JSON.parse(res.body)}));
}

function cell(body, name, key) {
  const p = body.players.find(x => x.name === name);
  assert.ok(p, name);
  return p.picks[key];
}

test('unplayed disagreements are split, and agreement, live, final, and hidden picks stay as they are', async () => {
  const liveJs = fs.readFileSync(path.join(__dirname, '../public/live.js'), 'utf8');
  assert.match(liveJs, /td\.className = pk\.cls \|\| "pick-pending"/);

  const res = await call('/api/games?board=1&week=11');
  assert.equal(res.status, 200);
  assert.equal(res.body.games.length, 8);
  assert.equal(res.body.status.games_total, 7);
  assert.equal(res.body.games.find(g => g.is_monday).hidden, true);
  assert.equal(cell(res.body, 'Andy', 'tb-det').cls, 'pick-split');
  assert.equal(cell(res.body, 'Andy', 'tb-det').text, 'DET');
  assert.equal(cell(res.body, 'Martin', 'tb-det').cls, 'pick-split');
  assert.equal(cell(res.body, 'Martin', 'tb-det').text, 'TB');
  assert.equal(cell(res.body, 'Ghost', 'tb-det').cls, 'pick-split');
  assert.equal(cell(res.body, 'Andy', 'bal-car').cls, 'pick-split');
  assert.equal(cell(res.body, 'Martin', 'bal-car').cls, 'pick-split');
  assert.equal(cell(res.body, 'Andy', 'ind-hou').cls, 'pick-pending');
  assert.equal(cell(res.body, 'Martin', 'ind-hou').cls, 'pick-pending');
  assert.equal(cell(res.body, 'Ghost', 'ind-hou').cls, 'pick-pending');
  assert.equal(cell(res.body, 'Andy', 'sea-gb').cls, 'pick-pending');
  assert.equal(cell(res.body, 'Ghost', 'sea-gb').cls, 'pick-pending');
  assert.equal(cell(res.body, 'Andy', 'ne-nyj').cls, 'pick-pending');
  assert.equal(cell(res.body, 'Martin', 'ne-nyj'), undefined);
  assert.equal(cell(res.body, 'Andy', 'pit-cin').cls, 'pick-win');
  assert.equal(cell(res.body, 'Martin', 'pit-cin').cls, 'pick-loss');
  assert.equal(cell(res.body, 'Ghost', 'pit-cin').cls, 'pick-loss');
  assert.equal(cell(res.body, 'Andy', 'lac-bal').cls, 'pick-pending');
  assert.equal(cell(res.body, 'Martin', 'lac-bal').cls, 'pick-pending');
  assert.equal(cell(res.body, 'Andy', 'cin-was'), undefined);
  assert.equal(res.body.players.find(p => p.name === 'Andy').score, 1);

  const past = await call('/api/games?board=1&week=5');
  assert.equal(past.status, 200);
  assert.equal(cell(past.body, 'Andy', 'tb-dal').cls, 'pick-win');
  assert.equal(cell(past.body, 'Martin', 'tb-dal').cls, 'pick-loss');
  assert.equal(cell(past.body, 'Andy', 'sea-gb').cls, 'pick-split');
  assert.equal(cell(past.body, 'Martin', 'sea-gb').cls, 'pick-split');
});
