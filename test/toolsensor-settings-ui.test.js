// Tool-change wizard, Tahap 1b-ii, Commit 1: Fixed Tool Sensor settings
// (sensor location X/Y/Z, "first tool behaviour"). Entirely client-side
// storage - nothing here is read by the server yet.
//
// $20 (Soft Limits) is enforced client-side against the live grblParams the
// app already parses from "$$" - per the user's explicit choice (Commit 5.3
// of the investigation): the server stays stateless about individual $
// values, consistent with the rest of this app's architecture. This is
// ENFORCED (the capture button is actually disabled), not just documented
// in a tooltip.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const TOOLCHANGE = read('app/js/toolchange.js');
const INDEX_HTML = read('app/index.html');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot find function ' + name);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1);
  return src.slice(start, end + 2);
}
const VARS = [
  TOOLCHANGE.match(/var TOOLSENSOR_FIRST_BEHAVIOURS = \[[^\]]*\];\n/)[0],
  TOOLCHANGE.match(/var TOOLSENSOR_FIRST_BEHAVIOUR_DEFAULT = [^\n]*\n/)[0],
].join('');
const FUNCS = ['isSoftLimitsEnabledForToolSensor', 'getToolSensorLocation', 'setToolSensorLocation',
  'getToolSensorFirstBehaviour', 'setToolSensorFirstBehaviour', 'captureToolSensorLocation',
  'toolSensorLocationText', 'showToolSensorSettings'];

// {x,y,z} objects returned by code executed INSIDE the vm sandbox come from a
// different Object.prototype than this file's own object literals -
// assert.deepEqual (strict) treats that as unequal even when every property
// matches (see test/toolchange-detection.test.js's Tahap 1a Commit 1 for the
// same lesson learned there), so these are compared field-by-field instead.
function assertLoc(actual, expected, msg) {
  assert.ok(actual, msg || 'expected a location object, got ' + actual);
  assert.equal(actual.x, expected.x, (msg || '') + ' x');
  assert.equal(actual.y, expected.y, (msg || '') + ' y');
  assert.equal(actual.z, expected.z, (msg || '') + ' z');
}

// opts: { grblParams, laststatus, storage }
function boot(opts = {}) {
  const env = { storage: opts.storage || {}, dialogs: [], clicks: {}, changes: {} };
  const ctx = {
    grblParams: 'grblParams' in opts ? opts.grblParams : { $20: 1 },
    laststatus: 'laststatus' in opts ? opts.laststatus : { machine: { position: { work: { x: 1, y: 2, z: 3 }, offset: { x: 0, y: 0, z: 0 } } } },
    localStorage: {
      getItem: (k) => { if (opts.throwOnRead) throw new Error('blocked'); return Object.prototype.hasOwnProperty.call(env.storage, k) ? env.storage[k] : null; },
      setItem: (k, v) => { if (opts.throwOnWrite) throw new Error('blocked'); env.storage[k] = String(v); },
    },
    Metro: { dialog: { create: (o) => { env.dialogs.push(o); return {}; } } },
    $: (sel) => ({
      html(v) { env.clicks[sel + '.html'] = v; return this; },
      on(ev, fn) { (env.changes[sel] = env.changes[sel] || {})[ev] = fn; return this; },
    }),
  };
  vm.createContext(ctx);
  vm.runInContext(VARS + FUNCS.map((n) => extractFunction(TOOLCHANGE, n)).join('\n'), ctx);
  env.ctx = ctx;
  return env;
}

// --------------------------------------------------------------------------- $20 enforcement

test('isSoftLimitsEnabledForToolSensor(): true only when grblParams.$20 is exactly 1', () => {
  assert.equal(boot({ grblParams: { $20: 1 } }).ctx.isSoftLimitsEnabledForToolSensor(), true);
  assert.equal(boot({ grblParams: { $20: '1' } }).ctx.isSoftLimitsEnabledForToolSensor(), true, 'grblParams values are often strings from the $$ parser');
  assert.equal(boot({ grblParams: { $20: 0 } }).ctx.isSoftLimitsEnabledForToolSensor(), false);
  assert.equal(boot({ grblParams: {} }).ctx.isSoftLimitsEnabledForToolSensor(), false, 'not yet connected / never read');
  assert.equal(boot({ grblParams: undefined }).ctx.isSoftLimitsEnabledForToolSensor(), false);
});

