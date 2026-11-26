// Restart / Ctrl-X must be a realtime byte, and it must reset the sender.
//
// The ribbon's Restart / Restart Grbl buttons (app/index.html) and the
// "reset now?" prompt after saving settings call sendGcode(0x18), which goes
// through the server's runCommand. That used to queue 0x18 as an ordinary
// line: during a job it went out only after the whole job, and its own
// sentBuffer entry - like every line the controller was still holding when it
// reset - never got an "ok". Every later "ok"/"error" was then paired with
// the wrong command for the rest of the session (bench finding: banner logged
// as "[$309=1]", "G90 G0 A0" shown as rejected when an older line was).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createSim, CTRL_X, SRC } = require('./helpers/serial-sim');

const JOB = 'G1 X1 F100\nG1 X2\nG1 X3\nG1 X4';

test('Restart mid-job: 0x18 is written to the port at once as a bare byte, not queued behind the job', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: JOB, fileName: 'a.nc' });
  sim.restart();
  assert.equal(sim.wire[sim.wire.length - 1], CTRL_X, 'last write must be the bare ctrl-x: ' + JSON.stringify(sim.wire));
  assert.ok(!sim.wire.includes(CTRL_X + '\n'), 'never written as a line');
  assert.ok(!sim.ctx.gcodeQueue.includes(CTRL_X) && !sim.ctx.sentBuffer.includes(CTRL_X), 'never in the line queue');
});

test('Restart mid-job: the job is gone - nothing left to send, nothing waiting for an answer', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: JOB, fileName: 'a.nc' });
  sim.restart();
  sim.grbl.answer(); // banner
  const s = sim.state();
  assert.deepEqual(s.gcodeQueue, []);
  assert.deepEqual(s.sentBuffer, []);
  assert.equal(sim.unsent(), 0);
  sim.type('$G');
  sim.grbl.answer();
  assert.ok(!sim.wire.some((w) => /^G1 X[234]/.test(w)), 'no line of the dead job is ever sent: ' + JSON.stringify(sim.wire));
});

test('Restart with a command still in flight: after the banner, the next command gets ITS OWN answer (bench: banner was logged as "[$309=1]")', () => {
  const sim = createSim();
  sim.type('$309=1'); // written, not answered yet
  sim.restart(); // the controller resets - $309=1 will never be answered
  sim.grbl.answer(); // banner
  sim.type('$G');
  sim.grbl.answer();
  assert.deepEqual(sim.logged('[GC:'), ['[$G] [GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]']);
  assert.deepEqual(sim.state().sentBuffer, [], 'nothing left waiting for an answer');
});

test('bench sequence: G91 G1 A10 rejected (error:33) -> Restart -> G90 G0 A0 is answered "ok" against itself, Job Queue 0', () => {
  const sim = createSim();
  sim.grbl.on(/A10/, ['[MSG:A is Y2 ($309=1): A10.000]', 'error:33']);
  sim.type('G91 G1 A10 F1000');
  sim.grbl.answer();
  sim.restart();
  sim.grbl.answer(); // banner
  sim.type('G90 G0 A0');
  sim.grbl.answer();
  const lines = sim.log.filter((l) => l.command === 'G90 G0 A0').map((l) => l.response);
  assert.deepEqual(lines, ['ok'], 'G90 G0 A0 must be shown with exactly its own "ok": ' + JSON.stringify(sim.log));
  assert.ok(!sim.log.some((l) => l.command === 'G90 G0 A0' && /error/.test(l.response)));
  assert.equal(sim.unsent(), 0);
  assert.deepEqual(sim.state().sentBuffer, []);
  const counts = sim.eventsOf('queueCount');
  assert.equal(counts[counts.length - 1][0], 0, 'the UI shows "Job Queue: " + data[0] - it must end at 0');
});

test('Restart mid-job: exactly one jobStopped (reason "restart"), and the recovery record is kept as "stopped" - a deliberate stop', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: JOB, fileName: 'a.nc' });
  sim.grbl.answer(1);
  sim.restart();
  sim.grbl.answer();
  const stopped = sim.eventsOf('jobStopped');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].reason, 'restart');
  assert.equal(sim.ctx.jobRecovery.peek().state, 'stopped');
});

test('Restart clears the UI queue counter: queueCount [0, 0] is emitted', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: JOB, fileName: 'a.nc' });
  sim.restart();
  const last = sim.eventsOf('queueCount').pop();
  assert.deepEqual([...last], [0, 0]);
});

