// Regression tests for "stale job state survives a dumped queue" (P9 follow-up).
//
// The bug, as reproduced from a real hardware test: pull the USB cable in the
// middle of a job, reconnect, and
//   - the FIRST command the client sends ($$) was silently never written to
//     the port (queuePointer was still 151 while the queue had just been
//     emptied, so send1Q computed "length 1 - pointer 151 < 0"),
//   - that same send1Q call then took its "queue is empty -> job complete"
//     branch and emitted jobComplete carrying the OLD jobStartTime, which the
//     client printed as "JOB COMPLETE ... 00h00m" and stored in the job history,
//   - and a NEW job started before any other command began at line 152.
// stopPort(), stop() and clearAlarm(method 2) all dump the queue but did not
// reset queuePointer / jobStartTime / jobCompletedMsg.
//
// index.js cannot be require()d from a test (it boots Electron and the
// servers), so these tests EXTRACT the real functions - and the two inline
// socket handlers - out of index.js's source text and run them in a vm sandbox.
// That tests the shipped code rather than a copy of it. If index.js is
// restructured so an extraction fails, the tests error loudly by name; fix the
// extraction, do not delete the test.
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

// The body of an inline `socket.on('<event>', function(data) { ... });` handler,
// as a "(function(data) {...})" expression.
function grabSocketHandler(event) {
  const marker = "socket.on('" + event + "', function(";
  const start = INDEX_SRC.indexOf(marker);
  assert.notEqual(start, -1, 'cannot extract socket handler ' + event + ' from index.js');
  const fnStart = start + ("socket.on('" + event + "', ").length;
  const end = INDEX_SRC.indexOf('\n  });', fnStart); // handler bodies are indented deeper than this
  assert.notEqual(end, -1, 'cannot find the end of socket handler ' + event);
  return '(' + INDEX_SRC.slice(fnStart, end + '\n  }'.length) + ')';
}

const MODAL_VARS =
  INDEX_SRC.match(/var modalCommands = \[[^\]]*\]\n/)[0] +
  INDEX_SRC.match(/var modalCommandsRegExp = [^\n]*\n/)[0];

// A fresh sandbox running the REAL sender/queue code against a fake port.
function harness() {
  const written = [];
  const emitted = [];
  const timers = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-stale-'));
  const ctx = {
    gcodeQueue: [], queuePointer: 0, sentBuffer: [], statusLoop: null, queueCounter: null,
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
    getDir: () => dir,
    autoTimer: false,
    getFirstUnackedQ: () => (ctx.gcodeQueue.length === 0 ? -1 : Math.max(0, ctx.queuePointer - ctx.sentBuffer.length)),
    getPlannerBlocks: () => 35,
  });
  vm.createContext(ctx);
  vm.runInContext(
    MODAL_VARS + ['addQToEnd', 'send1Q', 'BufferSpace', 'machineSend', 'addQRealtime', 'runJob', 'announceJobStopped', 'stopPort', 'stop']
      .map(grabFunction).join('\n'),
    ctx
  );
  const runCommandHandler = vm.runInContext(grabSocketHandler('runCommand'), ctx);
  const clearAlarmHandler = vm.runInContext(grabSocketHandler('clearAlarm'), ctx);

  const h = {
    ctx, written, emitted,
    // What the parser's "ok" branch does for a line the controller accepted.
    ack() { ctx.sentBuffer.shift(); ctx.status.comms.blocked = false; ctx.send1Q(); },
    startJob(lineCount, extra) {
      const lines = [];
      for (let i = 1; i <= lineCount; i++) lines.push('G1 X' + i + ' F500');
      ctx.runJob(Object.assign({ isJob: true, data: lines.join('\n') }, extra));
    },
    // The 'close' event handler: connectionStatus = 0, then stopPort().
    pullUsb() { ctx.port.isOpen = false; ctx.status.comms.connectionStatus = 0; ctx.stopPort(); },
    reconnect() {
      ctx.port = { isOpen: true, write(s) { written.push(s); } };
      ctx.status.comms.connectionStatus = 2;
      ctx.status.machine.firmware.type = 'grbl';
    },
    // Sends a command the way the client does and answers "ok" if it went out.
    command(cmd) {
      const before = written.length;
      runCommandHandler(cmd);
      const sent = written.length > before;
      if (sent) h.ack();
      return sent;
    },
    stop(data) { ctx.stop(data || { stop: true, jog: false, abort: false }); },
    clearAlarm(method) { clearAlarmHandler(method); },
    jobCompleteEvents() { return emitted.filter((e) => e[0] === 'jobComplete').map((e) => e[1]); },
    jobStoppedEvents() { return emitted.filter((e) => e[0] === 'jobStopped').map((e) => e[1]); },
    resetCapture() { written.length = 0; emitted.length = 0; },
  };
  return h;
}