test('captureToolSensorLocation(): REFUSES (returns null, saves nothing) when Soft Limits is off - enforced, not just documented', () => {
  const e = boot({ grblParams: { $20: 0 } });
  const result = e.ctx.captureToolSensorLocation();
  assert.equal(result, null);
  assert.equal(e.storage.toolSensorLocation, undefined, 'nothing was saved');
});

test('captureToolSensorLocation(): with Soft Limits on, captures MACHINE coordinates (work + offset), not work coordinates alone', () => {
  const e = boot({
    grblParams: { $20: 1 },
    laststatus: { machine: { position: { work: { x: 10, y: 20, z: -5 }, offset: { x: 0.1, y: 0.2, z: 0.3 } } } },
  });
  const loc = e.ctx.captureToolSensorLocation();
  assertLoc(loc, { x: 10.1, y: 20.2, z: -4.7 });
  assert.equal(e.storage.toolSensorLocation, JSON.stringify({ x: 10.1, y: 20.2, z: -4.7 }));
});

test('captureToolSensorLocation(): no live status yet (never connected) refuses safely, does not throw', () => {
  const e = boot({ grblParams: { $20: 1 }, laststatus: undefined });
  assert.doesNotThrow(() => e.ctx.captureToolSensorLocation());
  assert.equal(e.ctx.captureToolSensorLocation(), null);
});

// --------------------------------------------------------------------------- getToolSensorLocation()

test('getToolSensorLocation(): null when nothing saved, or the saved value is malformed/corrupt', () => {
  for (const bad of [undefined, '', 'not json', '{"x":1}', '{"x":"a","y":1,"z":1}', '{"x":NaN,"y":1,"z":1}', 'null', '42']) {
    const e = boot({ storage: bad === undefined ? {} : { toolSensorLocation: bad } });
    assert.equal(e.ctx.getToolSensorLocation(), null, JSON.stringify(bad));
  }
});

test('getToolSensorLocation(): returns the saved value when well-formed', () => {
  const e = boot({ storage: { toolSensorLocation: JSON.stringify({ x: 1.5, y: -2.25, z: 0 }) } });
  assertLoc(e.ctx.getToolSensorLocation(), { x: 1.5, y: -2.25, z: 0 });
});

test('getToolSensorLocation(): unreadable storage never throws', () => {
  const e = boot({ throwOnRead: true });
  assert.doesNotThrow(() => e.ctx.getToolSensorLocation());
  assert.equal(e.ctx.getToolSensorLocation(), null);
});

// --------------------------------------------------------------------------- first-tool behaviour

test('getToolSensorFirstBehaviour(): defaults to "always-wizard" when nothing saved or unrecognised', () => {
  for (const bad of [undefined, 'xyz', '', 'Always-Wizard']) {
    const e = boot({ storage: bad === undefined ? {} : { toolSensorFirstBehaviour: bad } });
    assert.equal(e.ctx.getToolSensorFirstBehaviour(), 'always-wizard', JSON.stringify(bad));
  }
});

test('getToolSensorFirstBehaviour(): a valid saved value is kept', () => {
  for (const v of ['always-wizard', 'always-probe', 'prompt']) {
    const e = boot({ storage: { toolSensorFirstBehaviour: v } });
    assert.equal(e.ctx.getToolSensorFirstBehaviour(), v);
  }
});

test('setToolSensorFirstBehaviour(): repairs an unrecognised value to the default, returns what was actually saved', () => {
  const e = boot();
  assert.equal(e.ctx.setToolSensorFirstBehaviour('bogus'), 'always-wizard');
  assert.equal(e.storage.toolSensorFirstBehaviour, 'always-wizard');
  assert.equal(e.ctx.setToolSensorFirstBehaviour('always-probe'), 'always-probe');
  assert.equal(e.storage.toolSensorFirstBehaviour, 'always-probe');
});

