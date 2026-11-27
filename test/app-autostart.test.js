// A1 (2.0.1): no auto-start at Windows login. Up to 2.0.0 every run called
// setLoginItemSettings with openAtLogin on, which wrote
// HKCU\...\CurrentVersion\Run "id.urbancreator.control.dev" (the AUMID) - and
// every run (dev or installed) overwrote its path. Now the app removes that
// entry at start, and the installer removes it on install/update and on
// uninstall (build/installer.nsh), so an update cleans it even before the new
// version is first run. The real OpenBuilds CONTROL's own entry
// ("openbuilds.control") is another product's and is left alone.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read, SRC, grab } = require('./helpers/index-src');

const AUMID = 'id.urbancreator.control.dev';
const RUN = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

test('A1: nothing in index.js turns auto-start ON any more', () => {
  assert.doesNotMatch(SRC, /openAtLogin\s*:\s*true/);
});

test('A1: at start the app removes the login item that older versions registered (by its AUMID name)', () => {
  const src = grab('removeLegacyLoginItem');
  assert.ok(src, 'removeLegacyLoginItem() exists');
  const calls = [];
  const ctx = {
    electronApp: { setLoginItemSettings: (s) => calls.push(s) },
    APP_USER_MODEL_ID: AUMID, serialLog() {},
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.removeLegacyLoginItem();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].openAtLogin, false);
  assert.equal(calls[0].name, AUMID, 'Electron deletes the Run (and StartupApproved) value of this name');
});

test('A1: a failure to clear it never stops the app from starting', () => {
  const ctx = {
    electronApp: { setLoginItemSettings() { throw new Error('registry locked'); } },
    APP_USER_MODEL_ID: AUMID, serialLog() {},
  };
  vm.createContext(ctx);
  vm.runInContext(grab('removeLegacyLoginItem'), ctx);
  assert.doesNotThrow(() => ctx.removeLegacyLoginItem());
});

test('A1: removeLegacyLoginItem() is called on Windows at start, and the AUMID is one constant', () => {
  assert.match(SRC, /if \(process\.platform == 'win32'\) \{\s*removeLegacyLoginItem\(\);\s*\}/);
  assert.match(SRC, /const APP_USER_MODEL_ID = "id\.urbancreator\.control\.dev"/);
  assert.match(SRC, /electronApp\.setAppUserModelId\(APP_USER_MODEL_ID\)/);
});

test('A1: the installer deletes the Run + StartupApproved values on install/update AND on uninstall', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.build.nsis.include, 'build/installer.nsh');
  const nsh = read('build/installer.nsh');
  for (const macro of ['customInstall', 'customUnInstall']) {
    const m = nsh.match(new RegExp('!macro ' + macro + '\\n([\\s\\S]*?)!macroend'));
    assert.ok(m, macro);
    for (const key of [RUN, APPROVED]) {
      const line = 'DeleteRegValue HKCU "' + key + '" "' + AUMID + '"';
      assert.ok(m[1].includes(line), macro + ': ' + line);
    }
  }
  assert.doesNotMatch(nsh, /DeleteRegValue[^\n]*openbuilds\.control/,'the real OpenBuilds CONTROL\'s entry is not ours to delete');
});