test('the resetMachine socket event does exactly what the Restart button does', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: JOB, fileName: 'a.nc' });
  sim.handlers.resetMachine();
  assert.equal(sim.wire[sim.wire.length - 1], CTRL_X);
  assert.deepEqual(sim.state().gcodeQueue, []);
  assert.deepEqual(sim.state().sentBuffer, []);
});

test('"?" typed in the console is a realtime byte (never queued) and the next status report is still printed to the console', () => {
  const sim = createSim();
  sim.type('?');
  assert.equal(sim.wire[sim.wire.length - 1], '?');
  assert.deepEqual(sim.state().sentBuffer, []);
  sim.rx('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
  assert.deepEqual(sim.logged('<Idle'), ['[?] <Idle|MPos:0.000,0.000,0.000|FS:0,0>']);
  sim.rx('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
  assert.equal(sim.logged('<Idle').length, 1, 'only the one report that was asked for');
});

test('"!", "~", jog-cancel 0x85 and override bytes from runCommand go out immediately even mid-job, and never enter the queue', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: JOB, fileName: 'a.nc' });
  const before = sim.state();
  for (const b of ['!', '~', String.fromCharCode(0x85), String.fromCharCode(0x90), String.fromCharCode(0x9E)]) {
    sim.type(b);
    assert.equal(sim.wire[sim.wire.length - 1], b, 'byte ' + b.charCodeAt(0).toString(16));
  }
  assert.deepEqual(sim.state().gcodeQueue, before.gcodeQueue);
  assert.deepEqual(sim.state().sentBuffer, before.sentBuffer);
});

test('isRealtimeCommand(): only single realtime bytes - ordinary one-letter or $ lines stay normal lines', () => {
  const ctx = {};
  vm.createContext(ctx);
  const s = SRC.indexOf('function isRealtimeCommand(');
  vm.runInContext(SRC.slice(s, SRC.indexOf('\n}\n', s) + 2), ctx);
  for (const b of ['?', '!', '~', CTRL_X, String.fromCharCode(0x80), String.fromCharCode(0x85), String.fromCharCode(0xA1)]) {
    assert.equal(ctx.isRealtimeCommand(b), true, b.charCodeAt(0).toString(16));
  }
  for (const l of ['M', '$', '$X', 'G0', '??', '?\n', 'x']) assert.equal(ctx.isRealtimeCommand(l), false, JSON.stringify(l));
});

test('structure: every queue dump in stop()/resetMachine goes through resetSenderState (one place)', () => {
  const stopSrc = SRC.slice(SRC.indexOf('function stop(data)'), SRC.indexOf('\n}\n', SRC.indexOf('function stop(data)')));
  assert.match(stopSrc, /resetSenderState\('stopped'\)/);
  assert.ok(!/gcodeQueue\.length\s*=\s*0/.test(stopSrc), 'stop() must not dump the queue on its own');
  assert.match(SRC, /socket\.on\('resetMachine'[\s\S]{0,300}resetController\('stopped', 'restart'\)/);
});

// --- client: queueCount [0, 0] (the server emptied its queue) -----------------

const WS_SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'websocket.js'), 'utf8').replace(/\r\n/g, '\n');

function clientQueueCount(connectionStatus) {
  const marker = 'socket.on("queueCount", ';
  const start = WS_SRC.indexOf(marker);
  const end = WS_SRC.indexOf('\n  })\n', start);
  const fn = WS_SRC.slice(start + marker.length, end + '\n  }'.length);
  const progress = [];
  const goto = [];
  const ctx = {
    laststatus: { comms: { connectionStatus } },
    editor: { gotoLine: (n) => goto.push(n) },
    lastJobStartTime: 0,
    $: () => ({ data: () => ({ val: (v) => progress.push(v) }), html() {}, empty() {} }),
  };
  vm.createContext(ctx);
  return { handler: vm.runInContext('(' + fn + ')', ctx), progress, goto };
}

test('client: queueCount [0, 0] shows 0% progress (not NaN) and does not move the editor, even if the last status still said "streaming"', () => {
  const c = clientQueueCount(3);
  c.handler([0, 0]);
  assert.deepEqual(c.progress, [0]);
  assert.deepEqual(c.goto, []);
});
