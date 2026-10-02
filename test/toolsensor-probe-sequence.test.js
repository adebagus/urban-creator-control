// Tool-change wizard, Tahap 1b-ii, Commit 5: the Fixed Tool Sensor probe
// sequencer itself - the highest-risk commit in the whole tool-change wizard
// project, per the user's own flag, because it is the only one that issues
// REAL machine motion (G53 travel, G38.2 probing, G10 compensation) on top
// of Commit 3's proven-safe separate pipeline.
//
// Two completion signals drive the sequencer, deliberately NOT unified (see
// the comment block above these functions in index.js):
//   - "ok" (toolChangeWizardDoneCallback, routed through routeOkAndAdvance)
//     for plain moves, where acknowledgement IS completion;
//   - the [PRB: report (handleToolSensorProbeResult()) for the probe line
//     itself, since "ok" there only means "accepted into the buffer", not
//     "the physical probe finished".
//
// The interruption-mid-sequence tests below are the ones the user singled
// out as needing to be proven for REAL (actual G53/G38.2 lines sent and
// acked before the interruption), not assumed safe just because Commit 3's
// own interruption safety was already proven for dummy gcode.
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

const BUFFER_VARS =
  INDEX_SRC.match(/var GRBL_RX_BUFFER_SIZE = [^\n]*\n/)[0] +
  INDEX_SRC.match(/var GRBLHAL_RX_BUFFER_SIZE = [^\n]*\n/)[0];
const MODAL_VARS =
  INDEX_SRC.match(/var modalCommands = \[[^\]]*\]\n/)[0] +
  INDEX_SRC.match(/var modalCommandsRegExp = [^\n]*\n/)[0];

