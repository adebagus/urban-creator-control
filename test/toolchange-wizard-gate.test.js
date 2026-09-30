// Tool-change wizard, Tahap 1a - Commit 2: the gate that halts the queue at
// an M6 line, kept SEPARATE from status.comms.paused (the existing manual
// Pause/Resume flag). This is the most critical commit in Tahap 1a - it
// touches send1Q(), the core streaming gate every job goes through.
//
// index.js cannot be require()d from a test (it boots Electron and the
// servers), so the REAL functions are extracted from its source text and run
// in a vm sandbox - same pattern as test/reconnect-stale-state.test.js. Every
// ack-count and queue-index number below was verified against the REAL
// send1Q()/addQToEnd() by running this exact harness before the numbers were
// written in, not derived by hand and assumed correct.
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

// A fresh sandbox running the REAL queue/gate code (runJob, send1Q,
// machineSend, ...) against a fake port and a REAL jobRecovery instance.
// writeIntervalMs: 0 so jobRecovery.peek() (which reads what was PERSISTED,
// not the live in-memory state) reflects every tick() immediately - the
// production 2000ms coalescing would otherwise make these tests racy.
function harness() {
  const written = [];
  const emitted = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-tc-gate-'));
  const ctx = {
    gcodeQueue: [], queuePointer: 0, sentBuffer: [], statusLoop: null, queueCounter: null,
    toolChangeQIndexes: new Map(), pendingToolChange: null, toolChangeWizardEmitted: false,
    status: {
      comms: { connectionStatus: 2, blocked: false, paused: false, awaitingToolChange: false, runStatus: 'Idle', queue: 0, alarm: '', interfaces: { type: 'usb' } },
      machine: { modals: {}, firmware: { type: 'grbl', platform: 'grbl', rxBufferSize: 254, blockBufferSize: '35', version: '', date: '', buffer: '' }, tool: { nexttool: {} } },
    },
    fluidncConfig: '', jobStartTime: false, uploadedgcode: '', jobCompletedMsg: '', laserTestOn: false,
    jogWindow: null, debug_log() {}, serialLog() {}, setInterval() { return 1; }, clearInterval() {},
    setTimeout(fn) { fn(); return 1; },
    port: { isOpen: true, write(s) { written.push(s); } },
    io: { sockets: { emit(ev, d) { emitted.push([ev, d]); } } },
  };
  ctx.jobRecovery = createJobRecovery({
    getDir: () => dir,
    autoTimer: false,
    writeIntervalMs: 0,
    getFirstUnackedQ: () => (ctx.gcodeQueue.length === 0 ? -1 : Math.max(0, ctx.queuePointer - ctx.sentBuffer.length)),
    getPlannerBlocks: () => 35,
  });
  vm.createContext(ctx);
  vm.runInContext(
    BUFFER_VARS + MODAL_VARS +
      ['isToolChangeLine', 'toolChangeToolNumber', 'addQToEnd', 'send1Q', 'BufferSpace', 'machineSend', 'runJob']
        .map(grabFunction).join('\n'),
    ctx
  );
  const h = {
    ctx, written, emitted,
    ack() { ctx.sentBuffer.shift(); ctx.status.comms.blocked = false; ctx.send1Q(); },
    startJob(lines, extra) {
      ctx.runJob(Object.assign({ isJob: true, data: lines.join('\n') }, extra));
    },
  };
  return h;
}

function buildJob(n, toolChangeAtLine, toolChangeText) {
  const lines = [];
  for (let i = 1; i <= n; i++) {
    lines.push(i === toolChangeAtLine ? (toolChangeText || 'T2 M6') : 'G1 X' + i + ' F500');
  }
  return lines;
}

// --- the queue halts exactly at M6, nothing written for that line -----------
//
// buildJob(10, 5) puts "T2 M6" at SOURCE line 5. Because it has a T-word,
// addQToEnd() also pushes a synthetic "$G" right after it - so the queue is
// [L1,L2,L3,L4,"T2 M6","$G",L6,L7,L8,L9,L10] and "T2 M6" sits at QUEUE index
// 4. runJob() already sends index 0 as it starts; ack() #4's send1Q() call is
// the one whose turn it is to send index 4 - and is where the skip happens.
// (Verified with a throwaway debug harness before writing this in - these are
// not hand-derived numbers taken on faith.)

