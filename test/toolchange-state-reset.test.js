// Tool-change wizard, Tahap 1a - Commit 4: resumeToolChange (the only thing
// that may clear awaitingToolChange), pause()'s guard against pausing on top
// of a tool-change wait, and - the structural core of this commit - proof
// that EVERY place in index.js that dumps gcodeQueue also resets the new
// tool-change state, found by SEARCHING the source (the same pattern
// test/reconnect-stale-state.test.js already uses for queuePointer/
// jobStartTime/jobCompletedMsg), not a fixed list of sites that could go
// stale the next time someone adds one.
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
function grabSocketHandler(event) {
  const marker = "socket.on('" + event + "', function(";
  const start = INDEX_SRC.indexOf(marker);
  assert.notEqual(start, -1, 'cannot extract socket handler ' + event + ' from index.js');
  const fnStart = start + ("socket.on('" + event + "', ").length;
  const end = INDEX_SRC.indexOf('\n  });', fnStart);
  assert.notEqual(end, -1, 'cannot find the end of socket handler ' + event);
  return '(' + INDEX_SRC.slice(fnStart, end + '\n  }'.length) + ')';
}

// ============================================================================
// STRUCTURAL: search the source for every "gcodeQueue.length = 0", regardless
// of where it is - this is what catches a FUTURE site that forgets the reset,
// including one nobody has thought of yet (like clearAlarm method 2, once).
// ============================================================================

test('structural: every "gcodeQueue.length = 0" site also resets ALL SEVEN tool-change state items (Tahap 1a\'s four, plus Tahap 1b-ii\'s wizard-sender trio)', () => {
  const lines = INDEX_SRC.split('\n');
  const sites = [];
  lines.forEach((line, i) => { if (/^\s*gcodeQueue\.length\s*=\s*0/.test(line)) sites.push(i); });

  console.log('toolchange-state-reset structural check: found ' + sites.length + ' "gcodeQueue.length = 0" site(s) at source line(s) ' + sites.map((i) => i + 1).join(', '));
  assert.equal(sites.length, 4, 'expected exactly the 4 known queue-dump sites (stopPort, stop, clearAlarm method 2, send1Q completion) - a different count means either a site was removed or a NEW one was added that this test has not been told to check yet');

  for (const i of sites) {
    const window = lines.slice(Math.max(0, i - 6), i + 24).join('\n');
    const where = 'index.js line ' + (i + 1) + ' (' + lines[i].trim() + ')';
    assert.match(window, /status\.comms\.awaitingToolChange\s*=\s*false/, where + ' must reset status.comms.awaitingToolChange');
    assert.match(window, /pendingToolChange\s*=\s*null/, where + ' must reset pendingToolChange');
    assert.match(window, /toolChangeWizardEmitted\s*=\s*false/, where + ' must reset toolChangeWizardEmitted');
    assert.match(window, /toolChangeQIndexes\.clear\(\)/, where + ' must clear toolChangeQIndexes');
    assert.match(window, /toolChangeWizardQueue\.length\s*=\s*0/, where + ' must clear toolChangeWizardQueue (Tahap 1b-ii)');
    assert.match(window, /toolChangeWizardPointer\s*=\s*0/, where + ' must reset toolChangeWizardPointer (Tahap 1b-ii)');
    assert.match(window, /toolChangeWizardSentBuffer\.length\s*=\s*0/, where + ' must clear toolChangeWizardSentBuffer (Tahap 1b-ii)');
  }
});

// ============================================================================
// Behavioural: a REAL harness running the REAL functions, proving the reset
// actually happens (the structural check above only proves the TEXT is
// nearby - this proves the CODE PATH really executes it).
// ============================================================================

const BUFFER_VARS =
  INDEX_SRC.match(/var GRBL_RX_BUFFER_SIZE = [^\n]*\n/)[0] +
  INDEX_SRC.match(/var GRBLHAL_RX_BUFFER_SIZE = [^\n]*\n/)[0];
