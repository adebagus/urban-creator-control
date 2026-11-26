// The [VER:] line of $I: firmware version, date and machine name.
//
// Mythos reports "[VER:1.1f.20261126.53AS.4A-AS:Grbl Mythos ]" (bench_a0_log.txt):
// a variant suffix after the date and a name with a trailing space. The old
// parser read the name with split(':')[2], which throws a TypeError inside
// the serial data handler for a [VER:] line without a second ':'.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createSim, SRC } = require('./helpers/serial-sim');

function parse(line) {
  const ctx = {};
  vm.createContext(ctx);
  const s = SRC.indexOf('function parseVersionLine(');
  assert.notEqual(s, -1, 'parseVersionLine() missing');
  vm.runInContext(SRC.slice(s, SRC.indexOf('\n}\n', s) + 2), ctx);
  return { ...ctx.parseVersionLine(line) };
}

test('Mythos 4A-AS: version 1.1f, date 20261126 - the variant suffix does not leak into either', () => {
  assert.deepEqual(parse('[VER:1.1f.20261126.53AS.4A-AS:Grbl Mythos ]'), { version: '1.1f', date: '20261126', name: 'grbl mythos' });
});

test('Mythos 3A / 4A / ISRDIAG tags parse the same way', () => {
  for (const tag of ['53.3A', '53.4A', '53AS.4A', '53AS.4A.ISRDIAG']) {
    assert.deepEqual(parse('[VER:1.1f.20261123.' + tag + ':Grbl Mythos ]'), { version: '1.1f', date: '20261123', name: 'grbl mythos' }, tag);
  }
});

test('plain grbl / grblHAL forms are unchanged', () => {
  assert.deepEqual(parse('[VER:1.1h.20190825:]'), { version: '1.1h', date: '20190825', name: '' });
  assert.deepEqual(parse('[VER:1.1f.20170801:Laser]'), { version: '1.1f', date: '20170801', name: 'laser' });
});

test('no name part at all (no second ":") no longer throws', () => {
  assert.deepEqual(parse('[VER:1.1f.20170801]'), { version: '1.1f', date: '20170801', name: '' });
});

test('a name that itself contains ":" is kept whole', () => {
  assert.equal(parse('[VER:1.1f.20170801:Shop:Router 2]').name, 'shop:router 2');
});

test('through the real serial handler: the Mythos $I reply fills version/date/name and emits machinename', () => {
  const sim = createSim();
  sim.rx('[VER:1.1f.20261126.53AS.4A-AS:Grbl Mythos ]');
  assert.equal(sim.ctx.status.machine.firmware.version, '1.1f');
  assert.equal(sim.ctx.status.machine.firmware.date, '20261126');
  assert.equal(sim.ctx.status.machine.name, 'grbl mythos');
  assert.deepEqual(sim.eventsOf('machinename'), ['grbl mythos']);
});

test('through the real serial handler: a [VER:] line without a name does not throw', () => {
  const sim = createSim();
  assert.doesNotThrow(() => sim.rx('[VER:1.1f.20170801]'));
  assert.equal(sim.ctx.status.machine.firmware.version, '1.1f');
});