// Every jobComplete emitted after an interruption must be the harmless
// "empty queue" noise: no job start time to display, no message to show.
function assertNoStaleCompletion(events, where) {
  for (const e of events) {
    assert.equal(!!e.jobStartTime, false, where + ': a jobComplete carried a STALE jobStartTime (' + e.jobStartTime + ')');
    assert.equal(e.jobCompletedMsg, '', where + ': a stopped job\'s completion message leaked');
  }
}

// --- USB pulled mid-job ------------------------------------------------------

test('USB pulled mid-job: queuePointer, jobStartTime and jobCompletedMsg are reset with the queue', () => {
  const h = harness();
  h.startJob(300, { completedMsg: 'All done' });
  for (let i = 0; i < 150; i++) h.ack();
  assert.equal(h.ctx.queuePointer, 151, 'precondition: job well under way');
  assert.ok(h.ctx.jobStartTime, 'precondition: job start time recorded');
  assert.equal(h.ctx.jobCompletedMsg, 'All done');

  h.pullUsb();

  assert.equal(h.ctx.gcodeQueue.length, 0);
  assert.equal(h.ctx.sentBuffer.length, 0);
  assert.equal(h.ctx.queuePointer, 0, 'a stale pointer swallows the next command and skips lines of the next job');
  assert.equal(h.ctx.jobStartTime, false, 'a stale start time produces a bogus "JOB COMPLETE" after reconnect');
  assert.equal(h.ctx.jobCompletedMsg, '');
});

test('after a USB pull the FIRST command sent on reconnect is actually written to the port', () => {
  const h = harness();
  h.startJob(300);
  for (let i = 0; i < 150; i++) h.ack();
  h.pullUsb();
  h.reconnect();
  h.resetCapture();

  assert.equal(h.command('$$'), true, '"$$" must not be silently dropped');
  assert.deepEqual(h.written, ['$$\n']);
});

test('after a USB pull, reconnect emits no jobComplete carrying the old job start time', () => {
  const h = harness();
  h.startJob(300, { completedMsg: 'All done' });
  for (let i = 0; i < 150; i++) h.ack();
  h.pullUsb();
  h.reconnect();
  h.resetCapture();

  // What the client's showGrbl() sends after every connect.
  for (const cmd of ['$$', '$I', '$G']) {
    assert.equal(h.command(cmd), true, cmd + ' must go out');
  }
  assertNoStaleCompletion(h.jobCompleteEvents(), 'reconnect after USB pull');
});

test('a NEW job started right after a USB-pull reconnect begins at its FIRST line', () => {
  // Before the fix the leftover pointer made this job start at "G1 X152" -
  // silently skipping the header, spindle-on and safe-Z lines before it.
  const h = harness();
  h.startJob(300);
  for (let i = 0; i < 150; i++) h.ack();
  h.pullUsb();
  h.reconnect();
  h.resetCapture();

  h.startJob(300);
  assert.equal(h.written[0].trim(), 'G1 X1 F500');
});

// --- the other two ways a queue gets dumped ---------------------------------

test('Stop mid-job: job-scoped state is reset and the next command emits no stale jobComplete', () => {
  const h = harness();
  h.startJob(300, { completedMsg: 'All done' });
  for (let i = 0; i < 150; i++) h.ack();

  h.stop();

  assert.equal(h.ctx.queuePointer, 0);
  assert.equal(h.ctx.jobStartTime, false, 'stop() used to leave the start time set');
  assert.equal(h.ctx.jobCompletedMsg, '');
  h.resetCapture();
  assert.equal(h.command('$G'), true);
  assertNoStaleCompletion(h.jobCompleteEvents(), 'command after Stop');
});

test('Clear Alarm (method 2 - empties the queue) mid-job: same reset, no stale jobComplete', () => {
  // Alarm -> operator clicks Clear/Reset. Not one of the original three reports
  // but the same defect: it dumped the queue and reset only the pointer.
  const h = harness();
  h.startJob(300, { completedMsg: 'All done' });
  for (let i = 0; i < 150; i++) h.ack();

  h.clearAlarm(2);

  assert.equal(h.ctx.gcodeQueue.length, 0, 'method 2 must still empty the queue');
  assert.equal(h.ctx.queuePointer, 0);
  assert.equal(h.ctx.jobStartTime, false);
  assert.equal(h.ctx.jobCompletedMsg, '');
  h.resetCapture();
  assert.equal(h.command('$G'), true);
  assertNoStaleCompletion(h.jobCompleteEvents(), 'command after Clear Alarm');
});