// --------------------------------------------------------------------------- the dialog itself

test('showToolSensorSettings(): with Soft Limits ON, the capture button has no "disabled" attribute', () => {
  const e = boot({ grblParams: { $20: 1 } });
  e.ctx.showToolSensorSettings();
  assert.equal(e.dialogs.length, 1);
  assert.ok(!/id="captureToolSensorBtn"[^>]*disabled/.test(e.dialogs[0].content), e.dialogs[0].content);
});

test('showToolSensorSettings(): with Soft Limits OFF, the capture button IS disabled and a warning is shown', () => {
  const e = boot({ grblParams: { $20: 0 } });
  e.ctx.showToolSensorSettings();
  assert.match(e.dialogs[0].content, /id="captureToolSensorBtn"[^>]*disabled/);
  assert.match(e.dialogs[0].content, /Aktifkan Soft Limits \(\$20\)/);
});

test('showToolSensorSettings(): shows "Belum diatur / Not set" when no location is saved', () => {
  const e = boot({ storage: {} });
  e.ctx.showToolSensorSettings();
  assert.match(e.dialogs[0].content, /Belum diatur \/ Not set/);
});

test('showToolSensorSettings(): shows the saved X/Y/Z when one exists', () => {
  const e = boot({ storage: { toolSensorLocation: JSON.stringify({ x: 1, y: 2, z: 3 }) } });
  e.ctx.showToolSensorSettings();
  assert.match(e.dialogs[0].content, /X1 Y2 Z3/);
});

test('showToolSensorSettings(): the first-tool-behaviour select has exactly the 3 options, the saved one marked selected', () => {
  const e = boot({ storage: { toolSensorFirstBehaviour: 'always-probe' } });
  e.ctx.showToolSensorSettings();
  const html = e.dialogs[0].content;
  const options = [...html.matchAll(/<option value="([^"]+)"( selected)?>/g)].map((m) => [m[1], !!m[2]]);
  assert.deepEqual(options, [['always-wizard', false], ['always-probe', true], ['prompt', false]]);
});

test('showToolSensorSettings(): clicking the capture button updates the displayed text live', () => {
  const e = boot({ grblParams: { $20: 1 }, laststatus: { machine: { position: { work: { x: 5, y: 5, z: 5 }, offset: { x: 0, y: 0, z: 0 } } } } });
  e.ctx.showToolSensorSettings();
  assert.ok(e.changes['#captureToolSensorBtn'] && e.changes['#captureToolSensorBtn'].click, 'a click handler was registered');
  e.changes['#captureToolSensorBtn'].click();
  assert.equal(e.clicks['#toolSensorLocationText.html'], 'X5 Y5 Z5');
  assert.equal(e.storage.toolSensorLocation, JSON.stringify({ x: 5, y: 5, z: 5 }));
});

test('showToolSensorSettings(): changing the first-tool-behaviour select persists it', () => {
  const e = boot();
  e.ctx.showToolSensorSettings();
  assert.ok(e.changes['#toolSensorFirstBehaviourSelect'] && e.changes['#toolSensorFirstBehaviourSelect'].change);
  e.changes['#toolSensorFirstBehaviourSelect'].change.call({ value: 'prompt' });
  assert.equal(e.storage.toolSensorFirstBehaviour, 'prompt');
});

test('showToolSensorSettings(): only one action, "Tutup / Close" - nothing else can be done from this dialog', () => {
  const e = boot();
  e.ctx.showToolSensorSettings();
  assert.equal(e.dialogs[0].actions.length, 1);
  assert.equal(e.dialogs[0].actions[0].caption, 'Tutup / Close');
});

// --------------------------------------------------------------------------- structure

test('structure: the gear button next to the mode dropdown opens showToolSensorSettings()', () => {
  assert.match(INDEX_HTML, /id="toolSensorSettingsBtn" onclick="showToolSensorSettings\(\)"/);
});
