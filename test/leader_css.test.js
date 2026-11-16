const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('leader highlight does not paint pick cells, including the Thanksgiving theme', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(css, /tr\.lead td:not\(\[class\*="pick-"\]\)\{background:#3b2416\}/);
  assert.match(css, /html\.theme-thanksgiving tr\.lead td:not\(\[class\*="pick-"\]\)\{background:#40260f\}/);
  assert.match(css, /\.picks tr\.lead td\.who\{background:#3b2416\}/);
  assert.match(css, /html\.theme-thanksgiving \.picks tr\.lead td\.who\{background:#40260f\}/);
  assert.doesNotMatch(css, /html\.theme-thanksgiving tr\.lead td\{background:#40260f\}/);
});
