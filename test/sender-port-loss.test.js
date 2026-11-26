// A USB port that vanishes without serialport saying so, and commands that
// must never disappear without a log line (bench P12, 27 Nov 2026).
//
// Bench: Pause -> USB pulled -> plugged back. The board kept power, only its
// USB-CDC device re-enumerated. serial.log shows NO "close" and NO "error"
// between opening COM8 and the manual Disconnect six minutes later: the old
// handle just went quiet. The UI kept showing "connected to COM8", Hold:0,
// Job Queue 54, and $I typed in the console vanished with no message - both
// while the dead port was undetected and during a connect handshake.
//
// Now: Grbl answers "?" at once in every state (Mythos too, also with E-stop
// held - GRBL_Mythos ESTOP_V2.md), so 3 s without any line from the
// controller on a polled USB connection means the port is gone - the same
// handling as a "close": disconnected, job stopped (recovery "interrupted"),
// and every unsent / unanswered operator line named in the log. Every command
// that is not sent says why. The sender's own "$G" lines are never counted.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSim, BANNER } = require('./helpers/serial-sim');

function connectedAndPolling() {
  const sim = createSim();
  sim.startStatusPolling();
  return sim;
}

const lost = (sim) => sim.log.filter((l) => l.command === 'disconnect' && /terputus/.test(l.response));

// --------------------------------------------------------------- (a) detection

test('board alive, answering "?": still connected after 10 s of silence on every other channel', () => {
  const sim = connectedAndPolling();
  sim.poll(10000);
  assert.equal(sim.ctx.status.comms.connectionStatus, 2);
  assert.deepEqual(lost(sim), []);
});

test('USB device gone without a close/error event: detected within 3 s - disconnected, port closed, one clear log line', () => {
  const sim = connectedAndPolling();
  sim.poll(1000);
  sim.grbl.dead = true;
  sim.poll(2800);
  assert.equal(sim.ctx.status.comms.connectionStatus, 2, 'not before 3 s of silence');
  sim.poll(600);
  assert.equal(sim.ctx.status.comms.connectionStatus, 0, 'disconnected');
  assert.equal(sim.ctx.status.comms.interfaces.activePort, false, 'the UI stops showing a live COM port');
  assert.equal(sim.ctx.port.isOpen, false, 'the dead handle is closed, so the same COM can be opened again');
  assert.equal(lost(sim).length, 1);
  assert.match(lost(sim)[0].response, /tidak ada balasan dari controller selama 3 detik/);
});

