// Status report parsing (parseFeedback) on what the Mythos board sends.
//
// Verified on the real function: Pn:A (Y2 switch with $309=1, AUTOSQUARE.md
// case 16), Pn:YA, a 4-value WCO, Ov, and fields the parser does not know
// (ISR:, Q:, A:) never throw. Two small defects fixed here: a bare "<Idle>"
// (no fields) read as state "<" - which now also feeds the ALARM gate - and
// every report with "|F:" (no variable spindle) printed itself with
// console.log, five times a second.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSim } = require('./helpers/serial-sim');

test('a bare "<Idle>" / "<Alarm>" report reads the right state', () => {
  const sim = createSim();
  sim.rx('<Idle>');
  assert.equal(sim.ctx.status.comms.runStatus, 'Idle');
  sim.rx('<Alarm>');
  assert.equal(sim.ctx.status.comms.runStatus, 'Alarm');
  assert.equal(sim.ctx.alarmActive, true);
});

test('a "|F:" report is not printed to the console', () => {
  const sim = createSim();
  const printed = [];
  sim.ctx.console.log = (...a) => printed.push(a);
  for (let i = 0; i < 5; i++) sim.rx('<Idle|MPos:0.000,0.000,0.000|F:0|Pn:P>');
  assert.deepEqual(printed, []);
  assert.equal(sim.ctx.status.machine.overrides.realFeed, 0);
});

test('Mythos reports: Pn:A / Pn:YA, 4-value WCO, Ov and unknown fields parse without throwing (regression guard)', () => {
  const sim = createSim();
  const reports = [
    '<Idle|MPos:0.000,-45.938,0.000,10.012|FS:0,0|Pn:A>',
    '<Alarm|MPos:10.000,20.000,-1.000,20.000|FS:0,0|Pn:YA|WCO:0.000,0.000,0.000,0.000>',
    '<Run|MPos:1,2,3,4|Bf:15,253|FS:500,0|Pn:XYZA|Ov:120,100,90|A:SF|ISR:7|Q:abc>',
  ];
  for (const r of reports) assert.doesNotThrow(() => sim.rx(r), r);
  assert.deepEqual([...sim.ctx.status.machine.inputs], ['X', 'Y', 'Z', 'A']);
  assert.equal(sim.ctx.status.machine.overrides.feedOverride, 120);
  assert.equal(sim.ctx.status.comms.runStatus, 'Run');
});