function harness() {
  const written = [];
  const emitted = [];
  const logs = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-toolsensor-'));
  const ctx = {
    gcodeQueue: [], queuePointer: 0, sentBuffer: [], statusLoop: null, queueCounter: null,
    toolChangeQIndexes: new Map(), pendingToolChange: null, toolChangeWizardEmitted: false, toolChangeMode: 'pause',
    toolChangeWizardQueue: [], toolChangeWizardPointer: 0, toolChangeWizardSentBuffer: [], toolChangeWizardDoneCallback: null,
    toolChangeSensorLocation: null, toolChangeSensorFirstBehaviour: 'always-wizard', toolChangeSensorBaseline: null, toolSensorProbeState: null,
    VALID_TOOLCHANGE_MODES: ['ignore', 'fixedToolSensor'], VALID_TOOLSENSOR_FIRST_BEHAVIOURS: ['always-wizard', 'always-probe', 'prompt'],
    TOOLSENSOR_APPROACH_CLEARANCE: 15, TOOLSENSOR_PROBE_DISTANCE: 25, TOOLSENSOR_PROBE_FEED: 100,
    fluidncConfig: '',
    status: {
      comms: { connectionStatus: 2, blocked: false, paused: false, awaitingToolChange: false, runStatus: 'Idle', queue: 0, alarm: '', interfaces: { type: 'usb' } },
      machine: {
        modals: { coordinatesys: 'G54', homedRecently: true },
        firmware: { type: 'grbl', platform: 'grbl', rxBufferSize: 254, blockBufferSize: '35', version: '', date: '', buffer: '' },
        tool: { nexttool: {} },
        probe: { x: 0, y: 0, z: 0, state: -1 },
        position: { work: { x: 0, y: 0, z: -5 }, offset: { x: 0, y: 0, z: -50 } },
      },
    },
    jobStartTime: false, uploadedgcode: '', jobCompletedMsg: '', laserTestOn: false,
    jogWindow: null, debug_log() {}, serialLog(lvl, msg) { logs.push(lvl + ': ' + msg); }, setInterval() { return 1; }, clearInterval() {},
    setTimeout(fn) { fn(); return 1; }, setImmediate,
    port: { isOpen: true, write(s) { written.push(s); } },
    io: { sockets: { emit(ev, d) { emitted.push([ev, d]); } } },
  };
  ctx.jobRecovery = createJobRecovery({
    getDir: () => dir, autoTimer: false, writeIntervalMs: 0,
    getFirstUnackedQ: () => (ctx.gcodeQueue.length === 0 ? -1 : Math.max(0, ctx.queuePointer - ctx.sentBuffer.length)),
    getPlannerBlocks: () => 35,
  });
  vm.createContext(ctx);
  vm.runInContext(
    BUFFER_VARS + MODAL_VARS +
      ['isToolChangeLine', 'toolChangeToolNumber', 'addQToEnd', 'addQRealtime', 'send1Q', 'BufferSpace', 'machineSend', 'isValidSensorLocation', 'runJob',
        'toolChangeWizardBufferSpace', 'machineSendToolChangeWizard', 'sendToolChangeWizardQ', 'startToolChangeWizardSend',
        'routeOkAndAdvance', 'toolSensorCoordSysP', 'startToolSensorProbe', 'handleToolSensorProbeResult', 'parseFeedback',
        'announceJobStopped', 'stopPort', 'stop']
        .map(grabFunction).join('\n'),
    ctx
  );
  ctx.resumeToolChangeHandler = vm.runInContext(grabSocketHandler('resumeToolChange'), ctx);
  ctx.clearAlarmHandler = vm.runInContext(grabSocketHandler('clearAlarm'), ctx);
  return {
    ctx, written, emitted, logs,
    // the REAL "ok" routing (same as toolchange-wizard-queue-separation.test.js)
    realOk(command) { return ctx.routeOkAndAdvance(command); },
    // acks whatever is currently outstanding (main job OR wizard), mirroring
    // how a real "ok" from the controller is indifferent to which sender is
    // waiting on it.
    ackWhicheverIsOutstanding() {
      if (ctx.toolChangeWizardSentBuffer.length > 0) {
        this.realOk(ctx.toolChangeWizardSentBuffer[0]);
      } else {
        this.realOk(ctx.sentBuffer[0]);
      }
    },
    parkAtM6(n, toolChangeAtLine, extra) {
      const lines = [];
      for (let i = 1; i <= n; i++) lines.push(i === toolChangeAtLine ? 'T2 M6' : 'G1 X' + i + ' F500');
      ctx.runJob(Object.assign({ isJob: true, data: lines.join('\n'), toolChangeMode: 'fixedToolSensor', fileName: 'part.nc' }, extra));
      for (let i = 0; i < toolChangeAtLine - 1; i++) this.ackWhicheverIsOutstanding();
      assert.equal(ctx.status.comms.awaitingToolChange, true, 'setup: parked at the M6');
      assert.equal(ctx.sentBuffer.length, 0, 'setup: main sentBuffer genuinely drained');
    },
    // runs the probe sequence to completion with a successful probe,
    // acking every wizard line along the way.
    runFullSequence(probeZ) {
      assert.equal(ctx.startToolSensorProbe(), true, 'startToolSensorProbe should have accepted');
      // approach (2 lines) + G91 + G38.2 + G90 = 5 lines, ack them all
      for (let i = 0; i < 5; i++) this.ackWhicheverIsOutstanding();
      ctx.status.machine.probe = { x: 0, y: 0, z: probeZ, state: 1 };
      ctx.handleToolSensorProbeResult(ctx.status.machine.probe);
      // return phase: either 3 lines (baseline) or 4 (compensation) - ack
      // until the wizard queue is drained.
      while (ctx.toolChangeWizardSentBuffer.length > 0 || ctx.toolChangeWizardPointer < ctx.toolChangeWizardQueue.length) {
        this.ackWhicheverIsOutstanding();
      }
    },
  };
}

const sensorLoc = { x: 100, y: 50, z: -40 };

// vm-executed code produces arrays/objects from a DIFFERENT realm's
// Array.prototype/Object.prototype - assert.deepEqual (deepStrictEqual under
// node:assert/strict) treats those as unequal even when structurally
// identical. Re-collecting into a plain array/object built in THIS file's
// own realm sidesteps it without weakening the comparison.
function sameArray(actual, expected, message) {
  assert.deepEqual([...actual], [...expected], message);
}
function sameObject(actual, expected, message) {
  assert.deepEqual({ ...actual }, { ...expected }, message);
}

// ============================================================================
// toolSensorCoordSysP(): G54..G59 -> 1..6, unrecognised -> 1
// ============================================================================

test('toolSensorCoordSysP(): maps G54..G59 to 1..6, falls back to 1 for anything else', () => {
  const h = harness();
  const cases = { G54: 1, G55: 2, G56: 3, G57: 4, G58: 5, G59: 6, '': 1, G28: 1, undefined: 1 };
  for (const [sys, expected] of Object.entries(cases)) {
    h.ctx.status.machine.modals.coordinatesys = sys === 'undefined' ? undefined : sys;
    assert.equal(h.ctx.toolSensorCoordSysP(), expected, sys);
  }
});

