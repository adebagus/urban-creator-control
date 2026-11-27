// A2 (2.0.1): no tray / background mode. No tray icon, the window always
// opens, and closing it quits the app (that part since P8 - quitAndCleanup,
// with the "job is running" confirmation since P9).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { read, SRC, grab } = require('./helpers/index-src');

test('A2: no tray icon (Windows/Linux) - no Tray at all; the macOS dock menu stays', () => {
  assert.doesNotMatch(SRC, /new Tray\(/);
  assert.doesNotMatch(SRC, /electron\.Tray/);
  assert.doesNotMatch(SRC, /displayBalloon/);
  assert.match(SRC, /electronApp\.dock\.setMenu\(/);
});

test('A2: the window always opens on start (no hidden start)', () => {
  const ready = SRC.match(/electronApp\.on\('ready', \(\) => \{([\s\S]*?)\n    \}\)/);
  assert.ok(ready, 'the ready handler');
  assert.match(ready[1], /showJogWindow\(\)/);
  assert.doesNotMatch(ready[1], /if \(/, 'unconditionally');
  assert.doesNotMatch(SRC, /wasOpenedAtLogin/, 'no "started at login -> stay hidden" path left');
});

test('A2: closing the window quits (with the job-running confirmation): close -> quitAndCleanup, cancel keeps it open', () => {
  assert.match(SRC, /jogWindow\.on\('close', function\(event\) \{\s*if \(!quitAndCleanup\(0\)\) \{\s*event\.preventDefault\(\);/);
  assert.match(SRC, /electronApp\.on\('window-all-closed', function\(\) \{[\s\S]*?quitAndCleanup\(0\);/);
  assert.match(grab('quitAndCleanup'), /isMachineBusy\(\)/);
});

test('A2: the titlebar close button says it closes the app, not "to Tray"', () => {
  const html = read('app/index.html');
  assert.doesNotMatch(html, /Close to Tray/);
  assert.match(html, /<span title="Tutup aplikasi" class="btn-custom" onclick="socket\.emit\('minimisetotray'\)">/);
  assert.doesNotMatch(SRC, /Check the System Tray/);
});
