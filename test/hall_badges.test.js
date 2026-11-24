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
  const doc = window.document;
  const wk11 = doc.querySelector('.hall tr[data-wk="11"]');
  assert.ok(wk11);
  assert.equal(wk11.querySelector('.wk').textContent, 'Wk 11');
  assert.equal(wk11.querySelector('b.nm').textContent, 'MRod');
  assert.equal(wk11.querySelector('.tag').textContent, 'The one kidney man');
  assert.equal(wk11.querySelector('.hnote').textContent, 'won outright');
  assert.match(wk11.textContent, /10\/13/);
  assert.match(wk11.textContent, /\$60/);
  assert.match(wk11.textContent, /7 entries/);
  assert.equal(doc.querySelector('.hall tr[data-wk="11"]').nextElementSibling.getAttribute('data-wk'), '10');
  const wk3 = [...doc.querySelectorAll('.hall tr')].find(tr => tr.querySelector('.wk') && tr.querySelector('.wk').textContent === 'Wk 3');
  assert.equal(wk3.querySelector('.tag').textContent, 'FAM BASH');
  assert.equal(doc.querySelector('.hall tr.tot .cash').textContent, '$950');
  assert.deepEqual(badges(doc).Mario, ['×3', '×3', '×3']);
  assert.deepEqual(badges(doc).Andy, ['×2', '×2']);
  assert.deepEqual(badges(doc).MRod, ['×2', '×2']);
  for (const name of ['Nick', 'GC', 'Chantal']) assert.deepEqual(badges(doc)[name], ['']);

  wk11.remove();
  doc.querySelector('.hall tr.tot .cash').textContent = '$890';
  doc.querySelectorAll('.hall .xw').forEach(el => el.remove());
  window.fetch = () => Promise.resolve({ok: true, json: async () => ({status: {text: {}}, players: [], games: [], week: 11, current_week: 11})});
  window.setInterval = () => 0;
  window.eval(fs.readFileSync(path.join(__dirname, '../public/live.js'), 'utf8'));
  window.PickemsLive.apply({status: {text: {}}, players: [], games: [], week: 11, current_week: 11});

  const added = doc.querySelector('.hall tr[data-wk="11"]');
  assert.ok(added);
  assert.equal(added.nextElementSibling.getAttribute('data-wk'), '10');
  assert.equal(added.querySelector('.tag').textContent, 'The one kidney man');
  assert.equal(wk3.querySelector('.tag').textContent, 'FAM BASH');
  assert.equal(doc.querySelector('.hall tr.tot .cash').textContent, '$950');
  const after = badges(doc);
  assert.deepEqual(after.Mario, ['×3', '×3', '×3']);
  assert.deepEqual(after.Andy, ['×2', '×2']);
  assert.deepEqual(after.MRod, ['×2', '×2']);
  for (const name of ['Nick', 'GC', 'Chantal']) assert.deepEqual(after[name], ['']);
  assert.deepEqual(after['BYE WEEK'], ['']);
  assert.deepEqual(errors, []);
  dom.window.close();
});
