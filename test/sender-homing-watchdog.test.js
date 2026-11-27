// The status watchdog must not call a homing board "disconnected" (bench
// 27 Nov 2026: $H -> "Koneksi ke controller terputus (tidak ada balasan dari
// controller selama 3 detik)" in the middle of the homing cycle).
//
// GRBL Mythos (CUSTOM_FIXED49_HOMING50, limits.c limits_go_home) runs the
// homing loop WITHOUT protocol_execute_realtime() - "No time to run
// protocol_execute_realtime() in this loop" - and protocol.c's only status
// report site is inside protocol_exec_rt_system(). So from $H until the cycle
// ends the board answers no "?" at all, by design. Every other long command
// does serve "?": M6/tool change (tool_change.c), probing and G4 (via
// protocol_buffer_synchronize / delay_sec DWELL), jogs, $TLS/$TCZ (no motion),
// $RST and $N= writes (STM32 flash page: well under 100 ms).
//
// Now: while a homing command is in flight (sent, its ok/error not yet in, no
// ALARM since) silence is expected; the loss is then caught by the port's own
// close/error events and write errors, and by a safety bound - the longest
// the cycle can take from the board's own settings ($130-$132 x 1.5 / $25 per
// axis plus the locate moves), never less than 120 s.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSim } = require('./helpers/serial-sim');

const lost = (sim) => sim.log.filter((l) => l.command === 'disconnect' && /terputus/.test(l.response));

function homingSim() {
  const sim = createSim();
  sim.ctx.lastControllerRx = sim.ctx.Date.now();
  // $H starts the cycle; the board then goes quiet until it is done
  sim.grbl.on(/^\$H/, (line, g) => { g.homing = true; return []; });
  return sim;
}

function endHoming(sim, reply = 'ok') {
  sim.grbl.homing = false;
  sim.rx(reply);
}

test('bench: $H, then 60 s with no answer to "?" -> still connected, $H still awaited', () => {
  const sim = homingSim();
  sim.poll(1000);
  sim.type('$H'); sim.grbl.answer();
  sim.poll(60000);
  assert.deepEqual(lost(sim), [], JSON.stringify(sim.log.slice(-3)));
  assert.equal(sim.ctx.status.comms.connectionStatus, 2);
  assert.deepEqual(sim.state().sentBuffer, ['$H']);
});

test('homing done ("ok"), then the USB device vanishes -> detected within ~3 s as before', () => {
  const sim = homingSim();
  sim.type('$H'); sim.grbl.answer();
  sim.poll(45000);
  endHoming(sim);
  sim.poll(1000);
  assert.deepEqual(sim.state().sentBuffer, []);
  sim.grbl.dead = true;
  sim.poll(2800);
  assert.equal(sim.ctx.status.comms.connectionStatus, 2, 'not before 3 s of silence');
  sim.poll(600);
  assert.equal(sim.ctx.status.comms.connectionStatus, 0);
  assert.equal(lost(sim).length, 1);
  assert.match(lost(sim)[0].response, /tidak ada balasan dari controller selama 3 detik/);
});

test('the Home button path ($H from the jog panel = the same console command) and a $H line inside a job are covered alike', () => {
  const sim = homingSim();
  sim.ctx.runJob({ isJob: true, data: 'G21\n$H\nG0 X1', fileName: 'h.nc' });
  sim.grbl.answer(1); // G21 ok (and its $G)
  sim.grbl.answer(2);
  sim.grbl.answer(1); // $H: board goes quiet
  assert.ok(sim.grbl.homing, 'the mock is homing now: ' + JSON.stringify(sim.state().sentBuffer));
  sim.poll(30000);
  assert.deepEqual(lost(sim), []);
});

test('homing that never ends: disconnected after the safety bound (120 s minimum), with a homing reason', () => {
  const sim = homingSim();
  sim.type('$H'); sim.grbl.answer();
  sim.poll(119000);
  assert.deepEqual(lost(sim), [], 'not before 120 s');
  sim.poll(1600);
  assert.equal(sim.ctx.status.comms.connectionStatus, 0);
  assert.equal(lost(sim).length, 1);
  assert.match(lost(sim)[0].response, /homing tidak selesai dalam 120 detik/);
  assert.ok(sim.log.some((l) => l.response === '1 perintah terkirim tanpa jawaban dibatalkan karena port terputus/ditutup ($H)'), JSON.stringify(sim.log.slice(-4)));
});

