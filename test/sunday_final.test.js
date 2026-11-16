const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseEspn, withSundayFinal, SUNDAY_FINAL_GRACE_MS} = require('../lib/schedule');
const {publicEntries} = require('../lib/core');

function ev(iso, away, home, awayName, homeName) {
  return {
    date: iso,
    competitions: [{competitors: [
      {homeAway: 'away', team: {abbreviation: away, shortDisplayName: awayName || away}},
      {homeAway: 'home', team: {abbreviation: home, shortDisplayName: homeName || home}}
    ]}]
  };
}

function espnFor(wd, pending) {
  const espn = {};
  for (const g of wd.games) {
    const key = [g.away, g.home].slice().sort().join('|');
    espn[key] = pending && pending.has(g.matchup) ? {state: 'pre', done: false} : {state: 'post', done: true};
  }
  return espn;
}

function row(wd, mondayPicks) {
  const picks = {};
  wd.games.forEach(g => { picks[g.matchup] = (mondayPicks && mondayPicks[g.matchup]) || g.home_team; });
  return {name: 'Andy', tag: 'Comish', picks, tiebreaker: 41, paid: true, void: false};
}

// Same rule the board uses: a Monday column is hidden only while sunday_final is false.
function visibleMonday(view, picks) {
  return view.games.filter(g => g.is_monday).map(g => ({
    matchup: g.matchup,
    hidden: !!(g.is_monday && !view.sunday_final),
    pick: picks[g.matchup] || null
  }));
}

test('Monday night kickoff stays Monday in Pacific time when it is already Tuesday in UTC', () => {
  const wd = parseEspn({events: [
    ev('2026-11-16T01:20:00Z', 'PIT', 'CIN', 'Steelers', 'Bengals'),
    ev('2026-11-17T01:15:00Z', 'LAC', 'BAL', 'Chargers', 'Ravens')
  ]}, 10, 2026);
  const snf = wd.games.find(g => g.matchup === 'PIT @ CIN');
  const mnf = wd.games.find(g => g.matchup === 'LAC @ BAL');
  assert.equal(snf.is_monday, false);
  assert.ok(snf.kickoff_label.startsWith('Sun '));
  assert.equal(mnf.is_monday, true);
  assert.ok(mnf.kickoff_label.startsWith('Mon '));
  assert.equal(wd.games.find(g => g.is_tiebreaker).matchup, 'LAC @ BAL');
  assert.equal(wd.games.length, 2);
});

test('week 10 Monday pick shows once the other games are final', () => {
  const wd = parseEspn({events: [
    ev('2026-11-13T01:15:00Z', 'WAS', 'NYG', 'Commanders', 'Giants'),
    ev('2026-11-16T01:20:00Z', 'PIT', 'CIN', 'Steelers', 'Bengals'),
    ev('2026-11-17T01:15:00Z', 'LAC', 'BAL', 'Chargers', 'Ravens')
  ]}, 10, 2026);
  assert.equal(wd.sunday_final, false);
  const picks = {'LAC @ BAL': 'Ravens'};

  const sundayAfternoon = withSundayFinal(wd, {}, Date.parse('2026-11-15T20:00:00Z'));
  const hidden = publicEntries([row(wd, picks)], sundayAfternoon);
  assert.equal(sundayAfternoon.sunday_final, false);
  assert.equal(hidden[0].picks['LAC @ BAL'], undefined);
  assert.equal(hidden[0].tiebreaker, undefined);

  const mondayMorning = Date.parse('2026-11-16T09:06:34Z');
  const view = withSundayFinal(wd, espnFor(wd, new Set(['LAC @ BAL'])), mondayMorning);
  const shown = publicEntries([row(wd, picks)], view);
  assert.deepEqual(visibleMonday(view, shown[0].picks), [
    {matchup: 'LAC @ BAL', hidden: false, pick: 'Ravens'}
  ]);
  assert.equal(shown[0].tiebreaker, 41);
  assert.equal(shown[0].picks['PIT @ CIN'], 'Bengals');
});

test('a later week stays hidden until its own non-Monday games are final', () => {
  const wd = parseEspn({events: [
    ev('2026-12-06T18:00:00Z', 'KC', 'ATL'),
    ev('2026-12-08T01:15:00Z', 'CIN', 'WAS', 'Bengals', 'Commanders')
  ]}, 14, 2026);
  const now = Date.parse('2026-11-16T09:06:34Z');
  const view = withSundayFinal(wd, espnFor(wd, new Set(wd.games.map(g => g.matchup))), now);
  const rows = publicEntries([row(wd, {'CIN @ WAS': 'Commanders'})], view);
  assert.equal(view.sunday_final, false);
  assert.equal(rows[0].picks['CIN @ WAS'], undefined);
});