// ============================================================================
// startToolSensorProbe(): guard rails
// ============================================================================

test('startToolSensorProbe() refuses when not awaitingToolChange at all', () => {
  const h = harness();
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.toolChangeMode = 'fixedToolSensor';
  assert.equal(h.ctx.startToolSensorProbe(), false);
  assert.equal(h.ctx.toolSensorProbeState, null);
  assert.equal(h.written.length, 0, 'nothing sent');
});

test('startToolSensorProbe() refuses when parked but mode is "pause", not "fixedToolSensor"', () => {
  const h = harness();
  h.parkAtM6(10, 5); // parks in fixedToolSensor by default via the helper...
  h.ctx.toolChangeMode = 'pause'; // ...then simulate it actually being plain Pause
  h.ctx.toolChangeSensorLocation = sensorLoc;
  assert.equal(h.ctx.startToolSensorProbe(), false);
  assert.equal(h.ctx.toolSensorProbeState, null);
});

test('startToolSensorProbe() refuses when the machine has NOT been homed recently - machine coordinates (G53) are meaningless otherwise, not just wrong', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.status.machine.modals.homedRecently = false;
  const before = h.written.length;

  assert.equal(h.ctx.startToolSensorProbe(), false);

  assert.equal(h.ctx.toolSensorProbeState, null);
  assert.ok(h.emitted.some((e) => e[0] === 'data' && e[1].type === 'error' && /[Hh]ome/.test(e[1].response)), JSON.stringify(h.emitted));
  assert.equal(h.written.length, before, 'no G53 move was ever sent against an unhomed origin');
});

test('startToolSensorProbe() refuses when homedRecently is missing entirely (older/partial status object), not just when explicitly false', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  delete h.ctx.status.machine.modals.homedRecently;

  assert.equal(h.ctx.startToolSensorProbe(), false);
});

test('startToolSensorProbe() succeeds once homedRecently is true again (homing fixes the refusal, not a permanent lock)', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.status.machine.modals.homedRecently = false;
  assert.equal(h.ctx.startToolSensorProbe(), false, 'precondition: refused while unhomed');

  h.ctx.status.machine.modals.homedRecently = true;
  assert.equal(h.ctx.startToolSensorProbe(), true);
});

test('startToolSensorProbe() refuses when no sensor location is configured, and emits an error for the UI', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = null;
  const before = h.written.length;
  assert.equal(h.ctx.startToolSensorProbe(), false);
  assert.equal(h.ctx.toolSensorProbeState, null);
  assert.ok(h.emitted.some((e) => e[0] === 'data' && e[1].type === 'error'), JSON.stringify(h.emitted));
  assert.equal(h.written.length, before, 'nothing further was written to the port');
});

test('startToolSensorProbe() refuses a SECOND call while a sequence is already in progress (no double-start)', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  assert.equal(h.ctx.startToolSensorProbe(), true);
  const queueBefore = h.ctx.toolChangeWizardQueue.slice();
  assert.equal(h.ctx.startToolSensorProbe(), false, 'second call must be refused');
  assert.deepEqual(h.ctx.toolChangeWizardQueue, queueBefore, 'the in-progress sequence must not be clobbered');
});

test('startToolSensorProbe() refuses and leaves toolSensorProbeState null if startToolChangeWizardSend itself refuses (e.g. sentBuffer not drained)', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.sentBuffer.push('G1 X1'); // force the precondition Commit 3 already guards against
  assert.equal(h.ctx.startToolSensorProbe(), false);
  assert.equal(h.ctx.toolSensorProbeState, null, 'must not leak a half-started state on refusal');
});

// ============================================================================
// resumeToolChange: must never be the way fixedToolSensor resumes
// ============================================================================

test('resumeToolChange is refused outright in fixedToolSensor mode, even with nothing in flight', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.resumeToolChangeHandler();
  assert.equal(h.ctx.status.comms.awaitingToolChange, true, 'must still be parked - fixedToolSensor cannot resume this way');
  assert.equal(h.ctx.pendingToolChange.line, 5);
});

