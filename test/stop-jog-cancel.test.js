// The orange "Stop Jog" button (and a released continuous-jog key) sends stop({jog:true}) = a jog-cancel, 0x85.
// The controller only honours 0x85 while it is JOGGING; during a job it is ignored. stop() used to dump the server's
// queue and report "Connected" anyway, so the machine kept running what was already in its RX buffer / planner (many
// seconds for long Surfacing passes) with every Stop button disabled.
//
// Now, when a job is running, stop({jog:true}) is a FULL stop: "!" (hold), then 0x18 (reset) after the same 200 ms as
// the ribbon Stop Job. With no job (a plain manual jog) it stays exactly the old 0x85 alone.
//
// These tests run the REAL stop() / runJob / send1Q / machineSend / addQRealtime from index.js (vm, fake port) and read
// what is written to the port.
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
  assert.notEqual(start, -1, 'cannot extract function ' + name);
  const end = INDEX_SRC.indexOf('\n}\n', start);
  return INDEX_SRC.slice(start, end + 2);
}
const MODAL_VARS = INDEX_SRC.match(/var modalCommands = \[[^\]]*\]\n/)[0] + INDEX_SRC.match(/var modalCommandsRegExp = [^\n]*\n/)[0];

const HOLD = '!', RESET = String.fromCharCode(0x18), JOGCANCEL = String.fromCharCode(0x85);
const JOG = { stop: false, jog: true, abort: false };
const STOP_JOB = { stop: true, jog: false, abort: false };

function harness() {
  const written = [];
  const timers = [];
  const emitted = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-stopjog-'));
  const ctx = {
    gcodeQueue: [], queuePointer: 0, sentBuffer: [], queueCounter: null, toolChangeQIndexes: new Map(), toolChangeWizardQueue: [], toolChangeWizardPointer: 0, toolChangeWizardSentBuffer: [], VALID_TOOLCHANGE_MODES: ['ignore', 'fixedToolSensor'], VALID_TOOLSENSOR_FIRST_BEHAVIOURS: ['always-wizard', 'always-probe', 'prompt'],
    status: {
      comms: { connectionStatus: 2, blocked: false, paused: false, runStatus: 'Idle', queue: 0, alarm: '', interfaces: { type: 'usb' } },
      machine: { modals: {}, firmware: { type: 'grbl', platform: 'grbl', rxBufferSize: 254, blockBufferSize: '35', version: '', date: '', buffer: '' }, tool: { nexttool: {} } },
    },
    fluidncConfig: '', jobStartTime: false, uploadedgcode: '', jobCompletedMsg: '', laserTestOn: false,
    jogWindow: null, debug_log() {}, serialLog() {}, setInterval() { return 1; }, clearInterval() {},
    setTimeout(fn) { timers.push(fn); return 1; },
    port: { isOpen: true, write(s) { written.push(s); } },
    io: { sockets: { emit(ev, d) { emitted.push([ev, d]); } } },
  };
  ctx.jobRecovery = createJobRecovery({
    getDir: () => dir, autoTimer: false,
    getFirstUnackedQ: () => (ctx.gcodeQueue.length === 0 ? -1 : Math.max(0, ctx.queuePointer - ctx.sentBuffer.length)),
    getPlannerBlocks: () => 35,
  });
  vm.createContext(ctx);
  vm.runInContext(MODAL_VARS + ['isToolChangeLine', 'toolChangeToolNumber', 'addQToEnd', 'addQRealtime', 'send1Q', 'BufferSpace', 'machineSend', 'isValidSensorLocation', 'runJob', 'announceJobStopped', 'stop'].map(grabFunction).join('\n'), ctx);
  const h = {
    ctx, written, emitted,
    // "ok" for the oldest line in flight
    ack() { ctx.sentBuffer.shift(); ctx.status.comms.blocked = false; ctx.send1Q(); },
    startJob(n, extra) {
      const lines = [];
      for (let i = 1; i <= n; i++) lines.push('G1 X' + i + ' F500');
      ctx.runJob(Object.assign({ isJob: true, data: lines.join('\n') }, extra));
    },
    // what reached the port, ignoring the job's own G-code lines
    realtime() { return written.filter((w) => w === HOLD || w === RESET || w === JOGCANCEL); },
    fireTimers() { while (timers.length) timers.shift()(); },
    pendingTimers: () => timers.length,
  };
  return h;
}