const MODAL_VARS =
  INDEX_SRC.match(/var modalCommands = \[[^\]]*\]\n/)[0] +
  INDEX_SRC.match(/var modalCommandsRegExp = [^\n]*\n/)[0];

function harness() {
  const written = [];
  const emitted = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-tc-reset-'));
  const ctx = {
    gcodeQueue: [], queuePointer: 0, sentBuffer: [], statusLoop: null, queueCounter: null,
    toolChangeQIndexes: new Map(), toolChangeWizardQueue: [], toolChangeWizardPointer: 0, toolChangeWizardSentBuffer: [], VALID_TOOLCHANGE_MODES: ['ignore', 'fixedToolSensor'], pendingToolChange: null, toolChangeWizardEmitted: false,
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
      ['isToolChangeLine', 'toolChangeToolNumber', 'addQToEnd', 'addQRealtime', 'send1Q', 'BufferSpace', 'machineSend',
        'runJob', 'announceJobStopped', 'stopPort', 'stop', 'pause', 'unpause']
        .map(grabFunction).join('\n'),
    ctx
  );
  ctx.resumeToolChangeHandler = vm.runInContext(grabSocketHandler('resumeToolChange'), ctx);
  ctx.clearAlarmHandler = vm.runInContext(grabSocketHandler('clearAlarm'), ctx);
  return {
    ctx, written, emitted,
    ack() { ctx.sentBuffer.shift(); ctx.status.comms.blocked = false; ctx.send1Q(); },
    startJob(lines, extra) { ctx.runJob(Object.assign({ isJob: true, data: lines.join('\n') }, extra)); },
    parkAtM6(n, toolChangeAtLine) {
      // Runs a job and acks exactly enough times to reach and skip the M6
      // (same bookkeeping as test/toolchange-wizard-gate.test.js).
      const lines = [];
      for (let i = 1; i <= n; i++) lines.push(i === toolChangeAtLine ? 'T2 M6' : 'G1 X' + i + ' F500');
      this.startJob(lines, { fileName: 'part.nc' });
      for (let i = 0; i < toolChangeAtLine - 1; i++) this.ack();
      assert.equal(this.ctx.status.comms.awaitingToolChange, true, 'setup: parked at the M6');
    },
  };
}

function assertFullyReset(ctx, where) {
  assert.equal(ctx.status.comms.awaitingToolChange, false, where + ': awaitingToolChange');
  assert.equal(ctx.pendingToolChange, null, where + ': pendingToolChange');
  assert.equal(ctx.toolChangeWizardEmitted, false, where + ': toolChangeWizardEmitted');
  assert.equal(ctx.toolChangeQIndexes.size, 0, where + ': toolChangeQIndexes');
  assert.equal(ctx.toolChangeWizardQueue.length, 0, where + ': toolChangeWizardQueue (Tahap 1b-ii)');
  assert.equal(ctx.toolChangeWizardPointer, 0, where + ': toolChangeWizardPointer (Tahap 1b-ii)');
  assert.equal(ctx.toolChangeWizardSentBuffer.length, 0, where + ': toolChangeWizardSentBuffer (Tahap 1b-ii)');
}

test('stopPort() while parked at a tool change resets all four items', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.port.isOpen = false; // simulates the USB already being gone, same as test/reconnect-stale-state.test.js's pullUsb()
  h.ctx.stopPort();
  assertFullyReset(h.ctx, 'stopPort()');
});

test('stop() while parked at a tool change resets all four items', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.stop({ stop: true, jog: false, abort: false });
  assertFullyReset(h.ctx, 'stop()');
});

test('Clear Alarm method 2 while parked at a tool change resets all four items', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.clearAlarmHandler(2);
  assertFullyReset(h.ctx, 'clearAlarm(2)');
});

test('Clear Alarm method 1 ($X only) does NOT clear a tool-change wait - it never dumps the queue', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.clearAlarmHandler(1);
  assert.equal(h.ctx.status.comms.awaitingToolChange, true, 'method 1 must leave a running wait alone');
});

