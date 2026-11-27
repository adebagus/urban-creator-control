// A3 (2.0.1): single instance - a second launch brings the existing window
// to the front, also when it is minimized.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read, SRC, grab } = require('./helpers/index-src');

function windowFake(state) {
  const calls = [];
  const w = {
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    restore() { calls.push('restore'); state.minimized = false; },
    show() { calls.push('show'); state.visible = true; },
    focus() { calls.push('focus'); },
    setAlwaysOnTop(v) { calls.push('top:' + v); },
  };
  return { w, calls };
}

function loadShow(win) {
  const ctx = { jogWindow: win, createJogWindow() { throw new Error('not expected'); } };
  vm.createContext(ctx);
  vm.runInContext(grab('showJogWindow'), ctx);
  return ctx;
}

test('A3: second launch with the window minimized -> restored, shown and focused', () => {
  const { w, calls } = windowFake({ minimized: true, visible: true });
  loadShow(w).showJogWindow();
  assert.ok(calls.includes('restore'), JSON.stringify(calls));
  assert.ok(calls.indexOf('restore') < calls.indexOf('focus'));
  assert.ok(calls.includes('show') && calls.includes('focus'));
});

test('A3: second launch with the window behind others -> brought to the front (no restore needed)', () => {
  const { w, calls } = windowFake({ minimized: false, visible: true });
  loadShow(w).showJogWindow();
  assert.ok(!calls.includes('restore'));
  assert.deepEqual(calls.filter((c) => c !== 'show'), ['top:true', 'focus', 'top:false']);
});

test('A3: the single-instance lock is taken, the second process exits, the first focuses its window', () => {
  assert.match(SRC, /const gotTheLock = electronApp\.requestSingleInstanceLock\(\)/);
  assert.match(SRC, /if \(!gotTheLock\) \{[\s\S]*?electronApp\.exit\(0\);/);
  const handler = SRC.match(/electronApp\.on\('second-instance', [\s\S]*?\n    \}\)/);
  assert.ok(handler);
  assert.match(handler[0], /showJogWindow\(\)/);
});
