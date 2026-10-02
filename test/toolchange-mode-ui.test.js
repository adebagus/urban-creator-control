// Tool-change wizard, Tahap 1b-i, Commit 1: the client-side mode picker
// (app/index.html's #toolChangeMode dropdown, app/js/toolchange.js's
// setToolChangeMode()/restoreToolChangeMode()). Same persistence pattern as
// restoreUnitsMode() in app/js/jog.js (see test/units-default.test.js) -
// localStorage, per-installation, "repair on read" for anything unrecognised,
// safe default ('pause', the only validated/shipped behaviour so far).
// The REAL functions run in a vm with a localStorage/jQuery fake.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const TOOLCHANGE = read('app/js/toolchange.js');
const JOG = read('app/js/jog.js');
const INDEX_HTML = read('app/index.html');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot find function ' + name);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1);
  return src.slice(start, end + 2);
}
const VAR_DECL = TOOLCHANGE.match(/var toolChangeMode = 'pause';\n/)[0];

// stored: the value localStorage returns for 'toolChangeMode' (undefined = nothing saved)
function boot(stored, opts = {}) {
  const env = { storage: {}, selectVal: null };
  if (stored !== undefined) env.storage.toolChangeMode = stored;
  const ctx = {
    localStorage: {
      getItem: (k) => { if (opts.throwOnRead) throw new Error('blocked'); return Object.prototype.hasOwnProperty.call(env.storage, k) ? env.storage[k] : null; },
      setItem: (k, v) => { if (opts.throwOnWrite) throw new Error('blocked'); env.storage[k] = String(v); },
    },
    $: (sel) => ({ val: (v) => { if (sel === '#toolChangeMode') { if (v === undefined) return env.selectVal; env.selectVal = v; } } }),
  };
  vm.createContext(ctx);
  vm.runInContext(VAR_DECL + ['setToolChangeMode', 'restoreToolChangeMode'].map((n) => extractFunction(TOOLCHANGE, n)).join('\n'), ctx);
  vm.runInContext('restoreToolChangeMode()', ctx);
  env.ctx = ctx;
  env.mode = () => vm.runInContext('toolChangeMode', ctx);
  return env;
}

test('fresh install (nothing saved): defaults to "pause", the dropdown reflects it, and "pause" is saved', () => {
  const e = boot(undefined);
  assert.equal(e.mode(), 'pause');
  assert.equal(e.selectVal, 'pause');
  assert.equal(e.storage.toolChangeMode, 'pause');
});

test('saved "ignore": stays ignore (an existing choice is not changed)', () => {
  const e = boot('ignore');
  assert.equal(e.mode(), 'ignore');
  assert.equal(e.selectVal, 'ignore');
  assert.equal(e.storage.toolChangeMode, 'ignore');
});

test('saved "pause": stays pause', () => {
  const e = boot('pause');
  assert.equal(e.mode(), 'pause');
  assert.equal(e.storage.toolChangeMode, 'pause');
});

test('an unrecognised saved value (garbage, wrong case, empty, number-like) falls back to "pause" and is repaired', () => {
  for (const bad of ['xyz', 'IGNORE', 'Ignore', '', '0', 'null', ' ignore', 'fixedToolSensor']) {
    const e = boot(bad);
    assert.equal(e.mode(), 'pause', JSON.stringify(bad));
    assert.equal(e.selectVal, 'pause', JSON.stringify(bad));
    assert.equal(e.storage.toolChangeMode, 'pause', JSON.stringify(bad) + ' is repaired');
  }
});

test('unreadable storage (throws on read) still gives "pause" instead of breaking startup', () => {
  const e = boot(undefined, { throwOnRead: true });
  assert.equal(e.mode(), 'pause');
  assert.equal(e.selectVal, 'pause');
});

test('a storage write failure (quota, private mode) does not throw and the in-memory/UI mode still updates', () => {
  const e = boot('ignore', { throwOnWrite: true });
  assert.equal(e.mode(), 'ignore', 'still reflects the saved value in memory/UI this session');
});

test('setToolChangeMode(): an unrecognised value passed directly (not via storage) also falls back to "pause"', () => {
  const e = boot(undefined);
  vm.runInContext("setToolChangeMode('bogus')", e.ctx);
  assert.equal(e.mode(), 'pause');
  assert.equal(e.storage.toolChangeMode, 'pause');
  vm.runInContext("setToolChangeMode('ignore')", e.ctx);
  assert.equal(e.mode(), 'ignore');
  assert.equal(e.storage.toolChangeMode, 'ignore');
});

// --------------------------------------------------------------------------- structure

test('structure: the dropdown exists with exactly "pause" (selected) and "ignore", wired to setToolChangeMode()', () => {
  const start = INDEX_HTML.indexOf('<select data-role="select" data-filter="false" id="toolChangeMode"');
  assert.notEqual(start, -1, 'cannot find the #toolChangeMode dropdown');
  const end = INDEX_HTML.indexOf('</select>', start);
  const markup = INDEX_HTML.slice(start, end);
  assert.match(markup, /onchange="setToolChangeMode\(this\.value\)"/);
  const options = [...markup.matchAll(/<option value="([^"]+)"([^>]*)>/g)].map((m) => [m[1], /selected/.test(m[2])]);
  assert.deepEqual(options, [['pause', true], ['ignore', false]]);
});

test('structure: the ready handler calls restoreToolChangeMode() alongside restoreUnitsMode()', () => {
  assert.match(JOG, /restoreUnitsMode\(\);\n\s*restoreToolChangeMode\(\);/);
});

test('structure: the dropdown sits right after the ATC/TLS/TCZ row, inside the same column cell (not a separate Settings tab)', () => {
  const atcRowEnd = INDEX_HTML.indexOf('</div>', INDEX_HTML.indexOf('id="atcTlsTczRow"'));
  const dropdownStart = INDEX_HTML.indexOf('id="toolChangeModeRow"');
  assert.ok(dropdownStart > atcRowEnd && dropdownStart - atcRowEnd < 600, 'kept close together, same panel');
});
