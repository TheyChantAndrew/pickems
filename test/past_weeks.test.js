const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Week 9 is a bye in the viewer, and a failed refresh does not invent an empty Week 9', () => {
  const live = fs.readFileSync(path.join(__dirname, '../public/live.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(live, /BYE_WEEKS = \{9: "BYE WEEK — the whole league was on bye"\}/);
  assert.match(live, /data-bye/);
  assert.match(live, /Past results\. Picks are closed\./);
  assert.doesNotMatch(live, /week: 9, submit_open: false, picks_locked: true/);
  assert.match(html, /id="weeknav"/);
  assert.match(html, /id="week-prev"/);
  assert.match(html, /id="week-next"/);
  assert.match(live, /weekFromLocation/);
  assert.match(live, /Full board not available for this week\./);
  assert.match(live, /hallRowFor/);
  assert.match(html, /data-wk="10"/);
  assert.match(html, /Nick \(Cool Cats\)/);
  assert.match(html, /12\/14<span class="hnote">won outright<\/span>/);
  assert.match(html, /\$60<span class="dim">6 entries<\/span>/);
  assert.match(html, /Total paid out<\/td><td class="num cash">\$890/);
  assert.match(live, /setAttribute\("data-wk", "10"\)/);
  assert.match(live, /Number\(marked\[i\]\.getAttribute\("data-wk"\)\) < Number\(wk\)/);
});