// a job that is streaming: many lines, a few acknowledged, the rest still queued
function runningJob() {
  const h = harness();
  h.startJob(200);
  for (let i = 0; i < 20; i++) h.ack();
  assert.equal(h.ctx.status.comms.connectionStatus, 3, 'precondition: streaming');
  return h;
}

// --------------------------------------------------------------------------- the fix

test('job running + Stop Jog: "!" goes out at once and the reset (0x18) follows after the same delay as Stop Job - not just 0x85', () => {
  const h = runningJob();
  h.written.length = 0;
  h.ctx.stop(JOG);
  assert.deepEqual(h.realtime(), [HOLD], 'hold immediately');
  assert.equal(h.pendingTimers(), 1, 'the reset is scheduled (setTimeout), like Stop Job');
  h.fireTimers();
  assert.deepEqual(h.realtime(), [HOLD, RESET], 'then the soft reset');
  assert.ok(!h.written.includes(JOGCANCEL), 'the useless 0x85 is not what stops a job');
});

test('job running + Stop Jog leaves the same server state as Stop Job (queue dumped, Connected, job time reset)', () => {
  const a = runningJob(); a.ctx.stop(JOG);
  const b = runningJob(); b.ctx.stop(STOP_JOB);
  for (const h of [a, b]) {
    assert.equal(h.ctx.gcodeQueue.length, 0);
    assert.equal(h.ctx.sentBuffer.length, 0);
    assert.equal(h.ctx.queuePointer, 0);
    assert.equal(h.ctx.status.comms.connectionStatus, 2);
    assert.equal(h.ctx.jobStartTime, false);
  }
  assert.deepEqual(a.realtime(), b.realtime().filter((x) => x !== RESET), 'same realtime bytes before the delayed reset');
});

test('a PAUSED job (connectionStatus 4) + Stop Jog is also a full stop', () => {
  const h = runningJob();
  h.ctx.status.comms.connectionStatus = 4; h.ctx.status.comms.paused = true;
  h.written.length = 0;
  h.ctx.stop(JOG); h.fireTimers();
  assert.deepEqual(h.realtime(), [HOLD, RESET]);
});

test('every line already SENT but the controller not Idle yet (the tail of a job) + Stop Jog is a full stop', () => {
  const h = harness();
  h.startJob(6);
  for (let i = 0; i < 12 && h.ctx.gcodeQueue.length; i++) h.ack();
  assert.equal(h.ctx.gcodeQueue.length, 0, 'precondition: the queue is already dumped (all lines sent)');
  assert.equal(h.ctx.status.comms.connectionStatus, 2);
  assert.ok(h.ctx.jobRecovery.isTracking(), 'precondition: the job is still tracked (controller still moving)');
  h.written.length = 0;
  h.ctx.stop(JOG); h.fireTimers();
  assert.deepEqual(h.realtime(), [HOLD, RESET], 'the tail keeps running in the controller - it must be stopped');
});

test('an untracked job (isJob:false: probing / bounding box) that is streaming + Stop Jog is a full stop too', () => {
  const h = harness();
  h.ctx.runJob({ isJob: false, data: 'G0 X1 F500\nG0 X2\nG0 X3\nG0 X4' });
  assert.equal(h.ctx.status.comms.connectionStatus, 3);
  h.written.length = 0;
  h.ctx.stop(JOG); h.fireTimers();
  assert.deepEqual(h.realtime(), [HOLD, RESET]);
});

test('the stopped job keeps its recovery record (state "stopped"), as after Stop Job', () => {
  const h = runningJob();
  h.ctx.stop(JOG);
  const rec = h.ctx.jobRecovery.peek();
  assert.ok(rec, 'a record was saved');
  assert.equal(rec.state, 'stopped');
  assert.ok(rec.resumeLine >= 1);
});