test('resumeToolChange is still allowed normally for plain "pause" mode (unaffected by this commit)', () => {
  const h = harness();
  const lines = [];
  for (let i = 1; i <= 10; i++) lines.push(i === 5 ? 'T2 M6' : 'G1 X' + i + ' F500');
  h.ctx.runJob({ isJob: true, data: lines.join('\n'), toolChangeMode: 'pause', fileName: 'part.nc' });
  for (let i = 0; i < 4; i++) h.ackWhicheverIsOutstanding();
  assert.equal(h.ctx.status.comms.awaitingToolChange, true);

  h.ctx.resumeToolChangeHandler();
  assert.equal(h.ctx.status.comms.awaitingToolChange, false);
});

// ============================================================================
// The gcode itself: exact content and order
// ============================================================================

test('the approach+probe batch is exactly 5 lines, in order, using the configured sensor location', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.startToolSensorProbe();
  sameArray(h.ctx.toolChangeWizardQueue, [
    'G53 G0 X100 Y50',
    'G53 G0 Z-25', // -40 + 15 clearance
    'G91',
    'G38.2 Z-25 F100',
    'G90',
  ]);
});

test('baseline (first tool in the job): no G10 is ever sent - only retract + return', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  assert.equal(h.ctx.toolChangeSensorBaseline, null, 'precondition: fresh job, no baseline yet');

  h.runFullSequence(-62.345); // machine-Z of contact

  assert.ok(!h.written.some((s) => /G10/.test(s)), 'no G10 for the baseline capture: ' + JSON.stringify(h.written));
  // workZAtContact = probe.z - wcoZSnapshot = -62.345 - (-50) = -12.345
  // (rounded to 4dp - see the comment in handleToolSensorProbeResult() on
  // why a raw subtraction is not used directly)
  assert.equal(h.ctx.toolChangeSensorBaseline, -12.345);
});

test('compensation (a LATER tool in the same job): G10 L20 P<n> Z<baseline> is sent BEFORE the retract/return moves', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.toolChangeSensorBaseline = -12.345; // simulate an earlier tool already captured it

  h.ctx.startToolSensorProbe();
  for (let i = 0; i < 5; i++) h.ackWhicheverIsOutstanding();
  h.ctx.status.machine.probe = { x: 0, y: 0, z: -70.1, state: 1 };
  h.ctx.handleToolSensorProbeResult(h.ctx.status.machine.probe);

  sameArray(h.ctx.toolChangeWizardQueue, [
    'G10 L20 P1 Z-12.345', // G54 -> P1
    'G53 G0 Z-25',
    'G90 G0 X0 Y0', // origWork captured at park time
    'G90 G0 Z-5',
  ]);
  assert.equal(h.ctx.toolChangeSensorBaseline, -12.345, 'a later tool must NOT overwrite the baseline');
});

test('G10 uses the ACTIVE work coordinate system at sequence start (G55 -> P2), not always G54', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.status.machine.modals.coordinatesys = 'G55';
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.toolChangeSensorBaseline = 3;

  h.ctx.startToolSensorProbe();
  for (let i = 0; i < 5; i++) h.ackWhicheverIsOutstanding();
  h.ctx.status.machine.probe = { x: 0, y: 0, z: -10, state: 1 };
  h.ctx.handleToolSensorProbeResult(h.ctx.status.machine.probe);

  assert.equal(h.ctx.toolChangeWizardQueue[0], 'G10 L20 P2 Z3');
});

test('return position is the position captured at the MOMENT the sequence started, not wherever the machine is when the probe result arrives', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.status.machine.position.work = { x: 12.5, y: -3.25, z: -1 };

  h.ctx.startToolSensorProbe();
  // simulate the machine having "moved" (as it physically would) by the time
  // the result is handled - origWork must already have been snapshotted.
  h.ctx.status.machine.position.work = { x: 999, y: 999, z: 999 };
  for (let i = 0; i < 5; i++) h.ackWhicheverIsOutstanding();
  h.ctx.status.machine.probe = { x: 0, y: 0, z: -50, state: 1 };
  h.ctx.handleToolSensorProbeResult(h.ctx.status.machine.probe);

  const lines = h.ctx.toolChangeWizardQueue;
  assert.equal(lines[lines.length - 2], 'G90 G0 X12.5 Y-3.25');
  assert.equal(lines[lines.length - 1], 'G90 G0 Z-1');
});

// ============================================================================
// Probe FAILURE: no contact within the probe distance
// ============================================================================

