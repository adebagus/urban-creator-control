// Tool-change wizard, Tahap 1b-ii, Commit 3: the separate pipeline for
// Fixed Tool Sensor's automatic probe gcode (toolChangeWizardQueue/Pointer/
// SentBuffer, sendToolChangeWizardQ(), startToolChangeWizardSend(),
// routeOkAndAdvance()) - the highest-risk commit in Tahap 1b-ii, since it
// touches the same "ok" handler every job in the app goes through.
//
// Everything here was PROVEN with a throwaway prototype before this file
// was written, not assumed safe from the design alone (the same lesson as
// the z-index and double-completion incidents):
//   TEST 1 - in normal operation, can the "two buffers both have an
//            outstanding entry" state ever arise by itself? (No - proven,
//            not assumed, by send1Q()'s own gate.)
//   TEST 2 - if that state is FORCED anyway (a hypothetical other bug),
//            what does the "ok" routing actually do? (It silently strands
//            the main job's entry forever - this is WHY the guard in
//            startToolChangeWizardSend() exists, not a theoretical worry.)
//   TEST 3 - does the REAL startToolChangeWizardSend() guard actually
//            refuse before that state can ever form?
// Plus the buffer-full / deadlock question raised during Commit 3's review:
// a gcode line longer than a completely empty RX buffer can NEVER be sent
// (nothing to retry against, since nothing was ever in flight to ack) - a
// REAL, reproduced deadlock for an adversarial case, even though no
// realistic probe gcode line comes remotely close to the limit.
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

function harness(rxBufferSize) {
  const written = [];
  const emitted = [];
  const logs = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-tc-sep-'));
  const ctx = {
    gcodeQueue: [], queuePointer: 0, sentBuffer: [], statusLoop: null, queueCounter: null,
    toolChangeQIndexes: new Map(), pendingToolChange: null, toolChangeWizardEmitted: false, toolChangeMode: 'pause',
    toolChangeWizardQueue: [], toolChangeWizardPointer: 0, toolChangeWizardSentBuffer: [],
    fluidncConfig: '',
    status: {
      comms: { connectionStatus: 2, blocked: false, paused: false, awaitingToolChange: false, runStatus: 'Idle', queue: 0, alarm: '', interfaces: { type: 'usb' } },
      machine: { modals: {}, firmware: { type: 'grbl', platform: 'grbl', rxBufferSize: rxBufferSize || 254, blockBufferSize: '35', version: '', date: '', buffer: '' }, tool: { nexttool: {} } },
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
      ['isToolChangeLine', 'toolChangeToolNumber', 'addQToEnd', 'send1Q', 'BufferSpace', 'machineSend', 'runJob',
        'toolChangeWizardBufferSpace', 'machineSendToolChangeWizard', 'sendToolChangeWizardQ',
        'startToolChangeWizardSend', 'routeOkAndAdvance']
        .map(grabFunction).join('\n'),
    ctx
  );
  return {
    ctx, written, emitted, logs,
    ack() { ctx.sentBuffer.shift(); ctx.status.comms.blocked = false; ctx.send1Q(); },
    // the REAL "ok" routing, not the ack() shortcut above - this is what
    // Commit 3 actually added, and none of the ack() helpers elsewhere in
    // this suite exercise it (they all bypass it by shifting sentBuffer
    // directly), so this file is the only place it is tested directly.
    realOk(command) { return ctx.routeOkAndAdvance(command); },
    parkAtM6(n, toolChangeAtLine) {
      const lines = [];
      for (let i = 1; i <= n; i++) lines.push(i === toolChangeAtLine ? 'T2 M6' : 'G1 X' + i + ' F500');
      ctx.runJob({ isJob: true, data: lines.join('\n'), toolChangeMode: 'pause', fileName: 'part.nc' });
      for (let i = 0; i < toolChangeAtLine - 1; i++) this.ack();
      assert.equal(ctx.status.comms.awaitingToolChange, true, 'setup: parked at the M6');
      assert.equal(ctx.sentBuffer.length, 0, 'setup: main sentBuffer genuinely drained');
    },
  };
}

// ============================================================================
// TEST 1: normal operation never produces the adversarial state
// ============================================================================

test('TEST 1: in normal operation, main sentBuffer is ALREADY empty by the time awaitingToolChange becomes true - nothing can repopulate it while parked', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  // send1Q()'s own gate (!status.comms.awaitingToolChange) means calling it
  // more, or acking more (nothing to ack - sentBuffer is already empty), can
  // never put anything new into sentBuffer while still parked.
  for (let i = 0; i < 10; i++) h.ctx.send1Q();
  assert.equal(h.ctx.sentBuffer.length, 0);
  assert.equal(h.written.filter((w) => /M0*6/i.test(w)).length, 0, 'M6 still never reached the port');
});