test('the bound follows the board\'s own settings ($$ dump): long travel, slow seek -> waits longer than 120 s', () => {
  const sim = homingSim();
  // 1.5 x (1000 + 800 + 150) / 500 mm/min = 351 s search, + locate (3 axes x
  // 2 x 5 x 2 mm / 100 mm/min + 2 x 2 mm / 500 mm/min = 37.4 s) + debounce
  for (const l of ['$24=100.000', '$25=500.000', '$26=250', '$27=2.000', '$130=1000.000', '$131=800.000', '$132=150.000']) sim.rx(l);
  sim.type('$H'); sim.grbl.answer();
  sim.poll(380000);
  assert.deepEqual(lost(sim), [], 'still inside ~391 s');
  sim.poll(15000);
  assert.equal(lost(sim).length, 1);
  assert.match(lost(sim)[0].response, /homing tidak selesai dalam 391 detik/);
});

test('a setting written from the console ($25=) counts once the board accepts it', () => {
  const sim = homingSim();
  for (const l of ['$24=100.000', '$25=500.000', '$27=2.000', '$130=1000.000', '$131=800.000', '$132=150.000']) sim.rx(l);
  sim.type('$25=3000');
  sim.grbl.answer();
  assert.equal(sim.ctx.homingTimeoutMs(), 120000, 'faster seek -> the 120 s minimum: ' + sim.ctx.homingTimeoutMs());
});

test('$RST: what was learnt about the settings is forgotten (back to the 120 s minimum)', () => {
  const sim = homingSim();
  for (const l of ['$24=100.000', '$25=500.000', '$27=2.000', '$130=1000.000', '$131=800.000', '$132=150.000']) sim.rx(l);
  assert.ok(sim.ctx.homingTimeoutMs() > 120000);
  sim.type('$RST=$');
  sim.grbl.answer();
  assert.equal(sim.ctx.homingTimeoutMs(), 120000);
});

test('homing ends with an error (e.g. $HX on a build without single-axis homing): the 3 s watchdog is back', () => {
  const sim = homingSim();
  sim.type('$HX'); sim.grbl.answer();
  sim.poll(10000);
  endHoming(sim, 'error:3');
  sim.grbl.dead = true;
  sim.poll(3400);
  assert.equal(lost(sim).length, 1);
  assert.match(lost(sim)[0].response, /selama 3 detik/);
});

test('homing ends in ALARM (switch not found, no "ok" for $H yet): the 3 s watchdog is back', () => {
  const sim = homingSim();
  sim.type('$H'); sim.grbl.answer();
  sim.poll(20000);
  sim.grbl.homing = false;
  sim.rx('ALARM:9');
  sim.grbl.dead = true;
  sim.poll(3400);
  assert.equal(lost(sim).length, 1, JSON.stringify(sim.log.slice(-4)));
  assert.match(lost(sim)[0].response, /selama 3 detik/);
});

test('during homing a port "close" or a write error is still caught at once', () => {
  const sim = homingSim();
  sim.type('$H'); sim.grbl.answer();
  sim.poll(5000);
  sim.ctx.port.isOpen = false; // the port reports itself gone
  sim.poll(400);
  assert.equal(sim.ctx.status.comms.connectionStatus, 0);
  assert.equal(lost(sim).length, 1);

  const sim2 = homingSim();
  sim2.type('$H'); sim2.grbl.answer();
  sim2.poll(5000);
  sim2.ctx.onPortWriteDone(new Error('Access denied'));
  assert.equal(sim2.ctx.status.comms.connectionStatus, 0);
  assert.match(lost(sim2)[0].response, /gagal menulis ke port: Access denied/);
});

test('only homing commands pause the watchdog: a long M6 / jog / G4 still has "?" answered, and a dead port is caught in 3 s', () => {
  for (const cmd of ['M6 T2', '$J=G91 X500 F100', 'G4 P30', '$TLS', '$341=3']) {
    const sim = createSim();
    sim.ctx.lastControllerRx = sim.ctx.Date.now();
    sim.grbl.on(/.*/, () => []); // long-running: no "ok" yet
    sim.type(cmd);
    sim.grbl.dead = true;
    sim.poll(3400);
    assert.equal(lost(sim).length, 1, cmd);
  }
});