test('a failed probe (state <= 0) aborts cleanly: no G10, no retract/return, job stays parked, baseline untouched', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;

  h.ctx.startToolSensorProbe();
  for (let i = 0; i < 5; i++) h.ackWhicheverIsOutstanding();
  const writtenBeforeResult = h.written.length;
  h.ctx.status.machine.probe = { x: 0, y: 0, z: 0, state: 0 };
  h.ctx.handleToolSensorProbeResult(h.ctx.status.machine.probe);

  assert.equal(h.ctx.toolSensorProbeState, null, 'sequence state is cleared so a retry can start fresh');
  assert.equal(h.ctx.toolChangeSensorBaseline, null, 'no baseline was ever derived from a failed probe');
  assert.equal(h.written.length, writtenBeforeResult, 'nothing further was sent after a failed probe');
  assert.equal(h.ctx.status.comms.awaitingToolChange, true, 'job stays parked - never silently resumes uncompensated');
  assert.ok(h.emitted.some((e) => e[0] === 'data' && e[1].type === 'error'), 'an error was surfaced to the UI');
});

test('a prbResult with no toolSensorProbeState active (e.g. an unrelated manual probe wizard) is correctly ignored', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  const before = h.written.length;
  // no startToolSensorProbe() call at all - toolSensorProbeState stays null
  h.ctx.handleToolSensorProbeResult({ x: 1, y: 2, z: 3, state: 1 });
  assert.equal(h.ctx.toolChangeSensorBaseline, null, 'must not mistake a stray probe for this sequence\'s own');
  assert.equal(h.written.length, before, 'nothing further was written to the port');
});

// ============================================================================
// Alarm mid-sequence (e.g. a hard limit, or grbl's own G38.2-fail alarm)
// clears toolSensorProbeState, even though it does NOT dump the main queue.
// ============================================================================

test('an Alarm status report arriving while a sequence is active clears toolSensorProbeState, but leaves the main job parked (no queue dump)', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  const queueLenBefore = h.ctx.gcodeQueue.length; // addQToEnd() may inject extra "$G" entries - not necessarily 10
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.startToolSensorProbe();
  h.ackWhicheverIsOutstanding(); // one line genuinely in flight/acked already

  h.ctx.parseFeedback('<Alarm|>');

  assert.equal(h.ctx.toolSensorProbeState, null, 'a stale sequence must not catch a later, unrelated probe result');
  assert.equal(h.ctx.gcodeQueue.length, queueLenBefore, 'an alarm alone does not dump the main job - operator may Clear Alarm and continue');
  assert.equal(h.ctx.status.comms.awaitingToolChange, true, 'still parked - the operator must explicitly retry or stop');
});

// ============================================================================
// Successful completion: hands control back to the main job correctly
// ============================================================================

test('on success, awaitingToolChange clears and the main job resumes on its own (the gcode right after the M6 is sent, unattended)', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;

  h.runFullSequence(-62.345);

  assert.equal(h.ctx.status.comms.awaitingToolChange, false);
  assert.equal(h.ctx.pendingToolChange, null);
  assert.equal(h.ctx.toolSensorProbeState, null);
  assert.equal(h.written[h.written.length - 1].trim(), '$G', 'the main job continued on its own, right after the M6');
});

test('END-TO-END: the main job\'s gcodeQueue/queuePointer/sentBuffer/toolChangeQIndexes are completely untouched by a full probe sequence, including a SECOND not-yet-reached M6', () => {
  const h = harness();
  const lines = [];
  for (let i = 1; i <= 20; i++) lines.push(i === 5 ? 'T2 M6' : (i === 15 ? 'T3 M6' : 'G1 X' + i + ' F500'));
  h.ctx.runJob({ isJob: true, data: lines.join('\n'), toolChangeMode: 'fixedToolSensor', fileName: 'part.nc' });
  for (let i = 0; i < 4; i++) h.ackWhicheverIsOutstanding();
  assert.equal(h.ctx.status.comms.awaitingToolChange, true);

  const queueSnapshot = [...h.ctx.gcodeQueue];
  const indexesSnapshot = new Map(h.ctx.toolChangeQIndexes);

  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.runFullSequence(-62.345);

  // Note: queuePointer DOES advance by the end of this - that is the
  // sequence correctly resuming the main job (send1Q() sends the next real
  // line once handed back control). What must NOT happen is the wizard
  // itself ever touching the queue contents while it runs - checked below.
  sameArray(h.ctx.gcodeQueue, queueSnapshot, 'main gcodeQueue contents never touched');
  assert.equal(h.ctx.sentBuffer.length, 1, 'exactly one line now in flight - the resumed job\'s next line');
  assert.equal(h.ctx.toolChangeQIndexes.size, indexesSnapshot.size, 'the SECOND M6 (line 15) is still tracked');
  assert.ok(Array.from(h.ctx.toolChangeQIndexes.entries()).some(([, v]) => v.line === 15), 'the second M6 survives');
});

