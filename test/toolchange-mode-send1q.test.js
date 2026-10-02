// Tool-change wizard, Tahap 1b-i, Commit 4: Ignore mode's branch in
// send1Q() - the most critical commit in Tahap 1b-i, since it touches the
// same core streaming gate as Tahap 1a's Commit 2.
//
// M6 is still NEVER sent to the controller in Ignore mode (same
// prerequisite as Pause mode - see test/toolchange-wizard-gate.test.js), but
// there is no wizard: status.comms.awaitingToolChange is never set, and the
// skip immediately schedules the next send1Q() attempt via a REAL
// setImmediate (not a direct recursive call - see the comment in index.js),
// so these tests await a real macrotask tick rather than calling send1Q()
// by hand to simulate it.
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

function harness(mode) {
  const written = [];
  const emitted = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-tc-ignore-'));
  const ctx = {
    gcodeQueue: [], queuePointer: 0, sentBuffer: [], statusLoop: null, queueCounter: null,
    toolChangeQIndexes: new Map(), toolChangeWizardQueue: [], toolChangeWizardPointer: 0, toolChangeWizardSentBuffer: [], VALID_TOOLCHANGE_MODES: ['ignore', 'fixedToolSensor'], VALID_TOOLSENSOR_FIRST_BEHAVIOURS: ['always-wizard', 'always-probe', 'prompt'], pendingToolChange: null, toolChangeWizardEmitted: false, toolChangeMode: mode || 'pause',
    status: {
      comms: { connectionStatus: 2, blocked: false, paused: false, awaitingToolChange: false, runStatus: 'Idle', queue: 0, alarm: '', interfaces: { type: 'usb' } },
      machine: { modals: {}, firmware: { type: 'grbl', platform: 'grbl', rxBufferSize: 254, blockBufferSize: '35', version: '', date: '', buffer: '' }, tool: { nexttool: {} } },
    },
    fluidncConfig: '', jobStartTime: false, uploadedgcode: '', jobCompletedMsg: '', laserTestOn: false,
    jogWindow: null, debug_log() {}, serialLog() {}, setInterval() { return 1; }, clearInterval() {},
    setTimeout(fn) { fn(); return 1; },
    setImmediate, // the REAL one - send1Q()'s Ignore-mode branch schedules its own continuation with it
    port: { isOpen: true, write(s) { written.push(s); } },
    io: { sockets: { emit(ev, d) { emitted.push([ev, d]); } } },
  };
  ctx.jobRecovery = createJobRecovery({
    getDir: () => dir, autoTimer: false,
    getFirstUnackedQ: () => (ctx.gcodeQueue.length === 0 ? -1 : Math.max(0, ctx.queuePointer - ctx.sentBuffer.length)),
    getPlannerBlocks: () => 35,
  });
  vm.createContext(ctx);
  vm.runInContext(
    BUFFER_VARS + MODAL_VARS +
      ['isToolChangeLine', 'toolChangeToolNumber', 'addQToEnd', 'send1Q', 'BufferSpace', 'machineSend', 'isValidSensorLocation', 'runJob']
        .map(grabFunction).join('\n'),
    ctx
  );
  return {
    ctx, written, emitted,
    ack() { ctx.sentBuffer.shift(); ctx.status.comms.blocked = false; ctx.send1Q(); },
    startJob(lines, extra) { ctx.runJob(Object.assign({ isJob: true, data: lines.join('\n'), toolChangeMode: mode }, extra)); },
    tick() { return new Promise((r) => setImmediate(r)); }, // let a scheduled send1Q() continuation run
  };
}

function buildJob(n, toolChangeAtLine, toolChangeText) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(i === toolChangeAtLine ? (toolChangeText || 'T2 M6') : 'G1 X' + i + ' F500');
  return lines;
}

// --------------------------------------------------------------------------
// M6 mid-job, Ignore mode: skipped silently, no wizard, continues on its own
// --------------------------------------------------------------------------

test("Ignore mode: M6 mid-job is never written to the port, awaitingToolChange is NEVER set, and the job continues on its own (no ack, no manual send1Q() call)", async () => {
  const h = harness('ignore');
  h.startJob(buildJob(10, 5)); // "T2 M6" at source line 5 -> queue index 4 (see Tahap 1a Commit 2's tests)
  for (let i = 0; i < 4; i++) h.ack(); // reaches and skips the M6 at the 4th ack

  assert.ok(!h.written.some((s) => /M0*6/i.test(s)), 'M6 must never reach the port: ' + JSON.stringify(h.written));
  assert.equal(h.ctx.status.comms.awaitingToolChange, false, 'Ignore mode never pauses');
  assert.equal(h.ctx.pendingToolChange, null, 'no wizard payload is ever set');
  assert.equal(h.emitted.filter((e) => e[0] === 'toolChangeWizard').length, 0, 'no wizard event either');

  await h.tick(); // let the scheduled continuation run - nothing external triggers it

  assert.equal(h.written[h.written.length - 1].trim(), '$G', 'continued on its own to the synthetic "$G" right after the M6/T-word line');
});