test('Clear Alarm method 1 (just $X) does not touch a running job\'s state', () => {
  // Guard against over-fixing: only the queue-dumping method may reset it.
  const h = harness();
  h.startJob(300, { completedMsg: 'All done' });
  for (let i = 0; i < 50; i++) h.ack();
  const pointer = h.ctx.queuePointer;
  const started = h.ctx.jobStartTime;

  h.clearAlarm(1);

  assert.equal(h.ctx.queuePointer, pointer);
  assert.equal(h.ctx.jobStartTime, started);
  assert.equal(h.ctx.jobCompletedMsg, 'All done');
});

// --- the fix must not break real completion ----------------------------------

test('a job that genuinely finishes still reports completion (with its start time and message)', () => {
  const h = harness();
  h.startJob(5, { completedMsg: 'All done' });
  const started = h.ctx.jobStartTime;
  assert.ok(started);
  for (let i = 0; i < 20 && h.ctx.gcodeQueue.length > 0; i++) h.ack();

  const real = h.jobCompleteEvents().filter((e) => e.completed && !e.failed);
  assert.equal(real.length, 1, 'exactly one genuine completion');
  assert.equal(real[0].jobStartTime, started);
  assert.equal(real[0].jobCompletedMsg, 'All done');
  // ...and the send1Q completion branch still leaves clean state behind.
  assert.equal(h.ctx.queuePointer, 0);
  assert.equal(h.ctx.jobStartTime, false);
  assert.equal(h.ctx.jobCompletedMsg, '');
});

test('a normal disconnect with no job running is unaffected', () => {
  const h = harness();
  h.pullUsb();
  h.reconnect();
  h.resetCapture();
  assert.equal(h.command('$$'), true);
  assert.deepEqual(h.written, ['$$\n']);
});

// --- structural guard: every queue dump site resets the same state -----------

test('every place index.js dumps gcodeQueue also resets queuePointer, jobStartTime and jobCompletedMsg', () => {
  // The behavioural tests above cover the sites that exist today; this catches
  // the NEXT place someone adds a `gcodeQueue.length = 0` and forgets the rest.
  const lines = INDEX_SRC.split('\n');
  const sites = [];
  lines.forEach((line, i) => {
    if (/^\s*gcodeQueue\.length\s*=\s*0/.test(line)) sites.push(i);
  });
  assert.ok(sites.length >= 4, 'expected the 4 known queue-dump sites, found ' + sites.length);
  for (const i of sites) {
    const window = lines.slice(Math.max(0, i - 4), i + 16).join('\n');
    const where = 'index.js line ' + (i + 1);
    assert.match(window, /queuePointer\s*=\s*0/, where + ' must reset queuePointer');
    assert.match(window, /jobStartTime\s*=\s*false/, where + ' must reset jobStartTime');
    assert.match(window, /jobCompletedMsg\s*=\s*""/, where + ' must reset jobCompletedMsg');
  }
});

// ---------------------------------------------------------------------------
// jobStopped: the explicit "a REAL job was cut short" event.
//
// Why a separate event instead of reusing jobComplete{failed:true}: that shape
// (failed + a start time) is exactly what the stale-reconnect bug produced, so
// nothing on the client could tell a legitimate stopped job from stale noise.
// Before this event existed the server said NOTHING when a job was stopped,
// pulled or alarm-reset, so the job history had no way to record it.
// ---------------------------------------------------------------------------

test('Stop mid-job announces exactly ONE jobStopped, carrying the real start time and the moment of the stop', () => {
  const h = harness();
  h.startJob(300);
  const started = h.ctx.jobStartTime;
  for (let i = 0; i < 100; i++) h.ack();
  h.resetCapture();
  const before = Date.now();

  h.stop();

  const ev = h.jobStoppedEvents();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].completed, false);
  assert.equal(ev[0].reason, 'stopped');
  assert.equal(ev[0].jobStartTime, started, 'the ORIGINAL start time, captured before the reset');
  assert.ok(ev[0].jobEndTime >= before && ev[0].jobEndTime >= started, 'end time is when it was stopped');
  assert.equal(h.jobCompleteEvents().length, 0, 'never announced on the completion channel');
});

