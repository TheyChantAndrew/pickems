const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {JSDOM, VirtualConsole} = require('jsdom');

function week11() {
  const games = [];
  for (let i = 0; i < 13; i++) {
    const away = 'A' + i, home = 'H' + i;
    games.push({
      matchup: away + ' @ ' + home, away, home, away_team: 'Away ' + i, home_team: 'Home ' + i,
      kickoff: '2026-11-30T18:00:00Z', kickoff_label: 'Sun 11/29 10:00AM PT', is_monday: i === 12,
      locked: false, lock_at: '2026-11-30T18:00:00Z'
    });
  }
  return {
    ok: true, week: 11, current_week: 11, open: true, locked: false,
    now: '2026-11-18T03:20:00.000Z', lock_at: games[0].lock_at,
    tiebreaker_game: games[12].matchup, tiebreaker_lock_at: games[12].lock_at, tiebreaker_locked: false,
    games
  };
}

test('baked Week 9 submit page adopts an open Week 11 slate', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/submit.html'), 'utf8');
  assert.match(html, /"week":9/);
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e)));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://fambash-pickems.vercel.app/submit',
    virtualConsole: vc,
    beforeParse(window) {
      window.setInterval = () => 0;
      window.fetch = (url) => {
        if (String(url).includes('/api/games')) return Promise.resolve({ok: true, json: async () => week11()});
        return Promise.resolve({ok: true, json: async () => ({ok: false})});
      };
    }
  });
  const doc = dom.window.document;
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (doc.querySelectorAll('#games .game').length === 13 && /Week 11/.test(doc.querySelector('header h1').textContent)) {
        clearInterval(timer); resolve();
      } else if (Date.now() - start > 2000) {
        clearInterval(timer);
        reject(new Error('timed out with ' + doc.querySelectorAll('#games .game').length + ' games; ' + errors.join('\n')));
      }
    }, 15);
  });
  assert.deepEqual(errors, []);
  assert.equal(doc.querySelectorAll('#games .game').length, 13);
  assert.equal(doc.querySelectorAll('#lockedgames .game').length, 0);
  assert.equal(doc.querySelector('#tot').textContent, '13');
  const note = doc.querySelector('#topnote');
  assert.equal(/closed/i.test(note.className + note.textContent), false);
  assert.equal(/Week 9/.test(note.textContent), false);
  assert.equal([...doc.querySelectorAll('#games .team')].some(b => b.disabled), false);
  assert.equal(doc.querySelector('#go').disabled, false);
  dom.window.close();
});

test('the public board rebuilds its tables instead of keeping a second stale list', () => {
  const live = fs.readFileSync(path.join(__dirname, '../public/live.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(live, /function rebuildPicks/);
  assert.match(live, /clearRows\(tbody\)/);
  assert.doesNotMatch(live, /byM\[/);
  assert.match(index, /if\(!th\)return/);
});
