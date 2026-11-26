// An "error:N" from the controller ends the job.
//
// The error handler used to stop streaming but leave the job's remaining
// lines in gcodeQueue. The controller is NOT locked after an error, so the
// next "ok" from ANY later command - even an "$X" typed to recover - made
// send1Q() stream the rest of the old job before the operator's own command:
// the machine moved without anyone asking it to. The same leftover is what
// kept "Job Queue: 1" on screen after a rejected console line (the "$G" that
// addQToEnd() appends after a modal command).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSim } = require('./helpers/serial-sim');

const JOB = 'G1 X1 F100\nG1 X2\nG1 X3\nG1 X4';

function errorOnSecondLine() {
  const sim = createSim();
  sim.grbl.on(/^G1 X2$/, ['error:20']);
  sim.ctx.runJob({ isJob: true, data: JOB, fileName: 'a.nc' });
  sim.grbl.answer(); // line 1 ok -> line 2 sent -> error:20
  return sim;
}

test('error mid-job: the job\'s remaining lines are never sent - not even when the operator then types $X', () => {
  const sim = errorOnSecondLine();
  const before = sim.wire.length;
  sim.type('$X');
  sim.grbl.answer();
  assert.deepEqual(sim.wire.slice(before), ['$X\n'], 'only the operator\'s own command goes out');
  assert.ok(!sim.wire.some((w) => /^G1 X[34]/.test(w)), JSON.stringify(sim.wire));
});

test('error mid-job: nothing is left to send, and the UI queue counter goes to 0', () => {
  const sim = errorOnSecondLine();
  assert.equal(sim.unsent(), 0);
  assert.equal(sim.eventsOf('queueCount').pop()[0], 0);
});

test('error mid-job: the log says how many unsent lines were cancelled, and which', () => {
  const sim = errorOnSecondLine();
  assert.deepEqual(sim.logged('2 baris'), ['[] 2 baris belum terkirim dibatalkan karena error (G1 X3, G1 X4)']);
});

test('error mid-job: the job is stopped (one jobStopped, reason "error"), recovery record "stopped" pointing at the rejected line, not past it', () => {
  const sim = errorOnSecondLine();
  const stopped = sim.eventsOf('jobStopped');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].reason, 'error');
  const rec = sim.ctx.jobRecovery.peek();
  assert.equal(rec.state, 'stopped');
  assert.ok(rec.resumeLine <= 2, 'resume at or before the rejected line 2, got ' + rec.resumeLine);
});

test('error mid-job: the error itself is still reported against the line that caused it', () => {
  const sim = errorOnSecondLine();
  assert.ok(sim.log.some((l) => l.command === 'G1 X2' && l.response === 'error:20'), JSON.stringify(sim.log));
});

test('a rejected modal console line (bench: G91 G1 A10 -> error:33) leaves no auto "$G" behind - Job Queue 0, the next command goes out first', () => {
  const sim = createSim();
  sim.grbl.on(/A10/, ['[MSG:A is Y2 ($309=1): A10.000]', 'error:33']);
  sim.type('G91 G1 A10 F1000');
  sim.grbl.answer();
  assert.equal(sim.unsent(), 0, 'nothing left queued');
  assert.equal(sim.eventsOf('queueCount').pop()[0], 0, 'Job Queue: 0');
  const before = sim.wire.length;
  sim.type('G90 G0 A0');
  assert.equal(sim.wire[before], 'G90 G0 A0\n', 'the operator\'s command is the next line written');
  sim.grbl.answer();
  assert.deepEqual(sim.log.filter((l) => l.command === 'G90 G0 A0').map((l) => l.response), ['ok']);
});

test('a multi-line console paste with an error on the first line: the rest is cancelled, with a message', () => {
  const sim = createSim();
  sim.grbl.on(/^G0 X999$/, ['error:15']);
  sim.type('G0 X999\nG0 Y1\nG0 Z1');
  sim.grbl.answer();
  assert.ok(!sim.wire.some((w) => /^G0 [YZ]1/.test(w)), JSON.stringify(sim.wire));
  assert.equal(sim.unsent(), 0);
  assert.equal(sim.logged('').filter((l) => /dibatalkan karena error/.test(l)).length, 1);
});

test('a lone console typo (nothing else queued): just the error, no "dibatalkan" message, and the next command works normally', () => {
  const sim = createSim();
  sim.grbl.on(/^FOO$/, ['error:20']);
  sim.type('FOO');
  sim.grbl.answer();
  assert.ok(!sim.log.some((l) => /dibatalkan/.test(l.response)), JSON.stringify(sim.log));
  sim.type('$G');
  sim.grbl.answer();
  assert.deepEqual(sim.logged('[GC:'), ['[$G] [GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]']);
});

test('regression guard: after an earlier "ok", the error pairs with the line it belongs to and the rest of the paste is not sent', () => {
  const sim = createSim();
  sim.grbl.on(/^G0 X999$/, ['error:15']);
  sim.type('G4 P0\nG0 X999\nG0 Y5'); // runCommand sends one, each ok sends the next
  sim.grbl.answer(1); // "G4 P0" -> ok -> "G0 X999" sent
  sim.grbl.answer(1); // error:15
  assert.ok(sim.log.some((l) => l.command === 'G0 X999' && l.response === 'error:15'));
  assert.ok(!sim.wire.some((w) => w === 'G0 Y5\n'));
});
