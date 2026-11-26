// Log labels follow the real pairing; lines the controller prints on its own
// carry no command label.
//
// Every received line used to be logged with sentBuffer[0] - whatever command
// was oldest in flight - as its label. With stale entries that gave the bench
// findings (banner logged as "[$309=1]", $Y/ISRDIAG output as "[$G]"); and
// even with a correct sentBuffer, a spontaneous line (banner, ALARM, the
// reset's "'$H'|'$X' to unlock", Mythos boot/E-stop messages) arriving while
// some command was in flight was shown as that command's answer.
//
// Replies that come before their own command's ok/error - "[MSG:Caution:
// Unlocked]" ($X), "[MSG:$309: reset to apply]", "[MSG:A is Y2 ($309=1):
// A10.000]" (bench_a0_log.txt) - keep that command's label.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSim, BANNER } = require('./helpers/serial-sim');

function withCommandInFlight() {
  const sim = createSim();
  sim.type('$$'); // written, not answered
  return sim;
}

test('ALARM:N is logged unlabelled, and neither its log line nor its dialog names the command in flight', () => {
  const sim = withCommandInFlight();
  sim.rx('ALARM:2');
  const alarmLines = sim.log.filter((l) => /ALARM/.test(l.response));
  assert.ok(alarmLines.length > 0);
  for (const l of alarmLines) {
    assert.equal(l.command, '', JSON.stringify(l));
    assert.ok(!/\$\$/.test(l.response), JSON.stringify(l));
  }
  const toast = sim.eventsOf('toastErrorAlarm');
  assert.equal(toast.length, 1);
  assert.ok(!/\[ \$\$ \]/.test(toast[0]), toast[0]);
});

test('the banner is logged unlabelled even with a command in flight', () => {
  const sim = withCommandInFlight();
  sim.grbl.inbox = [];
  sim.rx(BANNER);
  assert.deepEqual(sim.logged('Grbl 1.1f'), ['[] ' + BANNER]);
});

for (const msg of ["[MSG:Reset to continue]", "[MSG:Check Limits]", "[MSG:'$H'|'$X' to unlock]", '[MSG:E-stop active]', '[MSG:RST:POR PIN ]', '[MSG:Power-on: machine position reset - re-zero work coordinates]', '[MSG:Tool change T2: ganti tool lalu tekan Cycle Start]']) {
  test('spontaneous ' + msg + ' arriving while $$ is in flight is logged unlabelled', () => {
    const sim = withCommandInFlight();
    sim.rx(msg);
    assert.deepEqual(sim.logged(msg.slice(0, 10)).filter((l) => l.includes(msg)), ['[] ' + msg]);
  });
}

test('replies keep their own command\'s label (bench 20:22:41): "[MSG:$309: reset to apply]" is shown against $309=0', () => {
  const sim = createSim();
  sim.grbl.on(/^\$309=0$/, ['[MSG:$309: reset to apply]', 'ok']);
  sim.type('$309=0');
  sim.grbl.answer();
  assert.deepEqual(sim.log.filter((l) => l.command === '$309=0').map((l) => l.response), ['[MSG:$309: reset to apply]', 'ok']);
});

test('replies keep their own command\'s label (bench 20:23:48): the A10 rejection is shown against G91 G1 A10, not the next command', () => {
  const sim = createSim();
  sim.grbl.on(/A10/, ['[MSG:A is Y2 ($309=1): A10.000]', 'error:33']);
  sim.type('G91 G1 A10 F1000');
  sim.grbl.answer();
  sim.type('G90 G0 A0');
  sim.grbl.answer();
  assert.deepEqual(sim.log.filter((l) => l.command === 'G91 G1 A10 F1000').map((l) => l.response), ['[MSG:A is Y2 ($309=1): A10.000]', 'error:33']);
  assert.deepEqual(sim.log.filter((l) => l.command === 'G90 G0 A0').map((l) => l.response), ['ok']);
});

test('$Y / ISRDIAG output is labelled $Y (bench: it was shown as [$G])', () => {
  const sim = createSim();
  sim.grbl.on(/^\$Y$/, ['[MSG:ISR window=1000ms TIM2 n=1600 avg=249 load=155/1000]', '[MSG:ISR max cyc first=265]', 'ok']);
  sim.type('$G');
  sim.type('$Y');
  sim.grbl.answer();
  assert.deepEqual(sim.log.filter((l) => l.command === '$Y').map((l) => l.response.slice(0, 9)), ['[MSG:ISR ', '[MSG:ISR ', 'ok']);
  assert.ok(!sim.log.some((l) => l.command === '$G' && /ISR/.test(l.response)));
});

test('Clear Alarm (ribbon): the reset\'s own "\'$H\'|\'$X\' to unlock" is not shown as $X\'s answer', () => {
  const sim = createSim();
  sim.grbl.alarm = true;
  sim.handlers.clearAlarm(2);
  sim.grbl.answer(); // banner + "'$H'|'$X' to unlock" (+ $X sent on the banner)
  sim.grbl.answer();
  assert.deepEqual(sim.log.filter((l) => l.command === '$X').map((l) => l.response), ['[MSG:Caution: Unlocked]', 'ok']);
  assert.deepEqual(sim.logged("[MSG:'$H'"), ["[] [MSG:'$H'|'$X' to unlock]"]);
});

test('errors still name the line they belong to (unchanged)', () => {
  const sim = createSim();
  sim.grbl.on(/^FOO$/, ['error:20']);
  sim.type('FOO');
  sim.grbl.answer();
  assert.ok(sim.log.some((l) => /error: 20 .*\[ FOO \]/.test(l.response)), JSON.stringify(sim.log));
});
