const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DESC = "Weekly NFL pick'em · $10 to play · pick every game, locks at kickoff";

function head(file) {
  const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
  const end = html.indexOf('<style');
  return end === -1 ? html.slice(0, 2500) : html.slice(0, end);
}
function attr(headHtml, re) {
  const m = re.exec(headHtml);
  assert.ok(m, re.source);
  return m[1];
}

test('link previews do not name a week or stale standings', () => {
  const home = head('index.html');
  assert.equal(attr(home, /<title>([^<]*)<\/title>/), 'Fam Bash Pickems');
  assert.equal(attr(home, /name="description" content="([^"]*)"/), DESC);
  assert.equal(attr(home, /property="og:title" content="([^"]*)"/), '🦃 Fam Bash Pickems');
  assert.equal(attr(home, /property="og:description" content="([^"]*)"/), DESC);
  assert.equal(attr(home, /name="twitter:title" content="([^"]*)"/), 'Fam Bash Pickems');
  assert.equal(attr(home, /name="twitter:description" content="([^"]*)"/), DESC);
  assert.match(home, /og-image\.png/);

  const submit = head('submit.html');
  assert.equal(attr(submit, /<title>([^<]*)<\/title>/), 'Make your picks · Fam Bash Pickems');
  assert.equal(attr(submit, /name="description" content="([^"]*)"/), DESC);
  assert.equal(attr(submit, /property="og:title" content="([^"]*)"/), 'Make your picks · Fam Bash Pickems');
  assert.equal(attr(submit, /property="og:description" content="([^"]*)"/), DESC);
  assert.equal(attr(submit, /name="twitter:title" content="([^"]*)"/), 'Make your picks · Fam Bash Pickems');
  assert.equal(attr(submit, /name="twitter:description" content="([^"]*)"/), DESC);

  for (const file of ['week5.html', 'week6.html', 'week7.html']) {
    const h = head(file);
    assert.equal(attr(h, /<title>([^<]*)<\/title>/), 'Fam Bash Pickems', file);
    assert.equal(attr(h, /property="og:title" content="([^"]*)"/), '🦃 Fam Bash Pickems', file);
    assert.equal(attr(h, /name="twitter:title" content="([^"]*)"/), 'Fam Bash Pickems', file);
    assert.equal(attr(h, /name="description" content="([^"]*)"/), DESC, file);
    assert.doesNotMatch(h, /Week \d/, file);
  }
});
