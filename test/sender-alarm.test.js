// ALARM handling and the console gate while the controller is in alarm.
//
// - An "ALARM:N" ends the job: its unsent lines are dropped (with a log line)
//   instead of being streamed by whatever "ok" comes next.
// - Lines already written stay in sentBuffer: if the controller reset, its
//   banner empties it (Mythos prints the banner first); if it did not reset,
//   they may still be answered, and must still pair. If they are not answered
//   within ALARM_ANSWER_TIMEOUT_MS they are forgotten with "N jawaban
//   dibatalkan (timeout setelah ALARM)". Until then no new operator line is
//   written - its "ok" would otherwise be taken by one of them.
// - While in alarm only "$" commands go ($X, $H, $$, $I...). G-code and $J=
//   jogs are refused with "Mesin ALARM — kirim $X/$H dulu". Realtime bytes
//   always go.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSim, CTRL_X } = require('./helpers/serial-sim');

const ALARM_MSG = 'Mesin ALARM — kirim $X/$H dulu';

function inAlarm() {
  const sim = createSim();
  sim.grbl.alarm = true;
  sim.rx('ALARM:2');
  sim.rx('<Alarm|MPos:0.000,0.000,0.000|FS:0,0>');
  return sim;
}

test('in ALARM: G-code typed in the console is refused with the alarm message, nothing written', () => {
  const sim = inAlarm();
  const before = sim.wire.length;
  sim.type('G0 X10');
  assert.equal(sim.wire.length, before);
  assert.deepEqual(sim.state().gcodeQueue, []);
  assert.equal(sim.log.filter((l) => l.command === 'G0 X10' && l.response.includes(ALARM_MSG)).length, 1, JSON.stringify(sim.log));
});

test('in ALARM: $X, $H, $$, $I and $G are allowed', () => {
  for (const cmd of ['$X', '$H', '$$', '$I', '$G']) {
    const sim = inAlarm();
    sim.type(cmd);
    assert.equal(sim.wire[sim.wire.length - 1], cmd + '\n', cmd);
  }
});

test('in ALARM: a $J= jog (button or console) is refused like G-code', () => {
  const sim = inAlarm();
  sim.handlers.jog('X,10,1000');
  sim.type('$J=G91 X1 F100');
  assert.ok(!sim.wire.some((w) => w.startsWith('$J=')), JSON.stringify(sim.wire));
  assert.equal(sim.log.filter((l) => l.response.includes(ALARM_MSG)).length, 2);
});

test('in ALARM: realtime bytes still go out ("?", ctrl-x)', () => {
  const sim = inAlarm();
  sim.type('?');
  assert.equal(sim.wire[sim.wire.length - 1], '?');
  sim.restart();
  assert.equal(sim.wire[sim.wire.length - 1], CTRL_X);
});

test('in ALARM: a job start is refused with the alarm message and leaves nothing behind', () => {
  const sim = inAlarm();
  sim.ctx.runJob({ isJob: true, data: 'G1 X1 F100\nG1 X2', fileName: 'f.nc' });
  assert.deepEqual(sim.state().gcodeQueue, []);
  assert.equal(sim.ctx.jobStartTime, false);
  assert.equal(sim.log.filter((l) => l.command === 'f.nc' && l.response.includes(ALARM_MSG)).length, 1);
});

test('after $X ("[MSG:Caution: Unlocked]") G-code is accepted again', () => {
  const sim = inAlarm();
  sim.type('$X');
  sim.grbl.answer();
  sim.type('G0 X10');
  assert.equal(sim.wire[sim.wire.length - 1], 'G0 X10\n');
});

test('the controller\'s own status ends the alarm too (e.g. after $H: "Idle")', () => {
  const sim = inAlarm();
  sim.rx('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
  sim.type('G0 X10');
  assert.equal(sim.wire[sim.wire.length - 1], 'G0 X10\n');
});

test('coming up alarm-locked after a reset ("\'$H\'|\'$X\' to unlock") counts as ALARM', () => {
  const sim = createSim();
  sim.grbl.alarm = true;
  sim.restart();
  sim.grbl.answer(); // banner + unlock message
  sim.type('G0 X10');
  assert.ok(!sim.wire.includes('G0 X10\n'));
  sim.type('$X');
  assert.equal(sim.wire[sim.wire.length - 1], '$X\n');
});

// --- ALARM mid-job without a reset --------------------------------------------

function alarmMidJobWithoutReset() {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: 'G1 X1 F100\nG1 X2\nG1 X3\nG1 X4', fileName: 'g.nc' });
  sim.grbl.answer(1); // line 1 ok -> line 2 in flight
  sim.grbl.alarm = true;
  sim.rx('ALARM:2'); // no banner: the controller did not reset
  return sim;
}