test('a SECOND M6 later in the same job correctly applies compensation (baseline from the FIRST tool, not re-captured)', () => {
  const h = harness();
  const lines = [];
  for (let i = 1; i <= 20; i++) lines.push(i === 5 ? 'T2 M6' : (i === 15 ? 'T3 M6' : 'G1 X' + i + ' F500'));
  h.ctx.runJob({ isJob: true, data: lines.join('\n'), toolChangeMode: 'fixedToolSensor', fileName: 'part.nc' });
  h.ctx.toolChangeSensorLocation = sensorLoc; // set AFTER runJob - runJob() resets it fresh per tracked job
  for (let i = 0; i < 4; i++) h.ackWhicheverIsOutstanding();

  h.runFullSequence(-62.345); // first tool: baseline capture
  assert.equal(h.ctx.toolChangeSensorBaseline, -12.345);

  // drain forward to the second M6 - one ack at a time, whichever sender
  // (main job, right after this resume) currently has something outstanding.
  for (let i = 0; i < 50 && !h.ctx.status.comms.awaitingToolChange; i++) {
    h.ackWhicheverIsOutstanding();
  }
  assert.equal(h.ctx.status.comms.awaitingToolChange, true, 'reached the second M6');
  assert.equal(h.ctx.pendingToolChange.line, 15);

  h.runFullSequence(-80); // second tool: must compensate, not re-baseline
  assert.ok(h.written.some((s) => s.trim() === 'G10 L20 P1 Z-12.345'), 'compensation used the FIRST tool\'s baseline: ' + JSON.stringify(h.written));
  assert.equal(h.ctx.toolChangeSensorBaseline, -12.345, 'baseline is still the first tool\'s value');
});

// ============================================================================
// Interruption mid-sequence, with REAL G53/G38.2 lines already sent/acked -
// the point the user singled out as needing proof, not assumption.
// ============================================================================

test('INTERRUPTION: stopPort() after the approach moves are sent but BEFORE the probe result arrives freezes jobRecovery at the M6 line and fully resets all sequencer state', () => {
  const h = harness();
  h.parkAtM6(20, 10);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.startToolSensorProbe();
  // ack the two G53 approach moves for real (genuine machine motion already issued)
  h.ackWhicheverIsOutstanding();
  h.ackWhicheverIsOutstanding();
  assert.ok(h.ctx.toolSensorProbeState, 'precondition: sequence genuinely mid-flight');

  h.ctx.port.isOpen = false;
  h.ctx.stopPort();

  const rec = h.ctx.jobRecovery.peek();
  assert.ok(rec, 'a recovery record survives the dump');
  assert.equal(rec.state, 'interrupted');
  assert.equal(rec.resumeLine, 10, 'frozen at the M6 line itself, not wherever the sequencer had reached');

  assert.equal(h.ctx.toolSensorProbeState, null);
  assert.equal(h.ctx.toolChangeWizardQueue.length, 0);
  assert.equal(h.ctx.toolChangeWizardPointer, 0);
  assert.equal(h.ctx.toolChangeWizardSentBuffer.length, 0);
  assert.equal(h.ctx.toolChangeWizardDoneCallback, null);
  assert.equal(h.ctx.toolChangeSensorBaseline, null);
  assert.equal(h.ctx.status.comms.awaitingToolChange, false);
  assert.equal(h.ctx.pendingToolChange, null);
  assert.equal(h.ctx.toolChangeQIndexes.size, 0);
  assert.equal(h.ctx.gcodeQueue.length, 0, 'the main job queue is also genuinely dumped');
  assert.equal(h.ctx.sentBuffer.length, 0);
});