test('M6 mid-job: the line is never written to the port, and the queue halts right there', () => {
  const h = harness();
  h.startJob(buildJob(10, 5));
  for (let i = 0; i < 4; i++) h.ack();

  assert.ok(!h.written.some((s) => /M0*6/i.test(s)), 'M6 must never reach the port: ' + JSON.stringify(h.written));
  assert.equal(h.ctx.status.comms.awaitingToolChange, true);
  assert.equal(h.ctx.pendingToolChange.line, 5);
  assert.equal(h.ctx.pendingToolChange.tool, '2');
  assert.equal(h.ctx.toolChangeWizardEmitted, false, "emitting the wizard event is Commit 3's job, not this one");
});

test('send1Q() called again and again while awaitingToolChange is true does nothing further', () => {
  const h = harness();
  h.startJob(buildJob(10, 5));
  for (let i = 0; i < 4; i++) h.ack();
  assert.equal(h.ctx.status.comms.awaitingToolChange, true, 'precondition');
  const writtenBefore = h.written.length;
  const pointerBefore = h.ctx.queuePointer;

  for (let i = 0; i < 20; i++) h.ctx.send1Q();

  assert.equal(h.written.length, writtenBefore, 'nothing new was written');
  assert.equal(h.ctx.queuePointer, pointerBefore, 'the pointer did not move further');
});

test('once awaitingToolChange is cleared, sending resumes right after M6 (through the same "$G" modal-restore addQToEnd already inserts after any T-word line)', () => {
  const h = harness();
  h.startJob(buildJob(10, 5));
  for (let i = 0; i < 4; i++) h.ack();
  assert.equal(h.ctx.status.comms.awaitingToolChange, true);

  // What Commit 4's "resumeToolChange" socket handler will do.
  h.ctx.status.comms.awaitingToolChange = false;
  h.ctx.pendingToolChange = null;
  h.ctx.send1Q();
  assert.equal(h.written[h.written.length - 1].trim(), '$G', 'the very next queue entry - addQToEnd\'s own modal-restore after a T-word line');

  h.ack(); // "$G" acked -> the job continues as an ordinary one from here
  assert.equal(h.written[h.written.length - 1].trim(), 'G1 X6 F500', 'line 6, right after the M6 at line 5');
});

// --- M6 as the very LAST line of the job: must still show the wizard, --------
// --- not be mistaken for "job complete" (the completion branch and the ------
// --- tool-change branch both trigger on "queuePointer caught up") -----------

test('M6 as the LAST queue entry does not trip job completion - the wizard gate wins', () => {
  const h = harness();
  // A bare "M6" (no T-word) so addQToEnd does not append a "$G" after it -
  // this is genuinely the last queue entry, matching queuePointer to
  // gcodeQueue.length exactly the way a real completion would.
  h.startJob(buildJob(5, 5, 'M6'));
  for (let i = 0; i < 4; i++) h.ack();

  assert.equal(h.ctx.queuePointer, h.ctx.gcodeQueue.length, 'precondition: pointer caught up to the end, same as a real completion');
  assert.equal(h.ctx.status.comms.awaitingToolChange, true, 'but this is a tool change, not a completion');
  assert.equal(h.emitted.filter((e) => e[0] === 'jobComplete').length, 0, 'must not have completed the job');
  assert.ok(h.ctx.gcodeQueue.length > 0, 'the queue must not have been dumped as if the job finished');
});

// --- the gate is an AND of three flags: any one of them alone blocks sending -