test('bench: job paused, USB gone -> disconnected, job stopped (record "interrupted"), Job Queue 0, its unsent lines named in the log', () => {
  const sim = connectedAndPolling();
  const lines = [];
  for (let i = 1; i <= 60; i++) lines.push('G1 X' + i + ' F500');
  sim.ctx.runJob({ isJob: true, data: lines.join('\n'), fileName: 'bench.nc' });
  for (let i = 0; i < 6; i++) sim.grbl.answer(1);
  sim.ctx.status.comms.connectionStatus = 3;
  sim.ctx.pause();
  sim.grbl.dead = true;
  sim.poll(4000);
  const s = sim.state();
  assert.equal(s.connectionStatus, 0);
  assert.equal(s.paused, false);
  assert.deepEqual(s.gcodeQueue, []);
  assert.deepEqual(s.sentBuffer, []);
  assert.equal(sim.eventsOf('queueCount').pop()[0], 0, 'Job Queue 0');
  assert.equal(sim.eventsOf('jobStopped').length, 1);
  assert.equal(sim.ctx.jobRecovery.peek().state, 'interrupted');
  assert.ok(sim.log.some((l) => /^5[0-9] baris belum terkirim dibatalkan karena port terputus\/ditutup \(G1 X/.test(l.response)), JSON.stringify(sim.log.slice(-4)));
});

test('a command already written into the dead port is named too: "terkirim tanpa jawaban"', () => {
  const sim = connectedAndPolling();
  sim.grbl.dead = true;
  sim.type('$I'); // written into the void - the port does not know yet
  sim.poll(3400);
  assert.ok(sim.log.some((l) => l.response === '1 perintah terkirim tanpa jawaban dibatalkan karena port terputus/ditutup ($I)'), JSON.stringify(sim.log));
});

test('a long command without its "ok" yet (e.g. $H) does NOT trip the watchdog while "?" is still answered', () => {
  const sim = connectedAndPolling();
  sim.grbl.on(/^\$H$/, () => []); // homing: no "ok" for a long time
  sim.type('$H');
  sim.poll(10000);
  assert.equal(sim.ctx.status.comms.connectionStatus, 2);
  assert.deepEqual(sim.state().sentBuffer, ['$H'], 'still waiting for it, as it should');
});

test('the port reports itself not open while we think we are connected: disconnected at the next poll', () => {
  const sim = connectedAndPolling();
  sim.ctx.port.isOpen = false;
  sim.poll(200);
  assert.equal(sim.ctx.status.comms.connectionStatus, 0);
  assert.match(lost(sim)[0].response, /port tidak terbuka lagi/);
});

test('a write to the port fails: disconnected with that reason', () => {
  const sim = connectedAndPolling();
  sim.ctx.port.write = (s, cb) => { if (cb) cb(new Error('Access denied')); };
  sim.type('$G');
  assert.equal(sim.ctx.status.comms.connectionStatus, 0);
  assert.match(lost(sim)[0].response, /gagal menulis ke port: Access denied/);
});

test('the watchdog only watches USB (a telnet link is left to its own close/error events)', () => {
  const sim = connectedAndPolling();
  sim.ctx.status.comms.interfaces.type = 'telnet';
  sim.grbl.dead = true;
  sim.poll(10000);
  assert.equal(sim.ctx.status.comms.connectionStatus, 2);
});

test('after the loss: reconnect (banner) works and nothing of the old job is sent again', () => {
  const sim = connectedAndPolling();
  sim.ctx.runJob({ isJob: true, data: 'G1 X1 F100\nG1 X2\nG1 X3', fileName: 'r.nc' });
  sim.grbl.answer(1);
  sim.grbl.dead = true;
  sim.poll(3400);
  // plug back in + Connect
  sim.grbl.dead = false;
  sim.grbl.inbox = [];
  sim.ctx.port.isOpen = true;
  sim.ctx.status.comms.connectionStatus = 2;
  sim.ctx.status.machine.firmware.type = 'grbl';
  sim.rx(BANNER);
  sim.startStatusPolling();
  const before = sim.wire.length;
  sim.type('$G');
  sim.grbl.answer();
  assert.deepEqual(sim.wire.slice(before), ['$G\n']);
  sim.poll(1000);
  assert.equal(sim.ctx.status.comms.connectionStatus, 2);
});

// --------------------------------------------------------------- (b) never silent

test('console command (and a realtime byte) while disconnected: each is logged as refused, "port terputus"', () => {
  const sim = connectedAndPolling();
  sim.grbl.dead = true;
  sim.poll(3400); // lost
  sim.type('$I\n?');
  const refused = sim.log.filter((l) => /^Ditolak, tidak dikirim: port terputus/.test(l.response)).map((l) => l.command);
  assert.deepEqual(refused, ['$I', '?']);
});

test('$I typed during the connect handshake (firmware not identified yet) is refused with "belum siap: handshake" - it used to sit in the queue silently', () => {
  const sim = createSim({ controllerReady: false });
  sim.ctx.status.machine.firmware.type = '';
  sim.ctx.status.comms.connectionStatus = 1;
  sim.type('$I');
  assert.deepEqual(sim.state().gcodeQueue, []);
  assert.equal(sim.log.filter((l) => l.command === '$I' && /belum siap: handshake/.test(l.response)).length, 1, JSON.stringify(sim.log));
});

function pausedJob() {
  const sim = connectedAndPolling();
  sim.ctx.runJob({ isJob: true, data: 'G1 X1 F100\nG1 X2\nG1 X3\nG1 X4', fileName: 'p.nc' });
  sim.grbl.answer(1);
  sim.ctx.status.comms.connectionStatus = 3;
  sim.ctx.pause();
  return sim;
}

test('bench: a console command typed while a job is PAUSED (Hold) is refused with a clear log line - it used to vanish', () => {
  const sim = pausedJob();
  const before = sim.wire.length;
  sim.type('$I');
  assert.equal(sim.wire.length, before, 'nothing written');
  assert.ok(!sim.state().gcodeQueue.includes('$I'), 'and not silently parked behind the held job either');
  assert.deepEqual(sim.log.filter((l) => l.command === '$I').map((l) => l.response), ['Ditolak, tidak dikirim: job sedang pause — Resume atau Stop dulu']);
});

test('while PAUSED: realtime bytes still go out (? status, ~ resume, ! hold, 0x85)', () => {
  const sim = pausedJob();
  for (const b of ['?', '~', '!', String.fromCharCode(0x85)]) {
    sim.type(b);
    assert.equal(sim.wire[sim.wire.length - 1], b, 'byte 0x' + b.charCodeAt(0).toString(16));
  }
  assert.ok(!sim.log.some((l) => /Ditolak/.test(l.response)), JSON.stringify(sim.log));
});

test('while PAUSED: a jog is refused with a log line too (it used to queue silently behind the held job)', () => {
  const sim = pausedJob();
  sim.handlers.jog('X,10,1000');
  assert.ok(!sim.wire.some((w) => w.startsWith('$J=')));
  assert.ok(sim.log.some((l) => /^\$J=/.test(l.command) && /job sedang pause/.test(l.response)), JSON.stringify(sim.log));
});

test('after Resume, console commands are accepted again', () => {
  const sim = pausedJob();
  sim.ctx.unpause();
  sim.type('$G');
  assert.ok(sim.state().gcodeQueue.includes('$G'));
  assert.ok(!sim.log.some((l) => l.command === '$G' && /Ditolak/.test(l.response)));
});

// --------------------------------------------------------------- (3) "Controller:" label

test('after the port is lost the controller state reads "Disconnected", not the last report ("Hold:0")', () => {
  const sim = pausedJob();
  sim.rx('<Hold:0|MPos:0.000,0.000,0.000|FS:0,0>');
  assert.equal(sim.ctx.status.comms.runStatus, 'Hold:0', 'precondition');
  sim.grbl.dead = true;
  sim.poll(3400);
  assert.equal(sim.ctx.status.comms.runStatus, 'Disconnected');
});

test('a normal "Port closed" (stopPort) also clears it', () => {
  const sim = connectedAndPolling();
  sim.rx('<Hold:0|MPos:0.000,0.000,0.000|FS:0,0>');
  sim.ctx.port.isOpen = false;
  sim.ctx.status.comms.connectionStatus = 0;
  sim.ctx.stopPort();
  assert.equal(sim.ctx.status.comms.runStatus, 'Disconnected');
});

test('a console command typed during a running job says it waits behind the job', () => {
  const sim = connectedAndPolling();
  sim.ctx.runJob({ isJob: true, data: 'G1 X1 F100\nG1 X2\nG1 X3', fileName: 'q.nc' });
  sim.type('$G');
  assert.ok(sim.log.some((l) => l.command === '$G' && l.response === 'Ditunda: dikirim setelah 2 baris yang sudah antre'), JSON.stringify(sim.log));
});

test('a multi-line console paste when idle is not flooded with "Ditunda" lines', () => {
  const sim = connectedAndPolling();
  sim.type('G0 X1\nG0 X2\nG0 X3');
  assert.ok(!sim.log.some((l) => /Ditunda/.test(l.response)), JSON.stringify(sim.log));
});

test('a jog and a job start while disconnected are refused with a log line too', () => {
  const sim = connectedAndPolling();
  sim.grbl.dead = true;
  sim.poll(3400);
  sim.handlers.jog('X,10,1000');
  sim.ctx.runJob({ isJob: true, data: 'G1 X1 F100', fileName: 'z.nc' });
  assert.ok(sim.log.some((l) => /^Jog /.test(l.command) && /port terputus/.test(l.response)), JSON.stringify(sim.log));
  assert.ok(sim.log.some((l) => l.command === 'z.nc' && /port terputus/.test(l.response)));
});

// --------------------------------------------------------------- (c) internal lines

test('a rejected modal console line: its auto "$G" is NOT announced as a cancelled line', () => {
  const sim = connectedAndPolling();
  sim.grbl.on(/A10/, ['[MSG:A is Y2 ($309=1): A10.000]', 'error:33']);
  sim.type('G91 G1 A10 F1000');
  sim.grbl.answer();
  assert.ok(!sim.log.some((l) => /dibatalkan/.test(l.response)), JSON.stringify(sim.log));
  assert.equal(sim.unsent(), 0, 'the $G is still dropped, just not announced');
});

test('error mid-job with modal lines: only the operator\'s lines are counted (the auto "$G" after G91/G90 are not)', () => {
  const sim = connectedAndPolling();
  sim.grbl.on(/^G91 G1 X2$/, ['error:20']);
  sim.ctx.runJob({ isJob: true, data: 'G1 X1 F100\nG91 G1 X2\nG90 G1 X3', fileName: 'm.nc' });
  sim.grbl.answer(); // G1 X1 ok -> G91 G1 X2 error:20
  assert.deepEqual(sim.logged('1 baris'), ['[] 1 baris belum terkirim dibatalkan karena error (G90 G1 X3)']);
});

test('port lost with only the sender\'s own "$G" in flight: nothing announced as unanswered', () => {
  const sim = connectedAndPolling();
  sim.type('G90');
  sim.grbl.answer(1); // G90 ok -> the auto $G is written next
  assert.deepEqual(sim.state().sentBuffer, ['$G']);
  sim.grbl.dead = true;
  sim.poll(3400);
  assert.ok(!sim.log.some((l) => /tanpa jawaban/.test(l.response)), JSON.stringify(sim.log));
});