test("Ignore mode: the job reaches completion entirely on its own, no human action, same as a job with no M6 at all", async () => {
  const h = harness('ignore');
  h.startJob(buildJob(6, 3));
  for (let i = 0; i < 2; i++) h.ack(); // reaches and skips the M6 at line 3 (queue index 2)
  await h.tick(); // "$G" now sent

  // Drain the rest normally.
  for (let i = 0; i < 10 && h.ctx.gcodeQueue.length > 0; i++) { h.ack(); await h.tick(); }

  const complete = h.emitted.filter((e) => e[0] === 'jobComplete');
  assert.equal(complete.length, 1, 'the job completes exactly once, unattended');
  assert.equal(complete[0][1].failed, false);
});

test("Ignore mode: TWO M6 lines in one job - both skipped, job still finishes entirely on its own", async () => {
  const lines = ['G1 X1 F500', 'T2 M6', 'G1 X2 F500', 'T3 M6', 'G1 X3 F500'];
  const h = harness('ignore');
  h.startJob(lines);
  for (let i = 0; i < 20 && h.ctx.gcodeQueue.length > 0; i++) { h.ack(); await h.tick(); }

  assert.ok(!h.written.some((s) => /M0*6/i.test(s)), JSON.stringify(h.written));
  assert.equal(h.ctx.status.comms.awaitingToolChange, false);
  assert.equal(h.emitted.filter((e) => e[0] === 'jobComplete' && e[1].completed && !e[1].failed).length, 1);
});

test('Ignore mode: M6 as the very LAST queue entry still completes the job correctly (does not hang waiting for the scheduled continuation)', async () => {
  const h = harness('ignore');
  h.startJob(buildJob(5, 5, 'M6')); // bare M6 (no T-word), genuinely the last entry - see Tahap 1a Commit 2
  for (let i = 0; i < 4; i++) h.ack(); // reaches and skips it

  const complete = h.emitted.filter((e) => e[0] === 'jobComplete');
  assert.equal(complete.length, 1, 'completes synchronously - the completion check after the switch statement already covers it, since awaitingToolChange is never set');
  assert.equal(h.ctx.gcodeQueue.length, 0, 'the queue was dumped as a genuine completion');

  await h.tick(); // the already-scheduled (now redundant) continuation must be a harmless no-op
  assert.equal(h.emitted.filter((e) => e[0] === 'jobComplete').length, 1, 'still exactly one completion - no double-fire');
});

// --------------------------------------------------------------------------
// Pause mode must be completely unaffected by this commit
// --------------------------------------------------------------------------

test("Pause mode (default) is unaffected: M6 still pauses and waits for resumeToolChange, exactly as Tahap 1a built it", () => {
  const h = harness('pause');
  h.startJob(buildJob(10, 5));
  for (let i = 0; i < 4; i++) h.ack();

  assert.equal(h.ctx.status.comms.awaitingToolChange, true);
  assert.equal(h.ctx.pendingToolChange.line, 5);
  for (let i = 0; i < 20; i++) h.ctx.send1Q(); // calling it repeatedly must still do nothing further
  assert.equal(h.written.some((s) => /\$G/.test(s)), false, 'still parked - nothing beyond the M6 was sent');
});

test("Tahap 1b-ii Commit 4: 'fixedToolSensor' mode parks in send1Q() exactly like 'pause' does - same gate, same pendingToolChange, no auto-continue like 'ignore'", () => {
  const h = harness('fixedToolSensor');
  h.startJob(buildJob(10, 5));
  for (let i = 0; i < 4; i++) h.ack();

  assert.equal(h.ctx.status.comms.awaitingToolChange, true);
  assert.equal(h.ctx.pendingToolChange.line, 5);
  assert.equal(h.ctx.pendingToolChange.tool, '2');
  for (let i = 0; i < 20; i++) h.ctx.send1Q();
  assert.equal(h.written.some((s) => /\$G/.test(s)), false, 'still parked - fixedToolSensor does not auto-continue the way ignore does');
});

test('structure: the Ignore-mode continuation uses setImmediate, not a direct recursive call (stack-safety for many consecutive M6 lines)', () => {
  const start = INDEX_SRC.indexOf('function send1Q(');
  const end = INDEX_SRC.indexOf('\n}\n', start);
  const body = INDEX_SRC.slice(start, end);
  assert.match(body, /if \(toolChangeMode === 'ignore'\) \{[^]*?setImmediate\(function\(\) \{\s*if \(gcodeQueue\.length > 0\) send1Q\(\);\s*\}\);/);
});