test('INTERRUPTION: Stop (the ribbon button) mid-probe (after G91/G38.2 have been sent, before the result) resets everything the same way', () => {
  const h = harness();
  h.parkAtM6(20, 10);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.startToolSensorProbe();
  for (let i = 0; i < 4; i++) h.ackWhicheverIsOutstanding(); // through G91 and G38.2, before G90/result
  assert.ok(h.ctx.toolSensorProbeState);

  h.ctx.stop({ stop: true, jog: false, abort: false });

  const rec = h.ctx.jobRecovery.peek();
  assert.ok(rec);
  assert.equal(rec.state, 'stopped');
  assert.equal(rec.resumeLine, 10);
  assert.equal(h.ctx.toolSensorProbeState, null);
  assert.equal(h.ctx.toolChangeSensorBaseline, null);
  assert.equal(h.ctx.gcodeQueue.length, 0);
});

test('INTERRUPTION: Clear Alarm method 2 DURING the return phase (after a successful probe, before the compensation/retract is fully acked) also resets cleanly', () => {
  const h = harness();
  h.parkAtM6(20, 10);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.startToolSensorProbe();
  for (let i = 0; i < 5; i++) h.ackWhicheverIsOutstanding(); // approach+probe fully acked
  h.ctx.status.machine.probe = { x: 0, y: 0, z: -62.345, state: 1 };
  h.ctx.handleToolSensorProbeResult(h.ctx.status.machine.probe); // enters 'returning', sends retract+return
  assert.equal(h.ctx.toolSensorProbeState.phase, 'returning');
  h.ackWhicheverIsOutstanding(); // only the FIRST return line acked - genuinely mid-return

  h.ctx.clearAlarmHandler(2);

  assert.equal(h.ctx.toolSensorProbeState, null);
  assert.equal(h.ctx.toolChangeWizardQueue.length, 0);
  assert.equal(h.ctx.toolChangeWizardSentBuffer.length, 0);
  assert.equal(h.ctx.toolChangeWizardDoneCallback, null, 'the pending onDrained->send1Q() handoff must not fire later on dead state');
  assert.equal(h.ctx.gcodeQueue.length, 0);
  const rec = h.ctx.jobRecovery.peek();
  assert.ok(rec);
  assert.equal(rec.resumeLine, 10);
});

test('a baseline interrupted mid-sequence must NOT leave a half-computed baseline lying around for the next job', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.startToolSensorProbe();
  for (let i = 0; i < 5; i++) h.ackWhicheverIsOutstanding();
  h.ctx.status.machine.probe = { x: 0, y: 0, z: -62.345, state: 1 };
  h.ctx.handleToolSensorProbeResult(h.ctx.status.machine.probe); // baseline computed, return phase started
  assert.notEqual(h.ctx.toolChangeSensorBaseline, null, 'precondition: baseline WAS computed before the interruption');

  h.ctx.stop({ stop: true, jog: false, abort: false });

  assert.equal(h.ctx.toolChangeSensorBaseline, null, 'must be wiped - a later job must never silently inherit it');
});

// ============================================================================
// Dual-buffer safety (Commit 3's own invariant, reconfirmed here): at the
// moment the "done" handoff fires send1Q(), the main sentBuffer must still
// be empty - nothing from the wizard pipeline is still in flight.
// ============================================================================

test('at the moment the sequence hands back control, toolChangeWizardSentBuffer is empty BEFORE send1Q() is invoked for the main job', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;

  // Instrument send1Q to capture the wizard buffer's state at the instant
  // it is called.
  const realSend1Q = h.ctx.send1Q;
  let wizardBufferLenAtHandoff = null;
  h.ctx.send1Q = function() {
    if (wizardBufferLenAtHandoff === null) wizardBufferLenAtHandoff = h.ctx.toolChangeWizardSentBuffer.length;
    return realSend1Q.apply(h.ctx, arguments);
  };

  h.runFullSequence(-62.345);

  assert.equal(wizardBufferLenAtHandoff, 0, 'send1Q() must never run while the wizard still has something in flight');
});

