// Tool-change wizard, Tahap 1b-ii, Commit 6: the client-side dialog for
// Fixed Tool Sensor - app/js/websocket.js's 'toolChangeProbeReady' handler.
//
// Mirrors test/toolchange-wizard-ui.test.js's harness for the 'toolChangeWizard'
// handler (same grabSocketHandler extraction pattern), but this dialog is
// deliberately NOT a copy of that one: its action emits 'startToolSensorProbe'
// (never 'resumeToolChange' - index.js refuses that event outright in this
// mode, see Tahap 1b-ii Commit 5), it does NOT carry "js-dialog-close" since
// it must stay open to show probing progress, and it listens for the
// server's '[ TOOL SENSOR ]' 'data' messages to show "Probing..." ->
// success/error, closing itself only once genuinely done.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WS_SRC = fs.readFileSync(path.join(__dirname, '..', 'app/js/websocket.js'), 'utf8').replace(/\r\n/g, '\n');

function grabSocketHandler(src, event) {
  const marker = "socket.on('" + event + "', function(";
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, 'cannot find socket handler ' + event);
  const fnStart = start + ("socket.on('" + event + "', ").length;
  const end = src.indexOf('\n  });', fnStart);
  assert.notEqual(end, -1, 'cannot find the end of socket handler ' + event);
  return '(' + src.slice(fnStart, end + '\n  }'.length) + ')';
}

// Per-selector recorder: tracks every .html()/.prop()/.remove()/.focus() call
// by selector string, so assertions can check the RIGHT element changed,
// same spirit as toolchange-wizard-ui.test.js's makeUi() disabled-by-selector
// Proxy.
function makeJQueryRecorder() {
  const calls = {};
  function ensure(sel) {
    if (!calls[sel]) calls[sel] = { html: [], prop: [], removed: false, focused: false };
    return calls[sel];
  }
  function chain(sel) {
    const rec = ensure(sel);
    const obj = {
      html(v) { if (v !== undefined) rec.html.push(v); return obj; },
      prop(k, v) { rec.prop.push([k, v]); return obj; },
      remove() { rec.removed = true; return obj; },
      focus() { rec.focused = true; return obj; },
      attr() { return obj; },
      val() { return undefined; },
      is() { return false; },
      data() { return undefined; },
      length: 0,
    };
    return obj;
  }
  return { calls, $: (sel) => chain(sel) };
}

function makeSocket() {
  const emitted = [];
  const listeners = {};
  return {
    emitted,
    emit(ev) { emitted.push(ev); },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    off(ev, fn) {
      if (!listeners[ev]) return;
      listeners[ev] = listeners[ev].filter((f) => f !== fn);
    },
    fireData(payload) { (listeners.data || []).slice().forEach((fn) => fn(payload)); },
    listenerCount(ev) { return (listeners[ev] || []).length; },
  };
}

function wsEnv(opts = {}) {
  const rec = makeJQueryRecorder();
  const socket = makeSocket();
  const dialogState = { created: null, ref: null, closeCalls: [] };
  const pending = [];
  const ctx = {
    isJogWidget: !!opts.jog,
    // homed by default (true) so tests NOT about homing keep testing
    // whatever they were already testing in isolation - same convention as
    // test/toolsensor-settings-ui.test.js's boot() default.
    laststatus: 'laststatus' in opts ? opts.laststatus : { machine: { modals: { homedRecently: true } } },
    Metro: {
      dialog: {
        create(o) { dialogState.created = o; dialogState.ref = {}; return dialogState.ref; },
        close(ref) { dialogState.closeCalls.push(ref); },
      },
    },
    socket,
    setTimeout: (fn, ms) => { pending.push({ fn, ms }); },
    $: rec.$,
    escapeHTML: (s) => s,
  };
  vm.createContext(ctx);
  const handler = vm.runInContext(grabSocketHandler(WS_SRC, 'toolChangeProbeReady'), ctx);
  return {
    rec: rec.calls, socket, dialogState,
    fire: (info) => handler(info),
    flush() { while (pending.length) pending.shift().fn(); },
  };
}

// ============================================================================
// Opening the dialog
// ============================================================================