test('the gate blocks sending if EITHER paused OR awaitingToolChange is true (not just both together)', () => {
  const cases = [
    { paused: false, awaitingToolChange: false, expectSent: true },
    { paused: true, awaitingToolChange: false, expectSent: false },
    { paused: false, awaitingToolChange: true, expectSent: false },
    { paused: true, awaitingToolChange: true, expectSent: false },
  ];
  for (const c of cases) {
    const h = harness();
    h.startJob(buildJob(5, null)); // no M6 in this one - testing the flags directly
    h.ctx.status.comms.paused = c.paused;
    h.ctx.status.comms.awaitingToolChange = c.awaitingToolChange;
    const before = h.written.length;

    h.ctx.send1Q();

    const sent = h.written.length > before;
    assert.equal(sent, c.expectSent, JSON.stringify(c));
  }
});

// --- jobRecovery integration: verified behaviour, not the hand-derived ------
// --- guess from the planning discussion (that guess was WRONG - see below) --
//
// While PARKED waiting for the wizard, resumeLine lands on the M6 line
// ITSELF (10 in this job), not the line after it: getFirstUnackedQ() is
// queuePointer(10) - sentBuffer.length(0) = 10, and the nearest recorded mark
// at-or-before queue index 10 is the M6 line's own mark (there is no mark for
// the synthetic "$G" at index 10 - it is not a source line). This was
// EXPECTED to land one line later during planning; it does not, and it is
// arguably the SAFER outcome: if the app crashes here, "Recover Job" resumes
// AT the M6 line, which re-triggers this exact wizard on the next run rather
// than silently assuming the tool was already swapped. Only once the "$G"
// itself is actually sent and acked (i.e. the wizard was really completed and
// the job moved on) does resumeLine advance to line 11, the line after M6.

test('jobRecovery: while PARKED at a mid-job M6, resumeLine points at the M6 line itself (safe: recovery would re-arrive at the same wizard)', () => {
  const h = harness();
  h.startJob(buildJob(20, 10), { fileName: 'part.nc' }); // "T2 M6" at line 10 -> queue index 9
  for (let i = 0; i < 9; i++) h.ack(); // the 9th ack's send1Q() reaches and skips index 9 (M6)
  assert.equal(h.ctx.status.comms.awaitingToolChange, true, 'precondition: parked at the M6');
  assert.equal(h.ctx.sentBuffer.length, 0, 'the pre-M6 buffer has fully drained');

  h.ctx.jobRecovery.tick(); // what the ~1s timer normally does
  const rec = h.ctx.jobRecovery.peek();
  assert.ok(rec, 'a recovery record exists');
  assert.equal(rec.resumeLine, 10, 'the M6 line itself - not line 11, and not line 1');
});

test('jobRecovery: if the app closes WHILE the pre-M6 buffer is still draining, resumeLine stays conservative (the oldest not-yet-acked pre-M6 line)', () => {
  const h = harness();
  h.startJob(buildJob(20, 10), { fileName: 'part.nc' });
  for (let i = 0; i < 5; i++) h.ack(); // well short of the M6 at queue index 9
  assert.equal(h.ctx.status.comms.awaitingToolChange, false, 'precondition: still short of the M6');

  h.ctx.jobRecovery.tick();
  const rec = h.ctx.jobRecovery.peek();
  assert.equal(rec.resumeLine, 6, 'the oldest not-yet-acked pre-M6 line - never later than reality');
});

test('jobRecovery: once the wizard is actually resumed and the job moves on, resumeLine advances past the M6 (to line 11)', () => {
  const h = harness();
  h.startJob(buildJob(20, 10), { fileName: 'part.nc' });
  for (let i = 0; i < 9; i++) h.ack();
  assert.equal(h.ctx.status.comms.awaitingToolChange, true);

  h.ctx.status.comms.awaitingToolChange = false; // what resumeToolChange (Commit 4) will do
  h.ctx.pendingToolChange = null;
  h.ctx.send1Q(); // sends the synthetic "$G"
  h.ack(); // "$G" acked -> the next real line (11) is sent

  h.ctx.jobRecovery.tick();
  const rec = h.ctx.jobRecovery.peek();
  assert.equal(rec.resumeLine, 11, 'past the tool change now that it is genuinely done');
});
