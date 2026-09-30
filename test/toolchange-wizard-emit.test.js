// Tool-change wizard, Tahap 1a - Commit 3: telling the client to show the
// wizard, but only once the controller is GENUINELY idle - reusing the exact
// signal jobRecovery.onIdle() already uses (sentBuffer.length === 0 at the
// moment a status report says "Idle"), not a separate poller.
//
// index.js cannot be require()d from a test (it boots Electron and the
// servers), so parseFeedback() (and, for the end-to-end tests, the same
// queue functions Commit 1/2 already exercise) is extracted from its source
// text and run in a vm sandbox.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createJobRecovery } = require('../jobRecovery');

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

function grabFunction(name) {
  const start = INDEX_SRC.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot extract function ' + name + ' from index.js');
  const end = INDEX_SRC.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'cannot find the end of function ' + name);
  return INDEX_SRC.slice(start, end + 2);
}

const BUFFER_VARS =
  INDEX_SRC.match(/var GRBL_RX_BUFFER_SIZE = [^\n]*\n/)[0] +
  INDEX_SRC.match(/var GRBLHAL_RX_BUFFER_SIZE = [^\n]*\n/)[0];
const MODAL_VARS =
  INDEX_SRC.match(/var modalCommands = \[[^\]]*\]\n/)[0] +
  INDEX_SRC.match(/var modalCommandsRegExp = [^\n]*\n/)[0];

// A minimal status-report line that parseFeedback() reads as exactly the
// given state and nothing else: it deliberately contains none of "wco:",
// "wpos:", "mpos:", "ov:", "FS:", "F:" or "Pn:", so none of parseFeedback's
// other (unrelated) extraction branches run - this test is only about the
// "Idle" + awaitingToolChange branch.
const status = (state) => '<' + state + '|>';

function baseCtx() {
  const emitted = [];
  return {
    gcodeQueue: [], queuePointer: 0, sentBuffer: [], statusLoop: null, queueCounter: null,
    toolChangeQIndexes: new Map(), pendingToolChange: null, toolChangeWizardEmitted: false,
    status: {
      comms: { connectionStatus: 2, blocked: false, paused: false, awaitingToolChange: false, runStatus: 'Idle', queue: 0, alarm: '', interfaces: { type: 'usb' } },
      machine: { modals: {}, firmware: { type: 'grbl', platform: 'grbl', rxBufferSize: 254, blockBufferSize: '35', version: '', date: '', buffer: '' }, tool: { nexttool: {} } },
    },
    fluidncConfig: '', jobStartTime: false, uploadedgcode: '', jobCompletedMsg: '', laserTestOn: false,
    jogWindow: null, debug_log() {}, serialLog() {}, setInterval() { return 1; }, clearInterval() {},
    setTimeout(fn) { fn(); return 1; },
    port: { isOpen: true, write() {} },
    io: { sockets: { emit(ev, d) { emitted.push([ev, d]); } } },
    _emitted: emitted,
  };
}

// --- parseFeedback() in isolation: exact flags set by hand, so the ---------
// --- "sentBuffer still has stuff" and "fires only once" cases are testable -
// --- without needing send1Q() to naturally produce them. -------------------

function isolatedHarness() {
  const ctx = baseCtx();
  ctx.jobRecovery = { onIdle() {} }; // Commit 2 already covers jobRecovery itself
  vm.createContext(ctx);
  vm.runInContext(['parseFeedback'].map(grabFunction).join('\n'), ctx);
  return ctx;
}

test('Idle arrives while sentBuffer still has unacked lines: must NOT emit yet', () => {
  const ctx = isolatedHarness();
  ctx.status.comms.awaitingToolChange = true;
  ctx.pendingToolChange = { line: 42, tool: '3' };
  ctx.sentBuffer = ['G1 X1']; // still something outstanding

  ctx.parseFeedback(status('Idle'));

  assert.deepEqual(ctx._emitted.filter((e) => e[0] === 'toolChangeWizard'), []);
});

test('once sentBuffer actually drains, the SAME Idle condition now emits, with the pending tool-change payload', () => {
  const ctx = isolatedHarness();
  ctx.status.comms.awaitingToolChange = true;
  ctx.pendingToolChange = { line: 42, tool: '3' };
  ctx.sentBuffer = [];

  ctx.parseFeedback(status('Idle'));

  const events = ctx._emitted.filter((e) => e[0] === 'toolChangeWizard');
  assert.equal(events.length, 1);
  assert.equal(events[0][1].line, 42);
  assert.equal(events[0][1].tool, '3');
  assert.equal(ctx.toolChangeWizardEmitted, true);
});

