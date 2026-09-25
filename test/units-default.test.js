// Startup units (app/js/jog.js restoreUnitsMode): a fresh install used to open in INCH-mode ("default to
// inches", inherited from OpenBuilds); the default is now mm. Only an explicitly saved "in" gives inch-mode;
// nothing saved, a saved "mm" and anything unrecognised give mm-mode. It is a display preference - firmware $13
// plays no part (CONTROL needs $13=0 and handles inches itself).
// The REAL restoreUnitsMode / mmMode / inMode run in a vm with a localStorage / jQuery fake.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const JOG = read('app/js/jog.js');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot find function ' + name);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1);
  return src.slice(start, end + 2);
}

// stored: the value localStorage returns for 'unitsMode' (undefined = nothing saved); throwOnRead: blocked storage
function boot(stored, opts = {}) {
  const env = { clicks: [], grids: [], storage: {} };
  if (stored !== undefined) env.storage.unitsMode = stored;
  const ctx = {
    unit: 'mm', jogdistXYZ: 10, xmin: 0, xmax: 100, ymin: 0, ymax: 100,
    localStorage: {
      getItem: (k) => { if (opts.throwOnRead) throw new Error('blocked'); return Object.prototype.hasOwnProperty.call(env.storage, k) ? env.storage[k] : null; },
      setItem: (k, v) => { env.storage[k] = String(v); },
    },
    $: (sel) => ({ html() {}, click() { env.clicks.push(sel); } }),
    redrawGrid: (...a) => env.grids.push(a),
  };
  vm.createContext(ctx);
  for (const n of ['restoreUnitsMode', 'mmMode', 'inMode']) vm.runInContext(extractFunction(JOG, n), ctx);
  vm.runInContext('restoreUnitsMode()', ctx);
  env.ctx = ctx;
  env.unit = () => vm.runInContext('unit', ctx);
  return env;
}

test('fresh install (nothing saved): mm-mode, the mm tab is selected, and "mm" is saved', () => {
  const e = boot(undefined);
  assert.equal(e.unit(), 'mm');
  assert.deepEqual(e.clicks, ['#mmMode']);
  assert.equal(e.storage.unitsMode, 'mm');
  assert.equal(e.grids.length, 1);
  assert.equal(e.grids[0][4], false, 'the grid is drawn in mm, not inches');
});

test('saved "in": stays inch-mode (an existing user\'s choice is not changed)', () => {
  const e = boot('in');
  assert.equal(e.unit(), 'in');
  assert.deepEqual(e.clicks, ['#inMode']);
  assert.equal(e.storage.unitsMode, 'in');
});

test('saved "mm": stays mm-mode', () => {
  const e = boot('mm');
  assert.equal(e.unit(), 'mm');
  assert.deepEqual(e.clicks, ['#mmMode']);
  assert.equal(e.storage.unitsMode, 'mm');
});

test('an unrecognised saved value (garbage, wrong case, empty, number-like) falls to mm and is repaired', () => {
  for (const bad of ['xyz', 'IN', 'MM', 'inch', '', '0', 'null', ' in']) {
    const e = boot(bad);
    assert.equal(e.unit(), 'mm', JSON.stringify(bad));
    assert.deepEqual(e.clicks, ['#mmMode'], JSON.stringify(bad) + ': tab and unit agree');
    assert.equal(e.storage.unitsMode, 'mm', JSON.stringify(bad) + ' is repaired');
  }
});

test('unreadable storage (throws) still gives mm-mode instead of breaking startup', () => {
  const e = boot(undefined, { throwOnRead: true });
  assert.equal(e.unit(), 'mm');
  assert.deepEqual(e.clicks, ['#mmMode']);
});

test('jog distances follow the default: 10 stays 10 mm on a fresh install (not converted to 2.54)', () => {
  const e = boot(undefined);
  assert.equal(e.ctx.jogdistXYZ, 10);
});

test('structure: the ready handler calls restoreUnitsMode; no "default to inches" and no $13 in the units code', () => {
  assert.match(JOG, /\$\(document\)\.ready\(function\(\) \{[^]*?\n  restoreUnitsMode\(\);/);
  assert.ok(!JOG.includes('// default to inches'), 'the old inch default comment/branch is gone');
  const units = extractFunction(JOG, 'restoreUnitsMode') + extractFunction(JOG, 'mmMode') + extractFunction(JOG, 'inMode');
  assert.ok(!/\$13|grblParams/.test(units), 'firmware settings are not involved');
  // the phone jog page loads the same jog.js
  assert.match(read('app/jog/index.html'), /<script type="text\/javascript" src="\.\.\/js\/jog\.js"><\/script>/);
});