// ============================================================================
// TEST 2: if the adversarial state is FORCED anyway, what does routing do?
// (Documents the exact failure mode the guard in TEST 3 exists to prevent -
// this is proof the guard is load-bearing, not decoration.)
// ============================================================================

test('TEST 2: if both buffers are FORCED to hold something at once, routeOkAndAdvance() strands the main job\'s entry - this is exactly why startToolChangeWizardSend() refuses to let that happen', () => {
  const h = harness();
  h.parkAtM6(10, 5);

  // Artificially force the precondition violation - bypassing every gate,
  // exactly as the investigation before this commit did.
  h.ctx.sentBuffer.push('G1 X9 F500 (STALE - should already have been acked)');
  h.ctx.toolChangeWizardSentBuffer.push('G38.2 Z-25 F100 (wizard probe line)');

  const command = h.realOk('whatever the controller echoed');

  assert.equal(h.ctx.toolChangeWizardSentBuffer.length, 0, 'the wizard entry WAS consumed');
  assert.equal(h.ctx.sentBuffer.length, 1, 'the main job entry is now PERMANENTLY stuck - routeOkAndAdvance() never looked at it');
  assert.deepEqual(h.ctx.sentBuffer, ['G1 X9 F500 (STALE - should already have been acked)']);
});

// ============================================================================
// TEST 3: the REAL guard refuses before that state can ever form
// ============================================================================

test('TEST 3: startToolChangeWizardSend() refuses when the main job is not actually parked (awaitingToolChange false)', () => {
  const h = harness();
  h.ctx.status.comms.awaitingToolChange = false;
  const started = h.ctx.startToolChangeWizardSend(['G53 G0 Z-5']);
  assert.equal(started, false);
  assert.equal(h.ctx.toolChangeWizardQueue.length, 0);
  assert.ok(h.logs.some((l) => /not awaiting a tool change/.test(l)));
});

test('TEST 3: startToolChangeWizardSend() refuses when the main job\'s sentBuffer is not genuinely drained', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.sentBuffer.push('STALE'); // force the precondition violation, same as TEST 2

  const started = h.ctx.startToolChangeWizardSend(['G53 G0 Z-5']);

  assert.equal(started, false);
  assert.equal(h.ctx.toolChangeWizardQueue.length, 0, 'nothing was queued - TEST 2\'s corruption can never happen if this refuses first');
  assert.ok(h.logs.some((l) => /main job sentBuffer not drained/.test(l)));
});

test('TEST 3: startToolChangeWizardSend() succeeds and sends the first line when both preconditions hold', () => {
  const h = harness();
  h.parkAtM6(10, 5);

  const started = h.ctx.startToolChangeWizardSend(['G91 G21', 'G53 G0 Z-5']);

  assert.equal(started, true);
  assert.equal(h.written[h.written.length - 1].trim(), 'G91 G21', 'the first line was sent immediately');
  assert.deepEqual(h.ctx.toolChangeWizardSentBuffer, ['G91 G21']);
  assert.equal(h.ctx.toolChangeWizardPointer, 1);
});

// ============================================================================
// The buffer-full / deadlock question (raised during Commit 3's review)
// ============================================================================

test('DEADLOCK PROOF: a line longer than a COMPLETELY EMPTY buffer can never be sent - startToolChangeWizardSend() must refuse it upfront, not queue it and hope', () => {
  const h = harness(); // normal buffer, so parking at M6 works normally
  h.parkAtM6(10, 5);
  h.ctx.status.machine.firmware.rxBufferSize = 10; // THEN shrink it, as if this controller's buffer genuinely were this small
  const longLine = 'G38.2 Z-25 F100'; // 15 bytes > (10-1)=9 available in a totally empty buffer

  const started = h.ctx.startToolChangeWizardSend([longLine]);

  assert.equal(started, false, 'must refuse - queuing this would deadlock forever (nothing would ever be sent, so no "ok" would ever arrive to retry it)');
  assert.equal(h.ctx.toolChangeWizardQueue.length, 0);
  assert.ok(h.logs.some((l) => /does not fit even in a fully empty buffer/.test(l)));
});

test('DEADLOCK PROOF (the naive version, for comparison): without the guard, the same line is accepted and NEVER sent, no matter how many "ok"s arrive', () => {
  const h = harness();
  h.parkAtM6(10, 5);
  h.ctx.status.machine.firmware.rxBufferSize = 10;
  const writtenBefore = h.written.length;
  // Bypass startToolChangeWizardSend()'s guard entirely - push directly, the
  // way a version of this code WITHOUT the guard would have let it through.
  h.ctx.toolChangeWizardQueue = ['G38.2 Z-25 F100'];
  h.ctx.toolChangeWizardPointer = 0;
  h.ctx.sendToolChangeWizardQ();

  assert.equal(h.written.length, writtenBefore, 'nothing new was sent - the line does not fit even in a fully empty 10-byte buffer');
  assert.equal(h.ctx.toolChangeWizardSentBuffer.length, 0, 'nothing is "in flight" either');

  for (let i = 0; i < 20; i++) h.realOk('irrelevant'); // 20 forced "ok"s - nothing to shift, nothing changes
  assert.equal(h.written.length, writtenBefore, 'CONFIRMED: still never sent, no matter how many acks arrive - this is the deadlock the guard in startToolChangeWizardSend() exists to prevent');
});