test('shows a dialog naming the tool and the source line, with one "Probe & Continue" action', () => {
  const env = wsEnv();
  env.fire({ line: 12, tool: '4' });

  assert.equal(env.dialogState.created !== null, true);
  assert.match(env.dialogState.created.content, /T4/);
  assert.match(env.dialogState.created.content, /line 12/);
  assert.equal(env.dialogState.created.actions.length, 1);
  assert.equal(env.dialogState.created.actions[0].caption, 'Probe & Continue');
});

test('the dialog warns explicitly that clicking the action moves the machine AUTOMATICALLY', () => {
  const env = wsEnv();
  env.fire({ line: 12, tool: '4' });
  assert.match(env.dialogState.created.content, /AUTOMATICALLY/);
});

// ============================================================================
// Homing enforcement (post-Commit-6 hardening): the sensor location is in
// MACHINE coordinates (G53), meaningless unless the machine has been homed
// since power-up/reset - same enforcement style as app/js/toolchange.js's
// own $20 guard on the settings dialog's capture button.
// ============================================================================

test('NOT homed: the button is disabled on open, and a homing warning is shown', () => {
  const env = wsEnv({ laststatus: { machine: { modals: { homedRecently: false } } } });
  env.fire({ line: 12, tool: '4' });

  assert.deepEqual(env.rec['.toolSensorProbeBtn'].prop[0], ['disabled', true]);
  assert.match(env.dialogState.created.content, /Home mesin dulu/);
});

test('homed: the button is NOT disabled on open, and no homing warning appears', () => {
  const env = wsEnv({ laststatus: { machine: { modals: { homedRecently: true } } } });
  env.fire({ line: 12, tool: '4' });

  assert.equal((env.rec['.toolSensorProbeBtn'] || { prop: [] }).prop.length, 0, 'never disabled at open time');
  assert.ok(!/Home mesin dulu/.test(env.dialogState.created.content));
});

test('no live status at all (never connected): treated the same as not homed - disabled, warned, never assumed safe', () => {
  const env = wsEnv({ laststatus: undefined });
  env.fire({ line: 12, tool: '4' });

  assert.deepEqual(env.rec['.toolSensorProbeBtn'].prop[0], ['disabled', true]);
  assert.match(env.dialogState.created.content, /Home mesin dulu/);
});

test('NOT homed: clicking the action anyway (e.g. re-enabled via devtools) is refused client-side too and emits nothing', () => {
  const env = wsEnv({ laststatus: { machine: { modals: { homedRecently: false } } } });
  env.fire({ line: 12, tool: '4' });

  env.dialogState.created.actions[0].onclick();

  assert.deepEqual(env.socket.emitted, [], 'startToolSensorProbe must never be emitted while unhomed');
  assert.match(env.rec['#toolSensorProbeStatus'].html.at(-1), /Home mesin dulu/);
});

test('re-homed WHILE the dialog is open (laststatus mutated in place): the click re-checks live, not the stale value from when the dialog opened', () => {
  const laststatus = { machine: { modals: { homedRecently: false } } };
  const env = wsEnv({ laststatus });
  env.fire({ line: 12, tool: '4' });

  laststatus.machine.modals.homedRecently = true; // operator homes the machine before clicking
  env.dialogState.created.actions[0].onclick();

  assert.deepEqual(env.socket.emitted, ['startToolSensorProbe'], 'the click must use the CURRENT homing state, not the one from when the dialog opened');
});

test('no tool number captured (a bare M6): still shows a usable dialog instead of "Tundefined"', () => {
  const env = wsEnv();
  env.fire({ line: 7, tool: null });
  assert.ok(!/Tnull|Tundefined/.test(env.dialogState.created.content));
  assert.match(env.dialogState.created.content, /the next tool/);
});

test('the LAN Jog-from-Phone page never sees this dialog, same as toolChangeWizard', () => {
  const env = wsEnv({ jog: true });
  env.fire({ line: 12, tool: '4' });
  assert.equal(env.dialogState.created, null);
});

test('opening it sends nothing on its own - only the button click does', () => {
  const env = wsEnv();
  env.fire({ line: 12, tool: '4' });
  assert.deepEqual(env.socket.emitted, []);
});