test('two Monday games both appear after the earlier slate is final, later one is the tiebreaker', () => {
  const wd = parseEspn({events: [
    ev('2026-12-06T18:00:00Z', 'KC', 'ATL', 'Chiefs', 'Falcons'),
    ev('2026-12-07T01:20:00Z', 'PIT', 'CIN', 'Steelers', 'Bengals'),
    ev('2026-12-07T21:00:00Z', 'DAL', 'PHI', 'Cowboys', 'Eagles'),
    ev('2026-12-08T01:15:00Z', 'LAC', 'BAL', 'Chargers', 'Ravens')
  ]}, 14, 2026);
  assert.deepEqual(wd.games.filter(g => g.is_monday).map(g => g.matchup), ['DAL @ PHI', 'LAC @ BAL']);
  assert.equal(wd.games.find(g => g.is_tiebreaker).matchup, 'LAC @ BAL');

  const picks = {'DAL @ PHI': 'Eagles', 'LAC @ BAL': 'Ravens'};
  const before = withSundayFinal(wd, null, Date.parse('2026-11-16T09:00:00Z'));
  const hidden = publicEntries([row(wd, picks)], before);
  assert.equal(hidden[0].picks['DAL @ PHI'], undefined);
  assert.equal(hidden[0].picks['LAC @ BAL'], undefined);

  const view = withSundayFinal(wd, espnFor(wd, new Set(['DAL @ PHI', 'LAC @ BAL'])), Date.parse('2026-12-07T20:00:00Z'));
  const shown = publicEntries([row(wd, picks)], view);
  assert.deepEqual(visibleMonday(view, shown[0].picks), [
    {matchup: 'DAL @ PHI', hidden: false, pick: 'Eagles'},
    {matchup: 'LAC @ BAL', hidden: false, pick: 'Ravens'}
  ]);
});

test('a Sunday game still in progress keeps Monday picks hidden past the grace window', () => {
  const wd = parseEspn({events: [
    ev('2026-11-16T01:20:00Z', 'PIT', 'CIN'),
    ev('2026-11-17T01:15:00Z', 'LAC', 'BAL')
  ]}, 10, 2026);
  const key = ['CIN', 'PIT'].sort().join('|');
  const now = Date.parse('2026-11-16T01:20:00Z') + SUNDAY_FINAL_GRACE_MS + 60 * 60 * 1000;
  const view = withSundayFinal(wd, {[key]: {state: 'in', done: false}}, now);
  assert.equal(view.sunday_final, false);
  assert.equal(publicEntries([row(wd, {'LAC @ BAL': 'Ravens'})], view)[0].picks['LAC @ BAL'], undefined);
});

test('with no scoreboard, Monday picks show 4h after the last non-Monday kickoff', () => {
  const wd = parseEspn({events: [
    ev('2026-11-16T01:20:00Z', 'PIT', 'CIN'),
    ev('2026-11-17T01:15:00Z', 'LAC', 'BAL')
  ]}, 10, 2026);
  const last = Date.parse('2026-11-16T01:20:00Z');
  assert.equal(withSundayFinal(wd, null, last + SUNDAY_FINAL_GRACE_MS - 1).sunday_final, false);
  const view = withSundayFinal(wd, null, last + SUNDAY_FINAL_GRACE_MS);
  const shown = publicEntries([row(wd, {'LAC @ BAL': 'Chargers'})], view);
  assert.equal(shown[0].picks['LAC @ BAL'], 'Chargers');
});

test('a stored sunday_final still reveals, and an unfinished earlier game does not', () => {
  const wd = parseEspn({events: [
    ev('2026-11-16T01:20:00Z', 'PIT', 'CIN'),
    ev('2026-11-17T01:15:00Z', 'LAC', 'BAL')
  ]}, 10, 2026);
  const forced = Object.assign({}, wd, {sunday_final: true});
  assert.equal(withSundayFinal(forced, null, Date.parse('2026-11-15T00:00:00Z')), forced);

  const key = ['CIN', 'PIT'].sort().join('|');
  const late = Date.parse('2026-11-16T01:20:00Z') + SUNDAY_FINAL_GRACE_MS + 60 * 60 * 1000;
  const waiting = withSundayFinal(wd, {[key]: {state: 'pre', done: false}}, late);
  assert.equal(waiting.sunday_final, false);
});
