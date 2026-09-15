// Automated regression tests for the jog distance/mode toggle and the 8-way
// (4 diagonal) jog logic added on top of P0-P6. Runs the REAL app/js/jog.js
// source through a minimal browser-globals sandbox (see test/helpers/
// sandbox.js) - no Electron, no hardware, no real DOM required.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppScript } = require('./helpers/sandbox');

function freshJog(extraGlobals) {
  return loadAppScript('app/js/jog.js', extraGlobals);
}

// --- jogDistanceButtonIdFor() -----------------------------------------------

test('jogDistanceButtonIdFor maps mm values to the right button id', () => {
  const { context } = freshJog();
  assert.equal(context.jogDistanceButtonIdFor(0.1), 'dist01');
  assert.equal(context.jogDistanceButtonIdFor(1), 'dist1');
  assert.equal(context.jogDistanceButtonIdFor(10), 'dist10');
  assert.equal(context.jogDistanceButtonIdFor(100), 'dist100');
});

test('jogDistanceButtonIdFor maps the equivalent inch values to the same ids', () => {
  const { context } = freshJog();
  assert.equal(context.jogDistanceButtonIdFor(0.0254), 'dist01');
  assert.equal(context.jogDistanceButtonIdFor(0.254), 'dist1');
  assert.equal(context.jogDistanceButtonIdFor(2.54), 'dist10');
  assert.equal(context.jogDistanceButtonIdFor(25.4), 'dist100');
});

// --- selectJogDistance() ----------------------------------------------------

test('selectJogDistance("CONT") switches to Continuous and highlights distCONT', () => {
  const { context, $, localStorage } = freshJog();
  context.selectJogDistance('CONT');
  assert.equal(context.allowContinuousJog, true);
  assert.equal(localStorage.getItem('continuousJog'), 'true');
  assert.ok($.callsFor('#distCONT').some((c) => c.method === 'addClass' && c.args[0] === 'jogmode-active'));
});

test('selectJogDistance("10") in mm mode sets jogdistXYZ=10 and leaves Continuous off', () => {
  const { context, localStorage } = freshJog({ unit: 'mm' });
  context.selectJogDistance('10');
  assert.equal(context.jogdistXYZ, 10);
  assert.equal(context.allowContinuousJog, false);
  assert.equal(localStorage.getItem('continuousJog'), 'false');
});

test('selectJogDistance("10") in inch mode converts to the equivalent inch step (2.54)', () => {
  const { context } = freshJog({ unit: 'in' });
  context.selectJogDistance('10');
  assert.equal(context.jogdistXYZ, 2.54);
});

test('selectJogDistance highlights only the newly selected button (previous highlight cleared)', () => {
  const { context, $ } = freshJog({ unit: 'mm' });
  context.selectJogDistance('0.1');
  context.selectJogDistance('100');
  // The class-clearing calls use the shared '.distbtn'/'.jogdistXYZ' selectors
  // (jQuery class selectors), so every selectJogDistance() call should have
  // cleared the group before re-adding to the specific new button.
  const clears = $.callsFor('.distbtn').filter((c) => c.method === 'removeClass');
  assert.ok(clears.length >= 2, 'expected the distbtn group to be cleared on every selection');
  assert.ok($.callsFor('#dist100').some((c) => c.method === 'addClass' && c.args[0] === 'jogmode-active'));
});

// --- setIncrementalMode() / setContinuousMode() -----------------------------
// These are what the probe wizard (app/wizards/probe/probev2.js) and the
// keyboard incJogMode/conJogMode shortcuts call - regression-critical since
// P7 replaced 8 hand-written call sites with calls to these two functions.

test('setContinuousMode() is equivalent to selectJogDistance("CONT")', () => {
  const { context, localStorage } = freshJog();
  context.setContinuousMode();
  assert.equal(context.allowContinuousJog, true);
  assert.equal(localStorage.getItem('continuousJog'), 'true');
});

test('setIncrementalMode() leaves Continuous without forgetting the last distance', () => {
  const { context } = freshJog({ unit: 'mm' });
  context.jogdistXYZ = 100; // simulate "user had 100mm selected earlier"
  context.allowContinuousJog = true;
  context.setIncrementalMode();
  assert.equal(context.allowContinuousJog, false);
  assert.equal(context.jogdistXYZ, 100, 'setIncrementalMode must not reset the remembered distance');
});

// --- changeStepSize() (keyboard step+/step- shortcuts) ----------------------

test('changeStepSize steps up through 0.1 -> 1 -> 10 -> 100 and stops at the top', () => {
  const { context } = freshJog({ unit: 'mm' });
  context.selectJogDistance('0.1');
  context.changeStepSize(1);
  assert.equal(context.jogdistXYZ, 1);
  context.changeStepSize(1);
  assert.equal(context.jogdistXYZ, 10);
  context.changeStepSize(1);
  assert.equal(context.jogdistXYZ, 100);
  context.changeStepSize(1); // already at max - must not go further/throw
  assert.equal(context.jogdistXYZ, 100);
});

test('changeStepSize steps down and stops at 0.1 (does not go below)', () => {
  const { context } = freshJog({ unit: 'mm' });
  context.selectJogDistance('10');
  context.changeStepSize(-1);
  assert.equal(context.jogdistXYZ, 1);
  context.changeStepSize(-1);
  assert.equal(context.jogdistXYZ, 0.1);
  context.changeStepSize(-1);
  assert.equal(context.jogdistXYZ, 0.1);
});