test('the done-callback requires BOTH toolChangeWizardSentBuffer empty AND the pointer caught up - a disconnect mid-sequence (sentBuffer empties without anything new being sent) must NOT fire it early', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc;
  let onDoneCalls = 0;
  assert.equal(h.ctx.startToolChangeWizardSend(['G91', 'G38.2 Z-25 F100', 'G90'], () => { onDoneCalls++; }), true);

  h.ackWhicheverIsOutstanding(); // 'G91' acked, sendToolChangeWizardQ() sends 'G38.2...'
  assert.equal(onDoneCalls, 0);

  // Simulate the connection dropping right as the SECOND line's "ok" arrives:
  // sendToolChangeWizardQ()'s own guard (status.comms.connectionStatus > 0)
  // means it will NOT send the third line, even though one is still queued -
  // toolChangeWizardSentBuffer goes to 0 with toolChangeWizardPointer (2)
  // still short of toolChangeWizardQueue.length (3).
  h.ctx.status.comms.connectionStatus = 0;
  h.ackWhicheverIsOutstanding();

  assert.equal(h.ctx.toolChangeWizardSentBuffer.length, 0, 'precondition: nothing in flight');
  assert.ok(h.ctx.toolChangeWizardPointer < h.ctx.toolChangeWizardQueue.length, 'precondition: the sequence is NOT actually finished');
  assert.equal(onDoneCalls, 0, 'must not have fired while a line is still genuinely unsent');
});

// ============================================================================
// runJob(): the sensor fields are re-validated independently, fresh per job
// ============================================================================

test("runJob(): a well-formed object.toolSensorLocation is adopted as-is", () => {
  const h = harness();
  h.ctx.runJob({ isJob: true, data: 'G1 X1 F500', toolChangeMode: 'fixedToolSensor', toolSensorLocation: { x: 1, y: 2, z: 3 }, toolSensorFirstBehaviour: 'always-probe' });
  sameObject(h.ctx.toolChangeSensorLocation, { x: 1, y: 2, z: 3 });
  assert.equal(h.ctx.toolChangeSensorFirstBehaviour, 'always-probe');
});

test('runJob(): a malformed object.toolSensorLocation (missing field, NaN, non-number) is treated as not configured at all', () => {
  const h = harness();
  for (const bad of [{ x: 1, y: 2 }, { x: 1, y: 2, z: NaN }, { x: '1', y: 2, z: 3 }, null, undefined, 'garbage']) {
    h.ctx.toolChangeSensorLocation = sensorLoc; // simulate a leftover from a previous job
    h.ctx.runJob({ isJob: true, data: 'G1 X1 F500', toolChangeMode: 'fixedToolSensor', toolSensorLocation: bad });
    assert.equal(h.ctx.toolChangeSensorLocation, null, JSON.stringify(bad));
  }
});

test("runJob(): an unrecognised object.toolSensorFirstBehaviour falls back to 'always-wizard'", () => {
  const h = harness();
  for (const bad of ['ALWAYS-PROBE', 'bogus', '', undefined, 0]) {
    h.ctx.runJob({ isJob: true, data: 'G1 X1 F500', toolChangeMode: 'fixedToolSensor', toolSensorFirstBehaviour: bad });
    assert.equal(h.ctx.toolChangeSensorFirstBehaviour, 'always-wizard', JSON.stringify(bad));
  }
});

test('runJob(): job 1 captures a baseline; job 2 (no reset in between) starts completely fresh - no stale baseline, no stale location', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.toolChangeSensorLocation = sensorLoc; // set AFTER parkAtM6 - runJob() resets it fresh per tracked job
  h.runFullSequence(-62.345);
  assert.notEqual(h.ctx.toolChangeSensorBaseline, null, 'precondition: job 1 captured a baseline');

  h.ctx.runJob({ isJob: true, data: 'G1 X1 F500', toolChangeMode: 'fixedToolSensor' }); // job 2: no sensor fields sent at all
  assert.equal(h.ctx.toolChangeSensorBaseline, null, 'job 2 must not inherit job 1\'s baseline');
  assert.equal(h.ctx.toolChangeSensorLocation, null, 'job 2 must not inherit job 1\'s location either');
});

test('runJob(): an UNTRACKED run (isJob:false) never touches the sensor fields, same as toolChangeMode', () => {
  const h = harness();
  h.ctx.toolChangeSensorLocation = sensorLoc;
  h.ctx.toolChangeSensorBaseline = -5;
  // Two lines, not one - a single-line job completes (and genuinely dumps
  // the queue, resetting toolChangeSensorBaseline along with it, by design)
  // within this same runJob() call, which would confound "untouched" with
  // "wiped by a real completion" here.
  h.ctx.runJob({ isJob: false, data: 'G1 X1 F500\nG1 X2 F500', toolSensorLocation: { x: 9, y: 9, z: 9 } });
  sameObject(h.ctx.toolChangeSensorLocation, sensorLoc, 'untouched');
  assert.equal(h.ctx.toolChangeSensorBaseline, -5, 'untouched');
});