test('a job that genuinely completes (no tool change pending) leaves the reset state as a no-op, and still clears toolChangeQIndexes', () => {
  const h = harness();
  h.ctx.toolChangeQIndexes.set(999, { line: 1, tool: null }); // simulate a leftover from earlier in the SAME job
  h.startJob(['G1 X1 F500', 'G1 X2 F500'], { fileName: 'part.nc' });
  h.ack(); h.ack();
  assertFullyReset(h.ctx, 'genuine completion');
});

// --- jobRecovery: app-close / USB-pull WHILE parked lands on the correct ----
// --- resumeLine, using stopPort() for real (not just jobRecovery.tick()) ----

test('jobRecovery: stopPort() (simulating app-close/USB-pull) while parked at a mid-job M6 freezes resumeLine at the M6 line itself', () => {
  const h = harness();
  h.parkAtM6(20, 10); // "T2 M6" at source line 10

  h.ctx.port.isOpen = false; // simulates the USB already being gone
  h.ctx.stopPort();

  const rec = h.ctx.jobRecovery.peek();
  assert.ok(rec, 'a recovery record survives the dump');
  assert.equal(rec.state, 'interrupted');
  assert.equal(rec.resumeLine, 10, 'the M6 line itself - recovering re-arrives at (and re-triggers) the same wizard');
});

test('jobRecovery: Stop (the ribbon button) while parked at a mid-job M6 freezes the SAME resumeLine, as state "stopped"', () => {
  const h = harness();
  h.parkAtM6(20, 10);

  h.ctx.stop({ stop: true, jog: false, abort: false });

  const rec = h.ctx.jobRecovery.peek();
  assert.ok(rec);
  assert.equal(rec.state, 'stopped');
  assert.equal(rec.resumeLine, 10);
});

// --- resumeToolChange: the only handler allowed to clear the wait -----------

test('resumeToolChange clears the wait and lets the job continue (sends the "$G" right after the M6)', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  const pending = h.ctx.pendingToolChange;
  assert.equal(pending.line, 5);

  h.ctx.resumeToolChangeHandler();

  assert.equal(h.ctx.status.comms.awaitingToolChange, false);
  assert.equal(h.ctx.pendingToolChange, null);
  assert.equal(h.written[h.written.length - 1].trim(), '$G');
});

test('resumeToolChange is a no-op when there is nothing to resume (stray/duplicate click)', () => {
  const h = harness();
  h.startJob(['G1 X1 F500'], { fileName: 'part.nc' });
  const before = h.written.length;

  h.ctx.resumeToolChangeHandler();

  assert.equal(h.ctx.status.comms.awaitingToolChange, false);
  assert.equal(h.written.length, before, 'nothing extra was sent');
});

// --- pause()'s guard: refuses to act while a tool-change wait is pending ----

test('pause() while awaitingToolChange is true does nothing - no "!" sent, status.comms.paused untouched', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  const writtenBefore = h.written.length;

  h.ctx.pause();

  assert.equal(h.ctx.status.comms.paused, false, 'pause() must not have set it');
  assert.equal(h.written.length, writtenBefore, 'no "!" (or anything else) was sent');
  assert.equal(h.ctx.status.comms.awaitingToolChange, true, 'still parked - pause() did not disturb it either');
});

test('pause() works normally when no tool change is pending (guard does not over-block)', () => {
  const h = harness();
  h.startJob(['G1 X1 F500', 'G1 X2 F500', 'G1 X3 F500'], { fileName: 'part.nc' });
  h.ctx.status.comms.connectionStatus = 3;

  h.ctx.pause();

  assert.equal(h.ctx.status.comms.paused, true);
  assert.ok(h.written.some((s) => s === '!'), 'the hold command was sent: ' + JSON.stringify(h.written));
});

test('the two flags can never legitimately be true together: pause() while parked always refuses, so awaitingToolChange stays the only reason sending is halted', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  for (let i = 0; i < 5; i++) h.ctx.pause(); // however many times the button is clicked
  assert.equal(h.ctx.status.comms.paused, false);
  assert.equal(h.ctx.status.comms.awaitingToolChange, true);
});
