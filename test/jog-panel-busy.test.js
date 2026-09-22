// UI guard for the "server says Connected, controller is still moving" state (app/js/ui.js).
//
// After a job is cut short the server's connectionStatus becomes 2 ("Connected") at once - it is the server's own
// assumption - while the controller may still be running what is in its buffer, and its status reports say "Run".
// Before, the jog buttons came back and Stop Job was disabled in that state. Now, for connectionStatus 1 or 2:
//   - the jog buttons (.jogbtn) stay DISABLED while the controller reports Run or Hold, and are enabled only once it
//     reports something else (Idle);
//   - the Stop Job button (#stopBtn) stays ENABLED while it reports Run or Hold.
// "Jog" is deliberately not part of the guard: a continuous jog is ended by the mouse-up on the held button, and a
// disabled button gets no mouse events, so disabling it mid-jog could leave the jog running.
// The REAL ui.js is loaded in a vm with a small jQuery fake that records .attr('disabled', ...) per selector.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'app/js/ui.js'), 'utf8').replace(/\r\n/g, '\n');

function makeUi() {
  const disabled = {}; // selector -> last value given to .attr('disabled', v)
  const chain = (sel) => new Proxy({}, {
    get(_, name) {
      if (name === 'attr') return (k, v) => { if (k === 'disabled') disabled[sel] = v; return chain(sel); };
      if (name === 'is' || name === 'length') return name === 'length' ? 0 : () => false;
      if (name === 'val' || name === 'data') return () => undefined;
      return () => chain(sel);
    },
  });
  const ctx = {
    $: (sel) => chain(sel), jQuery: (sel) => chain(sel),
    editor: { resize() {}, session: { getLength: () => 50 } },
    toolchanges: [], webgl: true, grblParams: { $22: 0 }, ace: {},
    console, setTimeout, clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(UI_SRC, ctx);
  const status = (connectionStatus, runStatus) => ({
    comms: { connectionStatus, runStatus },
    machine: { inputs: '' },
  });
  return {
    ctx, disabled,
    apply(connectionStatus, runStatus) {
      for (const k of Object.keys(disabled)) delete disabled[k];
      const st = status(connectionStatus, runStatus);
      ctx.setControlBar(connectionStatus, st);
      ctx.setJogPanel(connectionStatus, st);
      return { jog: disabled['.jogbtn'], stop: disabled['#stopBtn'] };
    },
  };
}

// --------------------------------------------------------------------------- the two guards

test('server says Connected (2) but the controller still reports Run: jog buttons stay DISABLED, Stop stays ENABLED', () => {
  const r = makeUi().apply(2, 'Run');
  assert.equal(r.jog, true, 'jogbtn disabled');
  assert.equal(r.stop, false, 'stopBtn enabled (disabled === false)');
});

test('the same for connectionStatus 1, and for Hold with any suffix (Hold:0 / Hold:1)', () => {
  const ui = makeUi();
  for (const [cs, run] of [[1, 'Run'], [2, 'Hold:0'], [2, 'Hold:1'], [1, 'Hold']]) {
    const r = ui.apply(cs, run);
    assert.equal(r.jog, true, cs + '/' + run + ': jogbtn disabled');
    assert.equal(r.stop, false, cs + '/' + run + ': stopBtn enabled');
  }
});

test('server says Connected (2) and the controller reports Idle: jog buttons enabled, Stop disabled - exactly as before', () => {
  const r = makeUi().apply(2, 'Idle');
  assert.equal(r.jog, false, 'jogbtn enabled');
  assert.equal(r.stop, true, 'stopBtn disabled (nothing to stop)');
});

test('other controller states (Idle, the server\'s own "Stopped", Door, Alarm text, Jog, Home, Check, undefined) do not trigger the guard', () => {
  const ui = makeUi();
  for (const run of ['Idle', 'Stopped', 'Door:0', 'Alarm', 'Jog', 'Home', 'Check', 'Sleep', '', undefined, null]) {
    const r = ui.apply(2, run);
    assert.equal(r.jog, false, String(run) + ': jogbtn enabled as before');
    assert.equal(r.stop, true, String(run) + ': stopBtn disabled as before');
  }
});

test('"Jog" is NOT guarded: the held jog button must not be disabled mid-jog (its mouse-up ends a continuous jog)', () => {
  const r = makeUi().apply(2, 'Jog');
  assert.equal(r.jog, false);
});

test('the guard needs an exact state word: "Running", "Runaway", "Holder" do not match', () => {
  const ui = makeUi();
  for (const run of ['Running', 'Runaway', 'Holder', 'run', 'hold']) assert.equal(ui.apply(2, run).jog, false, run);
});

test('it follows the controller: Run -> Idle re-enables the jog buttons and disables Stop on the next status', () => {
  const ui = makeUi();
  assert.equal(ui.apply(2, 'Run').jog, true);
  const r = ui.apply(2, 'Idle');
  assert.equal(r.jog, false);
  assert.equal(r.stop, true);
});

// --------------------------------------------------------------------------- the other connection states are untouched

test('streaming (3), paused (4), alarm (5): jog buttons disabled regardless of runStatus, as before', () => {
  const ui = makeUi();
  for (const cs of [3, 4, 5]) for (const run of ['Run', 'Idle', undefined]) {
    assert.equal(ui.apply(cs, run).jog, true, cs + '/' + run);
  }
});

test('streaming (3) and paused (4): the Stop button is enabled, exactly as before', () => {
  const ui = makeUi();
  assert.equal(ui.apply(3, 'Run').stop, false);
  assert.equal(ui.apply(4, 'Hold:0').stop, false);
});

test('not connected (0): jog buttons disabled and Stop disabled, whatever runStatus says', () => {
  const r = makeUi().apply(0, 'Run');
  assert.equal(r.jog, true);
  assert.equal(r.stop, true);
});

test('a missing/odd status object never throws and never enables Stop or disables jog by accident', () => {
  const ui = makeUi();
  const { ctx } = ui;
  assert.equal(ctx.controllerIsBusy(undefined), false);
  assert.equal(ctx.controllerIsBusy({}), false);
  assert.equal(ctx.controllerIsBusy({ comms: {} }), false);
  assert.equal(ctx.controllerIsBusy({ comms: { runStatus: 5 } }), false);
  assert.equal(ctx.controllerIsBusy({ comms: { runStatus: { toString() { return 'Run'; } } } }), false, 'only a real string counts');
});

// --------------------------------------------------------------------------- structure

test('structure: the two hooks are the only places connectionStatus 1/2 decide these buttons, and both use controllerIsBusy(status)', () => {
  assert.match(UI_SRC, /\$\('\.jogbtn'\)\.attr\('disabled', controllerIsBusy\(status\)\);/);
  assert.match(UI_SRC, /\$\('#stopBtn'\)\.show\(\)\.attr\('disabled', !controllerIsBusy\(status\)\);/);
  assert.match(UI_SRC, /var CONTROLLER_BUSY_RE = \/\^\(Run\|Hold\)\(:\|\$\)\/;/);
  assert.ok(!/Jog\|/.test(UI_SRC.match(/var CONTROLLER_BUSY_RE[^\n]*/)[0]), 'Jog stays out of the list');
});