// --------------------------------------------------------------------------- the regression guards: plain jog stays as it was

test('idle + Stop Jog: ONLY 0x85 - no hold, no reset, nothing scheduled (unchanged behaviour)', () => {
  const h = harness();
  h.ctx.stop(JOG);
  assert.deepEqual(h.realtime(), [JOGCANCEL]);
  assert.equal(h.pendingTimers(), 0, 'no delayed reset');
  assert.equal(h.ctx.status.comms.connectionStatus, 2);
});

test('manual jog commands sitting in the queue ("$J=...") are NOT a job: Stop Jog / key release stays a plain 0x85', () => {
  const h = harness();
  h.ctx.addQToEnd('$J=G91G21X10F1000');
  h.ctx.addQToEnd('$J=G91G21X10F1000');
  h.ctx.addQToEnd('$J=G91G21X10F1000');
  assert.ok(h.ctx.gcodeQueue.length > 0, 'precondition: the jog commands are queued (queue length alone must not decide)');
  assert.equal(h.ctx.jobStartTime, false);
  assert.ok(!h.ctx.jobRecovery.isTracking());
  h.written.length = 0;
  h.ctx.stop(JOG);
  assert.deepEqual(h.realtime(), [JOGCANCEL]);
  assert.equal(h.pendingTimers(), 0);
});

test('a real jog in progress (sent through the normal path) + cancel is still just 0x85', () => {
  const h = harness();
  h.ctx.addQToEnd('$J=G91G21X50F500');
  h.ctx.send1Q(); // the jog line goes out
  h.written.length = 0;
  h.ctx.stop(JOG);
  assert.deepEqual(h.realtime(), [JOGCANCEL]);
  assert.equal(h.pendingTimers(), 0);
  assert.equal(h.ctx.jobRecovery.peek(), null, 'a jog-cancel never creates or freezes a recovery record');
});

test('Stop Job (the ribbon button) is unchanged: "!" then 0x18, no 0x85, with or without a job', () => {
  for (const h of [runningJob(), harness()]) {
    h.written.length = 0;
    h.ctx.stop(STOP_JOB); h.fireTimers();
    assert.deepEqual(h.realtime(), [HOLD, RESET]);
  }
});

test('abort:true (no hold, reset only) is unchanged', () => {
  const h = runningJob();
  h.written.length = 0;
  h.ctx.stop({ stop: false, jog: false, abort: true }); h.fireTimers();
  assert.deepEqual(h.realtime(), [RESET]);
});

test('with no connection nothing is sent at all', () => {
  const h = runningJob();
  h.ctx.status.comms.connectionStatus = 0;
  h.written.length = 0;
  h.ctx.stop(JOG); h.fireTimers();
  assert.deepEqual(h.realtime(), []);
});

// --------------------------------------------------------------------------- structure

test('structure: "running" is judged BEFORE the queue is dumped, and the jog-only checks use it (not data.jog alone)', () => {
  const src = grabFunction('stop');
  const decide = src.indexOf('var jobRunning');
  assert.ok(decide !== -1 && decide < src.indexOf('gcodeQueue.length = 0'), 'decided before the dump');
  assert.ok(decide < src.indexOf('jobRecovery.finish'), 'and before the recovery snapshot');
  assert.match(src, /var jogOnly = !!\(data && data\.jog\) && !jobRunning;/);
  assert.match(src, /if \(jogOnly\) \{\s*addQRealtime\(String\.fromCharCode\(0x85\)\)/);
  assert.match(src, /if \(!data\.abort && !jogOnly\)/);
  assert.match(src, /if \(!jogOnly\) \{\s*setTimeout/);
  assert.ok(!/[^.]data\.jog\)\s*\{/.test(src.replace('!!(data && data.jog)', '')), 'no other raw data.jog branch is left');
  assert.match(src, /connectionStatus == 3 \|\| status\.comms\.connectionStatus == 4/);
  assert.match(src, /jobRecovery\.isTracking\(\)/);
  assert.match(src, /\(!!jobStartTime && gcodeQueue\.length > 0\)/);
});