test('"Idle" arriving repeatedly emits the wizard event exactly ONCE (the latch works)', () => {
  const ctx = isolatedHarness();
  ctx.status.comms.awaitingToolChange = true;
  ctx.pendingToolChange = { line: 7, tool: null };
  ctx.sentBuffer = [];

  for (let i = 0; i < 10; i++) ctx.parseFeedback(status('Idle'));

  const events = ctx._emitted.filter((e) => e[0] === 'toolChangeWizard');
  assert.equal(events.length, 1, 'ten Idle reports, still exactly one wizard event');
});

test('no tool change pending: Idle (however many times) never emits the wizard event', () => {
  const ctx = isolatedHarness();
  ctx.status.comms.awaitingToolChange = false;
  ctx.sentBuffer = [];

  for (let i = 0; i < 5; i++) ctx.parseFeedback(status('Idle'));

  assert.equal(ctx._emitted.filter((e) => e[0] === 'toolChangeWizard').length, 0);
});

test('"Run" (not Idle) never emits, even with everything else set up for it', () => {
  const ctx = isolatedHarness();
  ctx.status.comms.awaitingToolChange = true;
  ctx.pendingToolChange = { line: 7, tool: null };
  ctx.sentBuffer = [];

  ctx.parseFeedback(status('Run'));

  assert.equal(ctx._emitted.filter((e) => e[0] === 'toolChangeWizard').length, 0);
});

test('once emitted, toolChangeWizardEmitted stays true even if awaitingToolChange later flips back and forth without a real new M6 (only Commit 2\'s skip branch resets the latch)', () => {
  const ctx = isolatedHarness();
  ctx.status.comms.awaitingToolChange = true;
  ctx.pendingToolChange = { line: 7, tool: null };
  ctx.sentBuffer = [];
  ctx.parseFeedback(status('Idle'));
  assert.equal(ctx._emitted.filter((e) => e[0] === 'toolChangeWizard').length, 1);

  ctx.parseFeedback(status('Idle'));
  ctx.parseFeedback(status('Idle'));

  assert.equal(ctx._emitted.filter((e) => e[0] === 'toolChangeWizard').length, 1);
});

// --- end-to-end: the REAL send1Q() skip feeding the REAL parseFeedback() ---

function endToEndHarness() {
  const ctx = baseCtx();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-tc-emit-'));
  ctx.jobRecovery = createJobRecovery({
    getDir: () => dir,
    autoTimer: false,
    getFirstUnackedQ: () => (ctx.gcodeQueue.length === 0 ? -1 : Math.max(0, ctx.queuePointer - ctx.sentBuffer.length)),
    getPlannerBlocks: () => 35,
  });
  vm.createContext(ctx);
  vm.runInContext(
    BUFFER_VARS + MODAL_VARS +
      ['isToolChangeLine', 'toolChangeToolNumber', 'addQToEnd', 'send1Q', 'BufferSpace', 'machineSend', 'runJob', 'parseFeedback']
        .map(grabFunction).join('\n'),
    ctx
  );
  return {
    ctx,
    ack() { ctx.sentBuffer.shift(); ctx.status.comms.blocked = false; ctx.send1Q(); },
    startJob(lines, extra) { ctx.runJob(Object.assign({ isJob: true, data: lines.join('\n') }, extra)); },
  };
}

function buildJob(n, toolChangeAtLine) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(i === toolChangeAtLine ? 'T2 M6' : 'G1 X' + i + ' F500');
  return lines;
}

test('end-to-end: reaching a real M6 through send1Q(), then feeding real status reports, emits the wizard exactly once, at the right moment', () => {
  const h = endToEndHarness();
  h.startJob(buildJob(10, 5)); // "T2 M6" at source line 5 -> queue index 4 (see Commit 2's tests)
  for (let i = 0; i < 4; i++) h.ack(); // the 4th ack's send1Q() reaches and skips it

  assert.equal(h.ctx.status.comms.awaitingToolChange, true, 'precondition: parked at the M6');

  // The controller is still finishing the moves from before the M6 - a "Run"
  // report arrives first, same as on real hardware.
  h.ctx.parseFeedback(status('Run'));
  assert.equal(h.ctx._emitted.filter((e) => e[0] === 'toolChangeWizard').length, 0, 'not idle yet');

  // Several "Idle" reports follow, as the controller keeps reporting status.
  for (let i = 0; i < 5; i++) h.ctx.parseFeedback(status('Idle'));

  const events = h.ctx._emitted.filter((e) => e[0] === 'toolChangeWizard');
  assert.equal(events.length, 1, 'exactly one wizard event, however many Idle reports arrived');
  assert.equal(events[0][1].line, 5);
  assert.equal(events[0][1].tool, '2');
});