// ============================================================================
// Clicking "Probe & Continue" - the critical event-correctness point
// ============================================================================

test('clicking "Probe & Continue" emits startToolSensorProbe and NOTHING ELSE - never resumeToolChange', () => {
  const env = wsEnv();
  env.fire({ line: 12, tool: '4' });

  env.dialogState.created.actions[0].onclick();

  assert.deepEqual(env.socket.emitted, ['startToolSensorProbe']);
});

test('clicking the action immediately disables the button and shows a "Probing..." status', () => {
  const env = wsEnv();
  env.fire({ line: 12, tool: '4' });

  env.dialogState.created.actions[0].onclick();

  assert.deepEqual(env.rec['.toolSensorProbeBtn'].prop[0], ['disabled', true]);
  assert.match(env.rec['#toolSensorProbeStatus'].html[0], /Probing/);
});

test('double-clicking the action only ever emits startToolSensorProbe once per click - no hidden dedup needed because the button is disabled, but confirm nothing else leaks', () => {
  const env = wsEnv();
  env.fire({ line: 12, tool: '4' });
  env.dialogState.created.actions[0].onclick();
  env.dialogState.created.actions[0].onclick(); // UI would prevent this via disabled, but the handler itself has no extra guard - confirm it is at least idempotent in effect (both emits are the same event)

  assert.deepEqual(env.socket.emitted, ['startToolSensorProbe', 'startToolSensorProbe']);
});

// ============================================================================
// Server-side progress messages ('[ TOOL SENSOR ]' on the shared 'data' event)
// ============================================================================

test('a successful completion message updates the status, removes the button, and closes the dialog after a short delay', () => {
  const env = wsEnv();
  env.fire({ line: 12, tool: '4' });
  env.dialogState.created.actions[0].onclick();

  env.socket.fireData({ command: '[ TOOL SENSOR ]', response: 'Kompensasi panjang tool diterapkan.', type: 'success' });

  assert.match(env.rec['#toolSensorProbeStatus'].html.at(-1), /Kompensasi panjang tool diterapkan/);
  assert.equal(env.rec['.toolSensorProbeBtn'].removed, true);
  assert.equal(env.dialogState.closeCalls.length, 0, 'not closed yet - only scheduled');

  env.flush();
  assert.equal(env.dialogState.closeCalls.length, 1, 'closed once the delay elapses');
  assert.equal(env.dialogState.closeCalls[0], env.dialogState.ref, 'closes THIS dialog, not something else');
});

test('a failed probe message shows the error and RE-ENABLES the button with a retry caption - the dialog stays open', () => {
  const env = wsEnv();
  env.fire({ line: 12, tool: '4' });
  env.dialogState.created.actions[0].onclick();

  env.socket.fireData({ command: '[ TOOL SENSOR ]', response: 'Probe tidak menyentuh sensor dalam jarak yang ditentukan.', type: 'error' });

  assert.match(env.rec['#toolSensorProbeStatus'].html.at(-1), /Probe tidak menyentuh sensor/);
  assert.deepEqual(env.rec['.toolSensorProbeBtn'].prop.at(-1), ['disabled', false]);
  assert.match(env.rec['.toolSensorProbeBtn'].html.at(-1), /Coba Lagi|Retry/);
  assert.equal(env.rec['.toolSensorProbeBtn'].removed, false, 'the button must still be there to retry');

  env.flush();
  assert.equal(env.dialogState.closeCalls.length, 0, 'an error must never auto-close the dialog');
});

test('retrying after a failure re-emits startToolSensorProbe (the sequence can be attempted again without reopening the dialog)', () => {
  const env = wsEnv();
  env.fire({ line: 12, tool: '4' });
  env.dialogState.created.actions[0].onclick();
  env.socket.fireData({ command: '[ TOOL SENSOR ]', response: 'gagal', type: 'error' });

  env.dialogState.created.actions[0].onclick(); // the SAME action handler - this is the "Coba Lagi" click

  assert.deepEqual(env.socket.emitted, ['startToolSensorProbe', 'startToolSensorProbe']);
});