test('realistic probe gcode (worst-case coordinates) fits a realistic minimum buffer with large headroom - concrete byte counts, not a guess', () => {
  const realisticLines = [
    'G91 G21',
    'G53 G0 Z-5',
    'G53 G0 X-9999.999 Y-9999.999',
    'G53 G0 Z-9999.999',
    'G91 G21',
    'G38.2 Z-25 F100',
    'G0 Z2',
    'G38.2 Z-10 F50',
    'G4 P0.3',
    'G10 L20 P0 Z-9999.9999',
    'G90 G0 X-9999.999 Y-9999.999',
    'G90 G0 Z-9999.999',
  ];
  const minRealisticEmptyBuffer = 127 - 1; // GRBL_RX_BUFFER_SIZE - 1, the smallest this app ever assumes
  const worst = Math.max(...realisticLines.map((l) => l.length));
  assert.ok(worst < minRealisticEmptyBuffer, 'worst realistic line (' + worst + ' bytes) must fit the smallest realistic empty buffer (' + minRealisticEmptyBuffer + ' bytes)');
  assert.ok(minRealisticEmptyBuffer - worst > 90, 'expected a large safety margin (>90 bytes), found ' + (minRealisticEmptyBuffer - worst));

  // And it actually completes end-to-end, not just "fits one at a time".
  const h = harness(127);
  h.parkAtM6(10, 5);
  const writtenBefore = h.written.length; // parking itself already sent a few main-job lines
  assert.equal(h.ctx.startToolChangeWizardSend(realisticLines), true);
  let guard = 0;
  while (h.ctx.toolChangeWizardSentBuffer.length > 0 || h.ctx.toolChangeWizardPointer < realisticLines.length) {
    h.realOk('ok');
    if (++guard > 100) throw new Error('did not converge - possible deadlock');
  }
  const wizardWritten = h.written.slice(writtenBefore);
  assert.equal(wizardWritten.length, realisticLines.length, 'every realistic line was eventually sent');
  assert.deepEqual(wizardWritten.map((w) => w.trim()), realisticLines);
});

// ============================================================================
// End-to-end: the main job's own state is UNTOUCHED throughout the whole
// wizard sequence - the entire point of building a separate pipeline.
// ============================================================================

test('END-TO-END: running a full wizard probe sequence while parked leaves the main job\'s gcodeQueue/queuePointer/sentBuffer/toolChangeQIndexes completely untouched', () => {
  const h = harness();
  // A SECOND M6 later in the file, to prove it is NOT wiped by anything the
  // wizard does (the original bug this whole commit exists to avoid).
  const lines = [];
  for (let i = 1; i <= 20; i++) lines.push(i === 5 ? 'T2 M6' : (i === 15 ? 'T3 M6' : 'G1 X' + i + ' F500'));
  h.ctx.runJob({ isJob: true, data: lines.join('\n'), toolChangeMode: 'pause', fileName: 'part.nc' });
  for (let i = 0; i < 4; i++) h.ack();
  assert.equal(h.ctx.status.comms.awaitingToolChange, true);

  const gcodeQueueBefore = h.ctx.gcodeQueue.slice();
  const queuePointerBefore = h.ctx.queuePointer;
  const toolChangeQIndexesBefore = [...h.ctx.toolChangeQIndexes.entries()];

  assert.equal(h.ctx.startToolChangeWizardSend(['G91 G21', 'G53 G0 Z-5', 'G38.2 Z-25 F100']), true);
  let guard = 0;
  while (h.ctx.toolChangeWizardSentBuffer.length > 0 || h.ctx.toolChangeWizardPointer < 3) {
    h.realOk('ok');
    if (++guard > 50) throw new Error('did not converge');
  }

  assert.deepEqual(h.ctx.gcodeQueue, gcodeQueueBefore, 'the main job\'s queue is byte-for-byte unchanged');
  assert.equal(h.ctx.queuePointer, queuePointerBefore, 'the main job\'s pointer never moved');
  assert.equal(h.ctx.sentBuffer.length, 0, 'the main job\'s sentBuffer is still empty - the wizard never touched it');
  assert.deepEqual([...h.ctx.toolChangeQIndexes.entries()], toolChangeQIndexesBefore, 'the SECOND M6 (line 15) is still correctly tracked - not wiped');
  assert.equal(h.ctx.status.comms.awaitingToolChange, true, 'still parked - only resumeToolChange (not built yet) may clear this');
});
