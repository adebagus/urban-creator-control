// A disconnect (USB pulled, Disconnect button, port error) must leave no
// sender state behind - including "paused" and "blocked".
//
// stopPort() emptied the queue but kept status.comms.paused/blocked. A job
// paused (Feed Hold), then USB pulled, left paused=true: after the reconnect
// every console command sat in gcodeQueue forever, with nothing in the log.
// A native-USB board (BluePill/Mythos) does not reset when the port opens, so
// there may be no banner on reconnect to clear it - the [VER:] of $I is what
// says it is up.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSim } = require('./helpers/serial-sim');

function pullUsbThenReconnectWithoutBanner(sim) {
  sim.ctx.port.isOpen = false;
  sim.ctx.status.comms.connectionStatus = 0;
  sim.ctx.stopPort();
  // reconnect: the port opens, the board does NOT reset, the handshake's $I answers
  sim.ctx.port.isOpen = true;
  sim.ctx.status.comms.connectionStatus = 2;
  sim.ctx.status.machine.firmware.type = 'grbl';
  sim.grbl.inbox = [];
  sim.rx('[VER:1.1f.20261126.53AS.4A-AS:Grbl Mythos ]');
  sim.rx('[OPT:VML,35,253]');
}

test('job paused, USB pulled, reconnect (no banner): the next console command is written to the port', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: 'G1 X1 F100\nG1 X2\nG1 X3', fileName: 'c.nc' });
  sim.ctx.status.comms.connectionStatus = 3;
  sim.ctx.pause();
  assert.equal(sim.ctx.status.comms.paused, true, 'precondition: paused');
  pullUsbThenReconnectWithoutBanner(sim);
  const before = sim.wire.length;
  sim.type('$G');
  assert.deepEqual(sim.wire.slice(before), ['$G\n']);
});

test('USB pulled while the queue was blocked (RX buffer full): after the reconnect it is not blocked any more', () => {
  const sim = createSim();
  sim.ctx.status.comms.blocked = true;
  pullUsbThenReconnectWithoutBanner(sim);
  assert.equal(sim.ctx.status.comms.blocked, false);
  sim.type('$G');
  assert.equal(sim.wire[sim.wire.length - 1], '$G\n');
});

test('USB pulled mid-job: nothing of the job survives the disconnect, Job Queue 0, one jobStopped ("interrupted")', () => {
  const sim = createSim();
  sim.ctx.runJob({ isJob: true, data: 'G1 X1 F100\nG1 X2\nG1 X3', fileName: 'c.nc' });
  sim.grbl.answer(1);
  pullUsbThenReconnectWithoutBanner(sim);
  const s = sim.state();
  assert.deepEqual(s.gcodeQueue, []);
  assert.deepEqual(s.sentBuffer, []);
  assert.equal(s.paused, false);
  assert.equal(sim.eventsOf('queueCount').pop()[0], 0);
  const stopped = sim.eventsOf('jobStopped');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].reason, 'interrupted');
  assert.equal(sim.ctx.jobRecovery.peek().state, 'interrupted');
});

test('between the disconnect and the reconnect handshake, an operator command is refused with a message, not silently queued', () => {
  const sim = createSim();
  sim.ctx.port.isOpen = false;
  sim.ctx.stopPort();
  sim.ctx.port.isOpen = true;
  sim.ctx.status.comms.connectionStatus = 2; // port open again, handshake not answered yet
  sim.ctx.status.machine.firmware.type = 'grbl';
  sim.type('$$');
  assert.deepEqual(sim.state().gcodeQueue, []);
  assert.equal(sim.log.filter((l) => l.command === '$$' && /belum siap/.test(l.response)).length, 1);
});