test('USB pulled mid-job announces jobStopped once ("interrupted"), even when stopPort runs twice (port error then close)', () => {
  const h = harness();
  h.startJob(300);
  const started = h.ctx.jobStartTime;
  for (let i = 0; i < 100; i++) h.ack();
  h.resetCapture();

  h.pullUsb();
  h.ctx.stopPort(); // the 'close' event following an 'error' calls it again

  const ev = h.jobStoppedEvents();
  assert.equal(ev.length, 1, 'the reset after the first call makes the second a no-op');
  assert.equal(ev[0].reason, 'interrupted');
  assert.equal(ev[0].jobStartTime, started);
});

test('Clear Alarm method 2 mid-job announces jobStopped ("alarm-reset"); method 1 ($X only) announces nothing', () => {
  const a = harness();
  a.startJob(300);
  for (let i = 0; i < 100; i++) a.ack();
  a.resetCapture();
  a.clearAlarm(2);
  assert.equal(a.jobStoppedEvents().length, 1);
  assert.equal(a.jobStoppedEvents()[0].reason, 'alarm-reset');

  const b = harness();
  b.startJob(300);
  for (let i = 0; i < 100; i++) b.ack();
  b.resetCapture();
  b.clearAlarm(1);
  assert.equal(b.jobStoppedEvents().length, 0, 'the job is still running - it did not stop');
});

test('a jog-cancel that dumps a running job\'s queue announces it too (the job is dead either way)', () => {
  const h = harness();
  h.startJob(300);
  for (let i = 0; i < 100; i++) h.ack();
  h.resetCapture();
  h.stop({ stop: false, jog: true, abort: false });
  assert.equal(h.jobStoppedEvents().length, 1);
});

test('THE STALE HOLE STAYS CLOSED: after the stop was announced once, reconnecting and sending commands announces nothing more and emits no jobComplete with a start time', () => {
  for (const how of ['usb-pull', 'stop-button', 'alarm-reset']) {
    const h = harness();
    h.startJob(300, { completedMsg: 'All done' });
    for (let i = 0; i < 150; i++) h.ack();
    if (how === 'usb-pull') { h.pullUsb(); h.reconnect(); }
    else if (how === 'stop-button') h.stop();
    else h.clearAlarm(2);
    assert.equal(h.jobStoppedEvents().length, 1, how + ': the real stop is announced exactly once');
    h.resetCapture();

    for (const cmd of ['$$', '$I', '$G']) assert.equal(h.command(cmd), true, how + ': ' + cmd + ' must go out');
    assert.equal(h.jobStoppedEvents().length, 0, how + ': the aftermath must not announce another stopped job');
    assertNoStaleCompletion(h.jobCompleteEvents(), how + ' aftermath');
  }
});

test('nothing running -> nothing announced (idle disconnect, idle Stop, a lone console command in flight)', () => {
  const idle = harness();
  idle.pullUsb();
  idle.reconnect();
  idle.stop();
  assert.equal(idle.jobStoppedEvents().length, 0);

  // A console command sits in the queue but is not a job: it never stamps jobStartTime.
  const cmd = harness();
  cmd.ctx.status.comms.connectionStatus = 2;
  cmd.command('$G'); // sent and acked
  cmd.ctx.gcodeQueue.push('G0 X1'); // something still queued
  cmd.pullUsb();
  assert.equal(cmd.jobStoppedEvents().length, 0, 'no isJob run, so no job to report as stopped');
});

test('a job that already finished streaming is not "stopped" by a later Stop', () => {
  const h = harness();
  h.startJob(5);
  for (let i = 0; i < 20 && h.ctx.gcodeQueue.length > 0; i++) h.ack(); // runs to the end
  assert.equal(h.jobCompleteEvents().filter((e) => e.completed && !e.failed).length, 1);
  h.resetCapture();

  h.stop();
  assert.equal(h.jobStoppedEvents().length, 0, 'jobStartTime was cleared at completion');
});

test('a job requested while disconnected leaves nothing queued, so a later Stop announces nothing', () => {
  // runJob() stamps jobStartTime before it checks the connection. Announcing
  // requires lines to actually be queued, which is what keeps this from being
  // reported as a "stopped job" that never ran.
  const h = harness();
  h.ctx.status.comms.connectionStatus = 0;
  h.startJob(5);
  assert.equal(h.ctx.gcodeQueue.length, 0);
  h.reconnect();
  h.resetCapture();
  h.stop();
  assert.equal(h.jobStoppedEvents().length, 0);
});