test('ALARM mid-job (no reset): unsent lines are dropped with a log line, never streamed later', () => {
  const sim = alarmMidJobWithoutReset();
  assert.equal(sim.unsent(), 0);
  assert.deepEqual(sim.logged('2 baris'), ['[] 2 baris belum terkirim dibatalkan karena ALARM (G1 X3, G1 X4)']);
  sim.grbl.answer(); // G1 X2 -> error:9
  sim.type('$X');
  sim.grbl.answer();
  assert.ok(!sim.wire.some((w) => /^G1 X[34]/.test(w)), JSON.stringify(sim.wire));
});

test('ALARM mid-job: the job is stopped once ("alarm"), recovery record "interrupted"', () => {
  const sim = alarmMidJobWithoutReset();
  const stopped = sim.eventsOf('jobStopped');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].reason, 'alarm');
  assert.equal(sim.ctx.jobRecovery.peek().state, 'interrupted');
});

test('ALARM mid-job: the line already in flight keeps its own answer (error:9 shown against G1 X2), no timeout message', () => {
  const sim = alarmMidJobWithoutReset();
  sim.grbl.answer();
  assert.ok(sim.log.some((l) => l.command === 'G1 X2' && l.response === 'error:9'), JSON.stringify(sim.log));
  sim.advance(5000);
  assert.ok(!sim.log.some((l) => /timeout setelah ALARM/.test(l.response)));
  assert.deepEqual(sim.state().sentBuffer, []);
});

test('ALARM mid-job, the line in flight is NEVER answered: after 3 s it is forgotten with a log line, and $X then gets its own answer', () => {
  const sim = alarmMidJobWithoutReset();
  sim.grbl.inbox = []; // the controller lost it
  sim.advance(2999);
  assert.deepEqual(sim.state().sentBuffer, ['G1 X2'], 'kept until the timeout');
  sim.advance(1);
  assert.deepEqual(sim.state().sentBuffer, []);
  assert.deepEqual(sim.logged('1 jawaban'), ['[] 1 jawaban dibatalkan (timeout setelah ALARM)']);
  sim.type('$X');
  sim.grbl.answer();
  assert.deepEqual(sim.log.filter((l) => l.command === '$X').map((l) => l.response), ['[MSG:Caution: Unlocked]', 'ok']);
});

test('while pre-alarm lines may still be answered, a new operator line is held back with a message (its "ok" would pair with one of them)', () => {
  const sim = alarmMidJobWithoutReset();
  sim.grbl.inbox = [];
  sim.advance(1000);
  const before = sim.wire.length;
  sim.type('$X');
  assert.equal(sim.wire.length, before, 'not written yet');
  assert.equal(sim.log.filter((l) => l.command === '$X' && /sebelum ALARM/.test(l.response)).length, 1);
  sim.advance(2000); // timeout
  sim.type('$X');
  assert.equal(sim.wire[sim.wire.length - 1], '$X\n');
});

test('the Mythos hard-limit order (banner BEFORE "ALARM:1") leaves nothing pending: $X can be sent right away', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: 'G1 Y-100 F50\nG1 Y-200\nG1 Y-300', fileName: 'h.nc' });
  sim.grbl.answer(1);
  sim.grbl.hardLimit();
  sim.grbl.answer(); // banner of the auto ctrl-x
  sim.type('$X');
  assert.equal(sim.wire[sim.wire.length - 1], '$X\n');
  assert.ok(!sim.log.some((l) => /timeout setelah ALARM/.test(l.response)));
});

test('a reset during the timeout window cancels it cleanly (no late "dibatalkan" for a fresh command)', () => {
  const sim = alarmMidJobWithoutReset();
  sim.grbl.inbox = [];
  sim.restart();
  sim.grbl.answer(); // banner
  sim.type('$X');
  sim.advance(5000);
  assert.ok(!sim.log.some((l) => /timeout setelah ALARM/.test(l.response)), JSON.stringify(sim.log));
  assert.deepEqual(sim.state().sentBuffer, ['$X'], 'the fresh $X is still waiting for its own answer, not dropped by a stale timer');
});
