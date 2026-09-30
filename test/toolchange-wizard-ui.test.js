// Tool-change wizard, Tahap 1a - Commit 5: the client-side pieces.
//   - app/js/ui.js: the Pause button is disabled while awaitingToolChange is
//     true (same pattern as the existing controllerIsBusy guard).
//   - app/js/websocket.js: the 'toolChangeWizard' socket event pops a
//     Metro.dialog with the tool/line info; its one button emits
//     'resumeToolChange'; the LAN Jog-from-Phone page never sees it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const UI_SRC = read('app/js/ui.js');
const WS_SRC = read('app/js/websocket.js');

// ============================================================================
// app/js/ui.js - the Pause button guard, same harness style as
// test/jog-panel-busy.test.js (a small jQuery fake recording the last
// .attr('disabled', v) per selector), running the REAL ui.js in a vm.
// ============================================================================

function makeUi() {
  const disabled = {};
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
  return {
    ctx, disabled,
    apply(connectionStatus, extra) {
      for (const k of Object.keys(disabled)) delete disabled[k];
      const status = Object.assign({ comms: Object.assign({ connectionStatus, runStatus: 'Run' }, extra), machine: { inputs: '' } });
      ctx.setControlBar(connectionStatus, status);
      return disabled['#pauseBtn'];
    },
  };
}

test('Pause button is DISABLED while awaitingToolChange is true, while streaming (connectionStatus 3)', () => {
  const ui = makeUi();
  assert.equal(ui.apply(3, { awaitingToolChange: true }), true);
});

test('Pause button is ENABLED while streaming and awaitingToolChange is false, exactly as before', () => {
  const ui = makeUi();
  assert.equal(ui.apply(3, { awaitingToolChange: false }), false);
});

test('it follows the flag: true -> false re-enables Pause on the very next status', () => {
  const ui = makeUi();
  assert.equal(ui.apply(3, { awaitingToolChange: true }), true);
  assert.equal(ui.apply(3, { awaitingToolChange: false }), false);
});

test('a status object without comms.awaitingToolChange at all (older client/server mismatch) never throws and leaves Pause enabled', () => {
  const ui = makeUi();
  assert.doesNotThrow(() => ui.ctx.setControlBar(3, { comms: { connectionStatus: 3, runStatus: 'Run' }, machine: { inputs: '' } }));
  assert.equal(ui.disabled['#pauseBtn'], false);
});

test('structure: the guard reuses the exact awaitingToolChange field from status.comms, same style as controllerIsBusy(status)', () => {
  assert.match(UI_SRC, /\$\('#pauseBtn'\)\.show\(\)\.attr\('disabled', !!\(status\.comms && status\.comms\.awaitingToolChange\)\);/);
});

// ============================================================================
// app/js/websocket.js - the 'toolChangeWizard' handler
// ============================================================================

function grabSocketHandler(src, event) {
  const marker = "socket.on('" + event + "', function(";
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, 'cannot find socket handler ' + event);
  const fnStart = start + ("socket.on('" + event + "', ").length;
  const end = src.indexOf('\n  });', fnStart);
  assert.notEqual(end, -1, 'cannot find the end of socket handler ' + event);
  return '(' + src.slice(fnStart, end + '\n  }'.length) + ')';
}

function wsEnv(opts = {}) {
  const env = { dialogs: 0, dialogOpts: null, emitted: [], pending: [], focused: [] };
  const chain = { focus() { env.focused.push(true); return chain; } };
  const ctx = {
    isJogWidget: !!opts.jog,
    Metro: { dialog: { create: (o) => { env.dialogs++; env.dialogOpts = o; return {}; } } },
    socket: { emit(ev) { env.emitted.push(ev); } },
    setTimeout: (fn, ms) => { env.pending.push({ fn, ms }); },
    $: () => chain,
  };
  vm.createContext(ctx);
  const handler = vm.runInContext(grabSocketHandler(WS_SRC, 'toolChangeWizard'), ctx);
  env.fire = (info) => handler(info);
  env.flush = () => { while (env.pending.length) env.pending.shift().fn(); };
  return env;
}

test('shows a dialog naming the tool and the source line, with one "Continue" action', () => {
  const env = wsEnv();
  env.fire({ line: 42, tool: '3' });

  assert.equal(env.dialogs, 1);
  assert.match(env.dialogOpts.content, /T3/);
  assert.match(env.dialogOpts.content, /line 42/);
  assert.equal(env.dialogOpts.actions.length, 1);
  assert.equal(env.dialogOpts.actions[0].caption, 'Continue');
});

test('clicking Continue emits resumeToolChange and nothing else', () => {
  const env = wsEnv();
  env.fire({ line: 42, tool: '3' });

  env.dialogOpts.actions[0].onclick();

  assert.deepEqual(env.emitted, ['resumeToolChange']);
});

test('no tool number captured (a bare M6): still shows a usable dialog instead of "Tundefined"', () => {
  const env = wsEnv();
  env.fire({ line: 7, tool: null });

  assert.ok(!/Tnull|Tundefined/.test(env.dialogOpts.content));
  assert.match(env.dialogOpts.content, /the next tool/);
});

test('the LAN Jog-from-Phone page never sees this dialog (same as recoveryOffer)', () => {
  const env = wsEnv({ jog: true });
  env.fire({ line: 42, tool: '3' });

  assert.equal(env.dialogs, 0);
});

test('opening it sends nothing on its own - only the button click does', () => {
  const env = wsEnv();
  env.fire({ line: 42, tool: '3' });

  assert.deepEqual(env.emitted, []);
});

test('structure: the handler is registered right after recoveryOffer, and both are skipped for isJogWidget the same way', () => {
  const i1 = WS_SRC.indexOf("socket.on('recoveryOffer'");
  const i2 = WS_SRC.indexOf("socket.on('toolChangeWizard'");
  assert.ok(i1 !== -1 && i2 !== -1 && i2 > i1 && i2 - i1 < 600, 'kept close together, same family of notification');
});