test('an UNRELATED data message (different command) is ignored completely - no status/button change', () => {
  const env = wsEnv();
  env.fire({ line: 12, tool: '4' });
  env.dialogState.created.actions[0].onclick();

  env.socket.fireData({ command: '[ PROBE ]', response: 'Probe Completed.', type: 'success' });

  assert.equal(env.rec['#toolSensorProbeStatus'].html.length, 1, 'only the "Probing..." message from the click itself');
  assert.equal(env.rec['.toolSensorProbeBtn'].removed, false);
});

test('a data payload with no "command" field at all does not throw', () => {
  const env = wsEnv();
  env.fire({ line: 12, tool: '4' });
  assert.doesNotThrow(() => env.socket.fireData({ response: 'hello', type: 'info' }));
  assert.doesNotThrow(() => env.socket.fireData(null));
});

// ============================================================================
// Listener hygiene: the dialog must not leave a dangling 'data' listener
// ============================================================================

test('after a successful completion, the data listener is removed - a LATER stray message changes nothing further', () => {
  const env = wsEnv();
  env.fire({ line: 12, tool: '4' });
  env.dialogState.created.actions[0].onclick();
  env.socket.fireData({ command: '[ TOOL SENSOR ]', response: 'ok', type: 'success' });
  const htmlCountAfterSuccess = env.rec['#toolSensorProbeStatus'].html.length;

  env.socket.fireData({ command: '[ TOOL SENSOR ]', response: 'a later unrelated message', type: 'error' });

  assert.equal(env.rec['#toolSensorProbeStatus'].html.length, htmlCountAfterSuccess, 'no further updates once the listener was torn down');
});

test('closing the dialog manually (onClose) also tears down the data listener', () => {
  const env = wsEnv();
  env.fire({ line: 12, tool: '4' });
  assert.equal(env.socket.listenerCount('data'), 1, 'precondition: the dialog registered its own listener');

  env.dialogState.created.onClose();

  assert.equal(env.socket.listenerCount('data'), 0, 'onClose must unregister it, or a later unrelated probe elsewhere in the app could update a dead dialog');
});

// ============================================================================
// Structural checks - these are the ones that would catch a "wrong event
// name" class of bug even if a behavioural test happened to be written
// sloppily enough to miss it.
// ============================================================================

function extractHandlerSource(event) {
  const marker = "socket.on('" + event + "', function(";
  const start = WS_SRC.indexOf(marker);
  const end = WS_SRC.indexOf('\n  });', start);
  return WS_SRC.slice(start, end);
}

test('structure: the action\'s class list does NOT include js-dialog-close (the dialog must stay open for progress)', () => {
  // Checked against the actual `cls: "..."` STRING, not the whole handler
  // source - a nearby comment explaining this exact decision legitimately
  // contains the words "js-dialog-close", which a naive whole-body regex
  // would wrongly flag as the class itself being present.
  const match = WS_SRC.match(/cls: "(alert toolSensorProbeBtn)",/);
  assert.ok(match, 'expected the action\'s cls string to be found');
  assert.ok(!match[1].includes('js-dialog-close'), 'js-dialog-close would auto-close the dialog on click, before probing even starts: ' + match[1]);
});

test('structure: the handler never mentions resumeToolChange anywhere in its body', () => {
  const src = extractHandlerSource('toolChangeProbeReady');
  assert.ok(!/resumeToolChange/.test(src), 'this mode must only ever use startToolSensorProbe - see index.js\'s own refusal of resumeToolChange in fixedToolSensor mode');
});

test("structure: 'toolChangeProbeReady' is registered as its own event, separate from 'toolChangeWizard'", () => {
  assert.match(WS_SRC, /socket\.on\('toolChangeProbeReady', function\(info\) \{/);
  const i1 = WS_SRC.indexOf("socket.on('toolChangeWizard'");
  const i2 = WS_SRC.indexOf("socket.on('toolChangeProbeReady'");
  assert.ok(i1 !== -1 && i2 !== -1 && i2 > i1, 'kept right after the Pause-mode dialog, same family');
});

test("structure: progress messages are matched on command === '[ TOOL SENSOR ]', not a looser check", () => {
  const src = extractHandlerSource('toolChangeProbeReady');
  assert.match(src, /data\.command !== '\[ TOOL SENSOR \]'/);
});
