// The controller's "Grbl ..." banner means it just reset - whoever caused it.
//
// A reset wipes everything the controller had received but not answered, so
// from the banner on, no old sentBuffer entry will ever get its "ok". The
// banner used to change nothing but the "blocked" flag, so a reset the SENDER
// did not ask for - the board's own reset on a hard limit (Mythos prints its
// banner BEFORE "ALARM:1", bench_a0_log.txt 20:22:37), the reset button, a
// power glitch - left stale entries that shifted every later answer, and left
// the dead job's lines queued.
//
// Between a reset and the banner nothing may be sent at all: the banner
// empties sentBuffer, so a line written in that window would lose its answer.
// The operator's command is refused with a message instead (never dropped
// silently). A board on native USB does not reset when the port opens, so the
// [VER:] line of $I also counts as "the board is up".
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSim, BANNER, CTRL_X } = require('./helpers/serial-sim');

const JOB = 'G1 Y-100 F50\nG1 Y-200\nG1 Y-300';

test('hard limit mid-job (Mythos order: banner before ALARM:1): after the auto-reset and $X, no line of the dead job is ever sent', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: JOB, fileName: 'b.nc' });
  sim.grbl.answer(1); // line 1 ok -> line 2 in flight
  sim.grbl.hardLimit(); // ... [MSG:Reset to continue] -> sender sends ctrl-x
  sim.grbl.answer(); // banner of that ctrl-x
  const before = sim.wire.length;
  sim.type('$X');
  sim.grbl.answer();
  assert.deepEqual(sim.wire.slice(before), ['$X\n']);
  assert.ok(!sim.wire.includes('G1 Y-300\n'), JSON.stringify(sim.wire));
  assert.deepEqual(sim.log.filter((l) => l.command === '$X').map((l) => l.response), ['[MSG:Caution: Unlocked]', 'ok']);
  assert.deepEqual(sim.state().sentBuffer, []);
});

test('a reset the sender did not ask for (reset button / power glitch) with $309=1 in flight: the banner is logged unlabelled, and the next command gets its own answer', () => {
  const sim = createSim();
  sim.type('$309=1'); // in flight
  sim.grbl.inbox = []; // the board resets on its own: its RX buffer is gone
  sim.rx(BANNER);
  assert.deepEqual(sim.logged('Grbl 1.1f'), ['[] ' + BANNER]);
  sim.type('$G');
  sim.grbl.answer();
  assert.deepEqual(sim.logged('[GC:'), ['[$G] [GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]']);
  assert.deepEqual(sim.state().sentBuffer, []);
});

test('a banner mid-job ends the job: one jobStopped ("firmware-reset"), recovery record "interrupted" (not a deliberate stop)', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: JOB, fileName: 'b.nc' });
  sim.grbl.answer(1);
  sim.grbl.inbox = [];
  sim.rx(BANNER);
  const stopped = sim.eventsOf('jobStopped');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].reason, 'firmware-reset');
  assert.equal(sim.ctx.jobRecovery.peek().state, 'interrupted');
  assert.equal(sim.unsent(), 0);
});

test('Restart then its banner: still ONE jobStopped, and the record stays "stopped" (the banner does not overwrite the deliberate stop)', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: JOB, fileName: 'b.nc' });
  sim.grbl.answer(1);
  sim.restart();
  sim.grbl.answer(); // banner
  assert.equal(sim.eventsOf('jobStopped').length, 1);
  assert.equal(sim.ctx.jobRecovery.peek().state, 'stopped');
});

test('the connect-time banner (nothing queued): firmware identified as before, no jobStopped, commands go through', () => {
  const sim = createSim({ controllerReady: false });
  sim.ctx.status.machine.firmware.type = '';
  sim.rx(BANNER);
  assert.equal(sim.ctx.status.machine.firmware.type, 'grbl');
  assert.equal(sim.ctx.status.machine.firmware.version, '1.1f');
  assert.equal(sim.eventsOf('jobStopped').length, 0);
  sim.type('$$');
  assert.equal(sim.wire[sim.wire.length - 1], '$$\n');
});

test('between our reset and its banner a typed command is REFUSED with a log message - not sent, not silently dropped; it works after the banner', () => {
  const sim = createSim();
  sim.restart();
  const before = sim.wire.length;
  sim.type('$G');
  assert.equal(sim.wire.length, before, 'nothing written');
  assert.deepEqual(sim.state().gcodeQueue, [], 'nothing quietly queued either');
  assert.equal(sim.log.filter((l) => l.command === '$G' && /Ditolak/.test(l.response) && /belum siap/.test(l.response)).length, 1, JSON.stringify(sim.log));
  sim.grbl.answer(); // banner
  sim.type('$G');
  assert.equal(sim.wire[sim.wire.length - 1], '$G\n');
});

test('realtime bytes always go out, ready or not ("?" right after a reset)', () => {
  const sim = createSim();
  sim.restart();
  sim.type('?');
  assert.equal(sim.wire[sim.wire.length - 1], '?');
});

test('native-USB board (no banner when the port opens): refused until the [VER:] of $I arrives, $I itself is allowed', () => {
  const sim = createSim({ controllerReady: false });
  sim.type('$$');
  assert.ok(!sim.wire.includes('$$\n'));
  sim.type('$I');
  assert.equal(sim.wire[sim.wire.length - 1], '$I\n');
  sim.grbl.answer(); // [VER:1.1f.20261126.53AS.4A-AS:Grbl Mythos ] ... ok
  sim.type('$$');
  assert.equal(sim.wire[sim.wire.length - 1], '$$\n');
});

test('"[MSG:Reset to continue]": ctrl-x goes out at once, the queue is already empty, and the board counts as not ready until its banner', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: JOB, fileName: 'b.nc' });
  sim.grbl.answer(1);
  sim.rx('ALARM:1');
  sim.rx('[MSG:Reset to continue]');
  assert.equal(sim.wire[sim.wire.length - 1], CTRL_X);
  assert.equal(sim.unsent(), 0);
  assert.equal(sim.ctx.controllerReady, false);
  sim.grbl.answer();
  assert.equal(sim.ctx.controllerReady, true);
});

test('a job started while the board is not ready is refused with a message and leaves no job behind', () => {
  const sim = createSim({ controllerReady: false });
  sim.ctx.runJob({ isJob: true, data: JOB, fileName: 'b.nc' });
  assert.equal(sim.wire.length, 0);
  assert.deepEqual(sim.state().gcodeQueue, []);
  assert.equal(sim.ctx.jobStartTime, false);
  assert.equal(sim.log.filter((l) => l.command === 'b.nc' && /Ditolak/.test(l.response)).length, 1);
});

test('a jog while the board is not ready is refused with a message, nothing written', () => {
  const sim = createSim({ controllerReady: false });
  sim.handlers.jog('X,10,1000');
  assert.equal(sim.wire.length, 0);
  assert.equal(sim.log.filter((l) => /^\$J=/.test(l.command) && /Ditolak/.test(l.response)).length, 1);
});
