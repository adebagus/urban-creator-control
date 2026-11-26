// Clear Alarm's $X is a LINE command: the controller answers it "ok" (after
// "[MSG:Caution: Unlocked]"), so it must be written as a paired line.
//
// Both methods wrote "$X\n" past sentBuffer (the realtime path). Its "ok" was
// then taken by whichever command was in flight - $$ got $X's "ok", and $$'s
// own output and "ok" were logged with no label. Method 2 (the ribbon's Clear
// Alarm, and the alarm dialog) wrote it 500 ms after its ctrl-x; written
// before the reset's banner, the reset could wipe it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSim, CTRL_X } = require('./helpers/serial-sim');

test('method 1 with $$ in flight: $$ keeps its own output and "ok", $X gets its own answer', () => {
  const sim = createSim();
  sim.grbl.on(/^\$\$$/, ['$0=10', '$1=25', 'ok']);
  sim.type('$$'); // in flight
  sim.handlers.clearAlarm(1);
  sim.grbl.answer();
  assert.deepEqual(sim.log.filter((l) => l.command === '$$').map((l) => l.response), ['$0=10', '$1=25', 'ok']);
  assert.deepEqual(sim.log.filter((l) => l.command === '$X').map((l) => l.response), ['[MSG:Caution: Unlocked]', 'ok']);
  assert.deepEqual(sim.state().sentBuffer, []);
});

test('method 1 when idle: $X goes out straight away as a normal line', () => {
  const sim = createSim();
  sim.handlers.clearAlarm(1);
  assert.equal(sim.wire[sim.wire.length - 1], '$X\n');
  assert.deepEqual(sim.state().sentBuffer, ['$X']);
});

test('method 2 (ribbon Clear Alarm) mid-job: queue and sentBuffer emptied, ctrl-x out, and $X is NOT written before the reset\'s banner', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: 'G1 X1 F100\nG1 X2\nG1 X3', fileName: 'e.nc' });
  sim.grbl.answer(1);
  sim.handlers.clearAlarm(2);
  assert.equal(sim.wire[sim.wire.length - 1], CTRL_X);
  assert.deepEqual(sim.state().gcodeQueue, []);
  assert.deepEqual(sim.state().sentBuffer, []);
  sim.advance(1000); // the old fixed 500 ms timer would have fired by now
  assert.ok(!sim.wire.includes('$X\n'), 'no $X before the banner: ' + JSON.stringify(sim.wire));
});

test('method 2: once the banner arrives, $X is sent as a paired line, and a command typed right after gets its own answer', () => {
  const sim = createSim();
  sim.grbl.alarm = true;
  sim.handlers.clearAlarm(2);
  sim.grbl.answer(); // banner (+ "'$H'|'$X' to unlock")
  assert.equal(sim.wire[sim.wire.length - 1], '$X\n');
  sim.type('$G');
  sim.grbl.answer();
  sim.grbl.answer();
  // $X's own answers pair with it. (The reset's spontaneous "'$H'|'$X' to
  // unlock" line arriving while $X is in flight is a labelling question -
  // test/sender-log-labels.test.js.)
  const xAnswers = sim.log.filter((l) => l.command === '$X').map((l) => l.response);
  assert.deepEqual(xAnswers.slice(-2), ['[MSG:Caution: Unlocked]', 'ok']);
  assert.deepEqual(sim.logged('[GC:'), ['[$G] [GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]']);
  assert.deepEqual(sim.log.filter((l) => l.command === '$G').map((l) => l.response), ['[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]', 'ok']);
  assert.deepEqual(sim.state().sentBuffer, []);
});

test('method 2: the job is reported stopped once ("alarm-reset") and its record kept as "interrupted" (unchanged)', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: 'G1 X1 F100\nG1 X2\nG1 X3', fileName: 'e.nc' });
  sim.grbl.answer(1);
  sim.handlers.clearAlarm(2);
  sim.grbl.answer();
  const stopped = sim.eventsOf('jobStopped');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].reason, 'alarm-reset');
  assert.equal(sim.ctx.jobRecovery.peek().state, 'interrupted');
});

test('method 2 then USB pulled before the banner: no stale $X is sent after the reconnect', () => {
  const sim = createSim();
  sim.handlers.clearAlarm(2);
  sim.ctx.port.isOpen = false;
  sim.ctx.stopPort();
  sim.ctx.port.isOpen = true;
  sim.ctx.status.comms.connectionStatus = 2;
  sim.ctx.status.machine.firmware.type = 'grbl';
  const before = sim.wire.length;
  sim.grbl.inbox = [{ kind: 'reset' }];
  sim.grbl.answer(); // the reconnect's banner
  assert.ok(!sim.wire.slice(before).includes('$X\n'), JSON.stringify(sim.wire.slice(before)));
});
