// Tool-change wizard, Tahap 1b-ii, Commit 2: send the Fixed Tool Sensor
// fields (sensor X/Y/Z, first-tool behaviour) with every real job POST.
// Same structural-scan pattern as test/toolchange-mode-formdata.test.js
// (Tahap 1b-i Commit 2): count the appends against the count of '/runjob'
// POSTs per file, not a fixed list of call sites, so a future 4th site (or a
// future branch in an existing one) that forgets the helper call is caught.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const TOOLCHANGE = read('app/js/toolchange.js');

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true })) {
    const rel = dir + '/' + entry.name;
    if (entry.isDirectory()) out.push(...jsFiles(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}
const count = (src, re) => (src.match(re) || []).length;

test("structural: in every file that POSTs to '/runjob', the number of appendToolSensorFields(formData) calls matches the number of /runjob POSTs", () => {
  const files = [...jsFiles('app/js'), ...jsFiles('app/wizards')];
  const filesWithRunjob = files.filter((rel) => read(rel).includes("'/runjob'"));

  assert.deepEqual(filesWithRunjob.sort(), ['app/js/main.js', 'app/wizards/resume/resume.js']);

  let total = 0;
  for (const rel of filesWithRunjob) {
    const src = read(rel);
    const runjobCount = count(src, /'\/runjob'/g);
    const callCount = count(src, /appendToolSensorFields\(formData\)/g);
    assert.equal(callCount, runjobCount, rel + ': ' + runjobCount + ' /runjob POST(s) but ' + callCount + ' appendToolSensorFields call(s)');
    total += runjobCount;
  }
  assert.equal(total, 3, 'expected the 3 known /runjob call sites in total');
});

// --------------------------------------------------------------------------
// appendToolSensorFields() itself, executed for real.
// --------------------------------------------------------------------------

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot find function ' + name);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1);
  return src.slice(start, end + 2);
}

function boot(storage) {
  const env = { storage: storage || {} };
  const ctx = {
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(env.storage, k) ? env.storage[k] : null),
      setItem: (k, v) => { env.storage[k] = String(v); },
    },
    FormData: class { constructor() { this.fields = []; } append(k, v) { this.fields.push([k, v]); } },
  };
  vm.createContext(ctx);
  const VARS = TOOLCHANGE.match(/var TOOLSENSOR_FIRST_BEHAVIOURS = \[[^\]]*\];\n/)[0] +
    TOOLCHANGE.match(/var TOOLSENSOR_FIRST_BEHAVIOUR_DEFAULT = [^\n]*\n/)[0];
  vm.runInContext(
    VARS + ['getToolSensorLocation', 'getToolSensorFirstBehaviour', 'appendToolSensorFields'].map((n) => extractFunction(TOOLCHANGE, n)).join('\n'),
    ctx
  );
  env.ctx = ctx;
  return env;
}

test('appendToolSensorFields(): no location saved - empty strings for X/Y/Z, NOT "0" (0,0,0 would be a real, dangerous location)', () => {
  const e = boot({});
  const fd = new e.ctx.FormData();
  e.ctx.appendToolSensorFields(fd);
  assert.deepEqual(fd.fields.filter(([k]) => k.startsWith('toolSensor')).map(([k, v]) => [k, v]), [
    ['toolSensorX', ''],
    ['toolSensorY', ''],
    ['toolSensorZ', ''],
    ['toolSensorFirstBehaviour', 'always-wizard'],
  ]);
});

test('appendToolSensorFields(): a saved location is sent as strings', () => {
  const e = boot({ toolSensorLocation: JSON.stringify({ x: 10.5, y: -2, z: 0 }), toolSensorFirstBehaviour: 'always-probe' });
  const fd = new e.ctx.FormData();
  e.ctx.appendToolSensorFields(fd);
  const byKey = Object.fromEntries(fd.fields);
  assert.equal(byKey.toolSensorX, '10.5');
  assert.equal(byKey.toolSensorY, '-2');
  assert.equal(byKey.toolSensorZ, '0');
  assert.equal(byKey.toolSensorFirstBehaviour, 'always-probe');
});

test('appendToolSensorFields(): a corrupt saved location falls back to empty strings, same as none saved', () => {
  const e = boot({ toolSensorLocation: '{"x":"not a number"}' });
  const fd = new e.ctx.FormData();
  e.ctx.appendToolSensorFields(fd);
  const byKey = Object.fromEntries(fd.fields);
  assert.equal(byKey.toolSensorX, '');
  assert.equal(byKey.toolSensorY, '');
  assert.equal(byKey.toolSensorZ, '');
});

test('appendToolSensorFields(): exactly 4 fields, always, regardless of what is saved', () => {
  for (const storage of [{}, { toolSensorLocation: JSON.stringify({ x: 1, y: 1, z: 1 }) }]) {
    const e = boot(storage);
    const fd = new e.ctx.FormData();
    e.ctx.appendToolSensorFields(fd);
    assert.equal(fd.fields.length, 4, JSON.stringify(storage));
  }
});