test('changeStepSize resumes from the remembered distance when starting from CONT', () => {
  const { context } = freshJog({ unit: 'mm' });
  context.selectJogDistance('10');
  context.selectJogDistance('CONT');
  assert.equal(context.allowContinuousJog, true);
  context.changeStepSize(1); // per keyboard.js, stepping always forces Incremental
  assert.equal(context.allowContinuousJog, false);
  assert.equal(context.jogdistXYZ, 100, 'should resume from 10 (the last real distance), not some default');
});

// --- calcContinuousJogDistance() (soft-limit clamping for diagonal jog) ----

test('calcContinuousJogDistance returns a large safe distance when soft limits are off', () => {
  const { context } = freshJog({ grblParams: { $20: '0' } });
  assert.equal(context.calcContinuousJogDistance('X', 1), 1000);
  assert.equal(context.calcContinuousJogDistance('X', -1), 1000);
});

test('calcContinuousJogDistance clamps to the remaining travel when soft limits are on', () => {
  const { context } = freshJog({
    grblParams: { $20: '1', $130: '800', $131: '600' },
    laststatus: {
      machine: {
        firmware: { platform: '', type: 'grbl' },
        position: {
          offset: { x: 0, y: 0, z: 0 },
          work: { x: 0, y: 0, z: 0 },
        },
      },
      comms: { runStatus: 'Idle' },
    },
  });
  // At machine position 0, moving further "+" is already at the practical
  // limit (GRBL machine coords run 0..-maxTravel) - expect a sub-1 result.
  assert.ok(context.calcContinuousJogDistance('X', 1) < 1);
  // Moving "-" from 0 has the full travel available minus the 1mm margin.
  assert.equal(context.calcContinuousJogDistance('X', -1), 799);
  assert.equal(context.calcContinuousJogDistance('Y', -1), 599);
});

// --- bindDiagonalJog() (the 4 new diagonal buttons) -------------------------

function triggerMousedown($, selector) {
  $(selector).trigger('mousedown', { which: 1, preventDefault: () => {} });
}

test('diagonal jog (Incremental mode) sends a correctly-signed jogXY for each of the 4 corners', () => {
  const { context, $, socket } = freshJog({ unit: 'mm', grblParams: { $20: '0' } });
  context.jogdistXYZ = 10;
  context.allowContinuousJog = false;

  const cases = [
    { selector: '.xPyP', xSign: 1, ySign: 1 },
    { selector: '.xMyP', xSign: -1, ySign: 1 },
    { selector: '.xPyM', xSign: 1, ySign: -1 },
    { selector: '.xMyM', xSign: -1, ySign: -1 },
  ];

  for (const { selector, xSign, ySign } of cases) {
    socket.emitted.length = 0;
    context.bindDiagonalJog(selector, xSign, ySign);
    triggerMousedown($, selector);
    const jogXYCalls = socket.emitted.filter((e) => e.event === 'jogXY');
    assert.equal(jogXYCalls.length, 1, `expected exactly one jogXY emit for ${selector}`);
    assert.equal(jogXYCalls[0].data.x, xSign * 10, `${selector} X sign/magnitude`);
    assert.equal(jogXYCalls[0].data.y, ySign * 10, `${selector} Y sign/magnitude`);
  }
});

test('diagonal jog (Continuous mode) clamps distance via calcContinuousJogDistance and marks jog as running', () => {
  const { context, $, socket } = freshJog({
    unit: 'mm',
    grblParams: { $20: '0' }, // soft limits off -> large fixed distance, easy to assert
    waitingForStatus: false,
  });
  context.allowContinuousJog = true;
  context.bindDiagonalJog('.xPyP', 1, 1);
  triggerMousedown($, '.xPyP');

  const jogXYCalls = socket.emitted.filter((e) => e.event === 'jogXY');
  assert.equal(jogXYCalls.length, 1);
  assert.equal(Number(jogXYCalls[0].data.x), 1000);
  assert.equal(Number(jogXYCalls[0].data.y), 1000);
  assert.equal(context.continuousJogRunning, true);
});

test('diagonal jog mouseup cancels the jog when in Continuous mode (calls cancelJog -> stop/jog:true)', () => {
  const { context, $, socket } = freshJog({ grblParams: { $20: '0' } });
  context.allowContinuousJog = true;
  context.bindDiagonalJog('.xMyM', -1, -1);
  $('.xMyM').trigger('mouseup', { preventDefault: () => {} });

  const stopCalls = socket.emitted.filter((e) => e.event === 'stop');
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0].data.jog, true, 'Stop Jog must use the jog-cancel (0x85) path, not a full abort');
  assert.equal(stopCalls[0].data.abort, false);
});

// --- cancelJog() (the new Stop Jog button calls this directly) -------------

test('cancelJog sends the jog-cancel stop signal, not a full abort', () => {
  const { context, socket } = freshJog();
  context.continuousJogRunning = true;
  context.cancelJog();
  assert.equal(socket.emitted.length, 1);
  // Field-by-field, not assert.deepEqual: socket.emitted[0].data was built
  // *inside* the vm sandbox, so it belongs to a different realm than this
  // test file's own object literals - deepStrictEqual's prototype check
  // fails even when every field matches. Comparing primitives sidesteps it.
  const { event, data } = socket.emitted[0];
  assert.equal(event, 'stop');
  assert.equal(data.stop, false);
  assert.equal(data.jog, true, 'Stop Jog must use the jog-cancel (0x85) path, not a full abort');
  assert.equal(data.abort, false);
  assert.equal(context.continuousJogRunning, false);
});
