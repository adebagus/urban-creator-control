// The bench sequence that must pass before a release (it is run on the real
// board too - test/MANUAL-REGRESSION-CHECKLIST.md, P12):
//
//   $309=1, $21=1, slow Y move, trip the limit -> ALARM:1 -> Restart Grbl (NOT
//   Clear Alarm) -> $X -> $309=0 -> Restart -> G91 G1 A10 -> $309=1 -> Restart
//   -> G90 G0 A0 must be "ok", Job Queue 0.
//
// Bench 26 Nov 2026 (firmware proven clean on a direct serial line,
// GRBL_Mythos bench_a0_log.txt) showed UC CONTROL logging the banner as
// "[$309=1]" and G90 G0 A0 as rejected, an old line's error pasted onto it.
// The mock below adds the Mythos $309 behaviour on top of serial-sim's
// controller: a $309 change takes effect at the next reset ("[MSG:$309: reset
// to apply]"), and in mode 1 an A word that is not 0 is rejected with
// "[MSG:A is Y2 ($309=1): A<n>]" + error:33.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSim } = require('./helpers/serial-sim');

function mythosBoard() {
  const sim = createSim();
  const board = { mode309: 1, pending309: 1 }; // 4A-AS: $309=1 by default
  sim.grbl.on(/^\$309=[01]$/, (line) => {
    board.pending309 = parseInt(line.slice(5), 10);
    return board.pending309 === board.mode309 ? ['ok'] : ['[MSG:$309: reset to apply]', 'ok'];
  });
  sim.grbl.on(/A-?\d/i, (line, grbl) => {
    if (grbl.alarm) return ['error:9'];
    const a = /A(-?[\d.]+)/i.exec(line);
    if (board.mode309 === 1 && a && parseFloat(a[1]) !== 0) return ['[MSG:A is Y2 ($309=1): A' + parseFloat(a[1]).toFixed(3) + ']', 'error:33'];
    return ['ok'];
  });
  const originalReceive = sim.grbl.receive.bind(sim.grbl);
  sim.grbl.receive = (s) => { // a reset latches the pending $309 value
    if (s.includes(String.fromCharCode(0x18))) board.mode309 = board.pending309;
    originalReceive(s);
  };
  const originalHardLimit = sim.grbl.hardLimit.bind(sim.grbl);
  sim.grbl.hardLimit = () => { board.mode309 = board.pending309; originalHardLimit(); };
  return { sim, board };
}

// After every step: nothing queued, nothing waiting for an answer.
function assertIdle(sim, where) {
  assert.equal(sim.unsent(), 0, where + ': nothing left to send');
  assert.deepEqual(sim.state().sentBuffer, [], where + ': nothing waiting for an answer');
}

function answersOf(sim, cmd) {
  return sim.log.filter((l) => l.command === cmd).map((l) => l.response);
}

test('BENCH: $309=1, $21=1, Y move, limit -> ALARM:1 -> Restart Grbl -> $X -> $309=0 -> Restart -> G91 G1 A10 -> $309=1 -> Restart -> G90 G0 A0 is "ok", Job Queue 0', () => {
  const { sim, board } = mythosBoard();

  sim.type('$309=1'); sim.grbl.answer();
  assert.deepEqual(answersOf(sim, '$309=1'), ['ok']);
  sim.type('$21=1'); sim.grbl.answer();
  assert.deepEqual(answersOf(sim, '$21=1'), ['ok']);
  assertIdle(sim, '$21=1');

  sim.type('G21 G91 G1 Y60 F60'); sim.grbl.answer();
  assert.deepEqual(answersOf(sim, 'G21 G91 G1 Y60 F60'), ['ok']);

  // the Y2 switch trips: Mythos resets itself, then reports the alarm
  sim.grbl.hardLimit();
  sim.grbl.answer(); // banner of the sender's automatic ctrl-x on "[MSG:Reset to continue]"
  assertIdle(sim, 'after ALARM:1');
  assert.ok(sim.log.some((l) => l.command === '' && l.response.startsWith('ALARM: 1')), 'ALARM logged, unlabelled');

  sim.restart(); sim.grbl.answer(); // Restart Grbl, NOT Clear Alarm
  assertIdle(sim, 'Restart after ALARM');
  assert.ok(sim.log.filter((l) => l.response.startsWith('Grbl 1.1f')).every((l) => l.command === ''), 'every banner unlabelled');

  sim.type('$X'); sim.grbl.answer();
  assert.deepEqual(answersOf(sim, '$X'), ['[MSG:Caution: Unlocked]', 'ok']);

  sim.type('$309=0'); sim.grbl.answer();
  assert.deepEqual(answersOf(sim, '$309=0'), ['[MSG:$309: reset to apply]', 'ok']);
  sim.restart(); sim.grbl.answer();
  assert.equal(board.mode309, 0);
  assertIdle(sim, 'Restart after $309=0');

  sim.type('G91 G1 A10'); sim.grbl.answer();
  assert.deepEqual(answersOf(sim, 'G91 G1 A10'), ['ok'], 'mode 0: A is a real axis');

  sim.type('$309=1'); sim.grbl.answer();
  assert.ok(answersOf(sim, '$309=1').includes('[MSG:$309: reset to apply]'));
  sim.restart(); sim.grbl.answer();
  assert.equal(board.mode309, 1);
  assertIdle(sim, 'Restart after $309=1');

  sim.type('G90 G0 A0'); sim.grbl.answer();
  assert.deepEqual(answersOf(sim, 'G90 G0 A0'), ['ok'], 'G90 G0 A0 answered "ok" against itself: ' + JSON.stringify(sim.log.slice(-8)));
  assertIdle(sim, 'G90 G0 A0');
  assert.equal(sim.eventsOf('queueCount').pop()[0], 0, 'Job Queue 0');
  assert.ok(!sim.log.some((l) => /error:33/.test(l.response)), 'no A10 rejection anywhere in this run');
});

test('BENCH variant: an A10 in mode 1 is rejected against ITSELF, and the G90 G0 A0 right after still gets "ok"', () => {
  const { sim } = mythosBoard();
  sim.type('G91 G1 A10 F1000'); sim.grbl.answer();
  assert.deepEqual(answersOf(sim, 'G91 G1 A10 F1000'), ['[MSG:A is Y2 ($309=1): A10.000]', 'error:33']);
  sim.restart(); sim.grbl.answer();
  sim.type('G90 G0 A0'); sim.grbl.answer();
  assert.deepEqual(answersOf(sim, 'G90 G0 A0'), ['ok']);
  assertIdle(sim, 'end');
  assert.equal(sim.eventsOf('queueCount').pop()[0], 0);
});

test('BENCH variant: commands typed while the board is still in ALARM after Restart - G-code refused with a message, $X goes, nothing left behind', () => {
  const { sim } = mythosBoard();
  sim.type('$21=1'); sim.grbl.answer();
  sim.grbl.hardLimit(); sim.grbl.answer();
  sim.restart(); sim.grbl.answer();
  sim.type('G90 G0 A0');
  assert.ok(sim.log.some((l) => l.command === 'G90 G0 A0' && /Mesin ALARM/.test(l.response)));
  assertIdle(sim, 'refused');
  sim.type('$X'); sim.grbl.answer();
  sim.type('G90 G0 A0'); sim.grbl.answer();
  assert.deepEqual(answersOf(sim, 'G90 G0 A0').slice(-1), ['ok']);
  assertIdle(sim, 'end');
});
