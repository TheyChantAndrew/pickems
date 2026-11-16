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
  assert.match(live, /Detailed board isn't available for Week /);
  assert.match(live, /hallRowFor/);
});
