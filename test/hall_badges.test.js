const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {JSDOM, VirtualConsole} = require('jsdom');

function badges(doc) {
  const out = {};
  doc.querySelectorAll('.hall tr').forEach(tr => {
    const nm = tr.querySelector('b.nm');
    if (!nm) return;
    const name = nm.textContent.trim();
    const badge = tr.querySelector('.xw');
    (out[name] = out[name] || []).push(badge ? badge.textContent : '');
  });
  return out;
}

test('Hall badges count each champion, including Mario three times', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e)));
  const dom = new JSDOM(html, {url: 'https://fambash-pickems.vercel.app/', virtualConsole: vc, runScripts: 'outside-only'});
  const {window} = dom;
  assert.deepEqual(badges(window.document).Mario, ['×3', '×3', '×3']);
  assert.deepEqual(badges(window.document).Andy, ['×2', '×2']);
  for (const name of ['Nick', 'GC', 'MRod', 'Chantal']) assert.deepEqual(badges(window.document)[name], ['']);

  window.document.querySelectorAll('.hall .xw').forEach(el => el.remove());
  window.fetch = () => Promise.resolve({ok: true, json: async () => ({status: {text: {}}, players: [], games: [], week: 11, current_week: 11})});
  window.setInterval = () => 0;
  window.eval(fs.readFileSync(path.join(__dirname, '../public/live.js'), 'utf8'));
  window.PickemsLive.apply({status: {text: {}}, players: [], games: [], week: 11, current_week: 11});

  const after = badges(window.document);
  assert.deepEqual(after.Mario, ['×3', '×3', '×3']);
  assert.deepEqual(after.Andy, ['×2', '×2']);
  for (const name of ['Nick', 'GC', 'MRod', 'Chantal']) assert.deepEqual(after[name], ['']);
  assert.deepEqual(after['BYE WEEK'], ['']);
  assert.deepEqual(errors, []);
  dom.window.close();
});