test('a job that genuinely completes announces completion and never a jobStopped', () => {
  const h = harness();
  h.startJob(5, { completedMsg: 'All done' });
  for (let i = 0; i < 20 && h.ctx.gcodeQueue.length > 0; i++) h.ack();
  assert.equal(h.jobCompleteEvents().filter((e) => e.completed && !e.failed).length, 1);
  assert.equal(h.jobStoppedEvents().length, 0);
});

test('structural: every place that dumps the queue announces first, or is the genuine-completion branch', () => {
  // Enclosing function / socket handler of each `gcodeQueue.length = 0`.
  const lines = INDEX_SRC.split('\n');
  const sites = [];
  lines.forEach((line, i) => { if (/^\s*gcodeQueue\.length\s*=\s*0/.test(line)) sites.push(i); });
  assert.ok(sites.length >= 4);
  for (const i of sites) {
    let start = i;
    while (start > 0 && !/^function \w+\(|^\s*socket\.on\(/.test(lines[start])) start--;
    const scope = lines.slice(start, i + 1).join('\n');
    const where = 'index.js line ' + (i + 1) + ' (' + lines[start].trim().slice(0, 40) + ')';
    const announces = /announceJobStopped\(/.test(scope);
    const isGenuineCompletion = /io\.sockets\.emit\('jobComplete'/.test(scope);
    assert.ok(announces || isGenuineCompletion,
      where + ' dumps the queue without announcing a stopped job - a job killed here would vanish from the job history');
    if (!isGenuineCompletion) {
      // a job killed here must keep its recovery record: freeze it BEFORE the dump, or the next
      // "ok" on the emptied queue reads as "every line sent" and the record is wiped as "completed"
      assert.ok(/jobRecovery\.finish\(/.test(scope),
        where + ' dumps the queue without freezing the recovery record (jobRecovery.finish) - Clear Alarm used to erase the record this way');
    }
  }
});

// --- Clear Alarm must not erase the recovery record --------------------------------------------
// Seen on a real test: a job was rejected by the controller, the operator clicked Clear Alarm, and
// six seconds later the log said "Job recovery data cleared (completed)". Clear Alarm (method 2) dumped the
// queue without freezing the record; the next "ok" on the empty queue then looked like "every line sent",
// and the controller going Idle wiped the record as if the job had finished.

test('Clear Alarm (method 2) mid-job KEEPS the recovery record as "interrupted" - it is not wiped as "completed"', () => {
  const h = harness();
  h.startJob(300, { fileName: 'part.nc' });
  for (let i = 0; i < 150; i++) h.ack();
  assert.ok(h.ctx.jobRecovery.isTracking(), 'the job is tracked');

  h.clearAlarm(2);

  // what follows on the real machine: "ok" for the reset commands on the emptied queue, then Idle
  h.ack();
  h.ctx.jobRecovery.onIdle(h.ctx.sentBuffer.length === 0);

  const rec = h.ctx.jobRecovery.peek();
  assert.ok(rec, 'the recovery record must still exist');
  assert.equal(rec.state, 'interrupted');
  assert.ok(rec.resumeLine >= 100, 'and it still points at where the job got to (' + rec.resumeLine + ')');
  assert.equal(h.ctx.jobRecovery.isTracking(), false, 'the dead job is no longer being tracked');
});

test('Clear Alarm right after the job started keeps the record too (an early rejection is exactly when recovery matters)', () => {
  const h = harness();
  h.startJob(300, { fileName: 'part.nc' });
  h.clearAlarm(2);
  h.ack();
  h.ctx.jobRecovery.onIdle(true);
  const rec = h.ctx.jobRecovery.peek();
  assert.ok(rec);
  assert.equal(rec.state, 'interrupted');
});

test('Clear Alarm method 1 ($X only) leaves the running job\'s record alone', () => {
  const h = harness();
  h.startJob(300, { fileName: 'part.nc' });
  for (let i = 0; i < 20; i++) h.ack();
  h.clearAlarm(1);
  assert.ok(h.ctx.jobRecovery.isTracking(), 'still tracked');
});

test('a job that genuinely finishes still clears its record when the controller goes Idle', () => {
  const h = harness();
  h.startJob(20, { fileName: 'part.nc' });
  for (let i = 0; i < 20; i++) h.ack();
  h.ctx.jobRecovery.onIdle(h.ctx.sentBuffer.length === 0);
  assert.equal(h.ctx.jobRecovery.peek(), null, 'completed jobs leave no record');
});
