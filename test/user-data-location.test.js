// The user-data folder (2.0.1): installed build -> %APPDATA%\UrbanCreatorCONTROL,
// dev run -> UrbanCreatorCONTROL-dev; first installed start copies the user's
// data from -dev (not serial.log), never touching -dev. See userDataLocation.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const U = require('../userDataLocation');
const { SRC } = require('./helpers/index-src');

function appData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'uc-appdata-'));
}

// what 2.0.0 left behind in UrbanCreatorCONTROL-dev
function seed2_0_0(root) {
  const dev = path.join(root, 'UrbanCreatorCONTROL-dev');
  fs.mkdirSync(path.join(dev, 'Local Storage', 'leveldb'), { recursive: true });
  fs.writeFileSync(path.join(dev, 'Local Storage', 'leveldb', '000003.log'), 'macroButtons...');
  fs.writeFileSync(path.join(dev, 'Local Storage', 'leveldb', 'CURRENT'), 'MANIFEST-000001\n');
  fs.writeFileSync(path.join(dev, 'job-recovery.json'), JSON.stringify({ state: 'interrupted', fileName: 'a.nc' }));
  fs.writeFileSync(path.join(dev, 'dialog-dirs.json'), '{"open":"D:\\\\jobs"}');
  fs.mkdirSync(path.join(dev, 'upload'));
  fs.writeFileSync(path.join(dev, 'upload', 'last.gcode'), 'G0 X0');
  fs.writeFileSync(path.join(dev, 'serial.log'), 'old log\n');
  fs.mkdirSync(path.join(dev, 'Cache'));
  fs.writeFileSync(path.join(dev, 'Cache', 'data_0'), 'cache');
  return dev;
}

function snapshot(dir) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  })(dir);
  return out;
}

test('dev run (not packaged): UrbanCreatorCONTROL-dev, nothing copied, nothing to log', () => {
  const root = appData();
  seed2_0_0(root);
  const r = U.resolveUserData({ appData: root, isPackaged: false });
  assert.equal(r.dir, path.join(root, 'UrbanCreatorCONTROL-dev'));
  assert.equal(r.migration, null);
  assert.ok(!fs.existsSync(path.join(root, 'UrbanCreatorCONTROL')));
});

test('installed, first start after 2.0.0: data copied to UrbanCreatorCONTROL; serial.log and caches not; -dev untouched', () => {
  const root = appData();
  const dev = seed2_0_0(root);
  const before = snapshot(dev);
  const r = U.resolveUserData({ appData: root, isPackaged: true });
  const rel = path.join(root, 'UrbanCreatorCONTROL');
  assert.equal(r.dir, rel);
  assert.equal(r.migration.status, 'copied');
  assert.deepEqual([...r.migration.items], ['Local Storage', 'job-recovery.json', 'dialog-dirs.json', 'upload']);
  assert.equal(fs.readFileSync(path.join(rel, 'Local Storage', 'leveldb', '000003.log'), 'utf8'), 'macroButtons...');
  assert.equal(fs.readFileSync(path.join(rel, 'upload', 'last.gcode'), 'utf8'), 'G0 X0');
  assert.ok(fs.existsSync(path.join(rel, 'job-recovery.json')));
  assert.ok(fs.existsSync(path.join(rel, 'dialog-dirs.json')));
  assert.ok(!fs.existsSync(path.join(rel, 'serial.log')), 'the release starts its own log');
  assert.ok(!fs.existsSync(path.join(rel, 'Cache')), 'no browser caches');
  assert.ok(!fs.existsSync(rel + '.migrating'), 'no temp folder left');
  assert.deepEqual(snapshot(dev), before, '-dev not changed');
  assert.equal(r.migration.jobRecovery, 'present (state: interrupted)');
});

test('installed, later starts: the release folder is used as is - no second copy over newer data', () => {
  const root = appData();
  seed2_0_0(root);
  U.resolveUserData({ appData: root, isPackaged: true });
  const rel = path.join(root, 'UrbanCreatorCONTROL');
  fs.writeFileSync(path.join(rel, 'job-recovery.json'), '{"state":"done"}'); // changed in the release
  const r = U.resolveUserData({ appData: root, isPackaged: true });
  assert.equal(r.dir, rel);
  assert.equal(r.migration, null);
  assert.equal(fs.readFileSync(path.join(rel, 'job-recovery.json'), 'utf8'), '{"state":"done"}');
});

test('installed on a PC that never had 2.0.0: fresh UrbanCreatorCONTROL, reported as a new install', () => {
  const root = appData();
  const r = U.resolveUserData({ appData: root, isPackaged: true });
  assert.equal(r.dir, path.join(root, 'UrbanCreatorCONTROL'));
  assert.equal(r.migration.status, 'fresh');
  assert.match(U.migrationLogLine(r.migration), /new install/);
});

test('copy fails (a running dev app locks its localStorage): this session uses -dev, no half copy left, next start retries', () => {
  const root = appData();
  const dev = seed2_0_0(root);
  const failing = Object.assign({}, fs, {
    cpSync(src, dst, o) {
      if (src.includes('Local Storage')) throw new Error('EBUSY: resource busy or locked');
      return fs.cpSync(src, dst, o);
    },
  });
  const r = U.resolveUserData({ appData: root, isPackaged: true, fs: failing });
  assert.equal(r.dir, dev, 'nothing lost: the old folder, as 2.0.0 used it');
  assert.equal(r.migration.status, 'fallback');
  assert.match(r.migration.error, /EBUSY/);
  assert.ok(!fs.existsSync(path.join(root, 'UrbanCreatorCONTROL')), 'no release folder - else the next start would not retry');
  assert.ok(!fs.existsSync(path.join(root, 'UrbanCreatorCONTROL.migrating')));
  const line = U.migrationLogLine(r.migration);
  assert.match(line, /FALLBACK/);
  assert.match(line, /will retry at next start/);
  assert.match(line, /job-recovery: present \(state: interrupted\)/);

  const again = U.resolveUserData({ appData: root, isPackaged: true });
  assert.equal(again.migration.status, 'copied');
});

test('a half copy left by an earlier crash is replaced, not merged', () => {
  const root = appData();
  seed2_0_0(root);
  const tmp = path.join(root, 'UrbanCreatorCONTROL.migrating');
  fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(tmp, 'stale.txt'), 'x');
  const r = U.resolveUserData({ appData: root, isPackaged: true });
  assert.equal(r.migration.status, 'copied');
  assert.ok(!fs.existsSync(path.join(root, 'UrbanCreatorCONTROL', 'stale.txt')));
});

test('log lines: success names source, target, what was copied, that serial.log was not, job-recovery and that -dev is unchanged', () => {
  const root = appData();
  seed2_0_0(root);
  const r = U.resolveUserData({ appData: root, isPackaged: true });
  const line = U.migrationLogLine(r.migration);
  assert.match(line, /^User data migration: SUCCESS - copied from .*UrbanCreatorCONTROL-dev to .*UrbanCreatorCONTROL \(Local Storage, job-recovery\.json, dialog-dirs\.json, upload; serial\.log not copied\); job-recovery: present \(state: interrupted\); .*left unchanged$/);
  assert.equal(U.countsLogLine(r.migration, { macros: 7, settingsBackups: 2 }),
    'User data migration (copied): 7 macros, 2 Grbl settings backups in localStorage');
});

test('the renderer count script reads macroButtons / grblParamsBackups (arrays), -1 if unreadable', () => {
  const store = { macroButtons: JSON.stringify([{}, {}, {}]), grblParamsBackups: JSON.stringify([{}]) };
  const ls = { getItem: (k) => (k in store ? store[k] : null) };
  assert.deepEqual({ ...vm.runInNewContext(U.COUNT_SCRIPT, { localStorage: ls }) }, { macros: 3, settingsBackups: 1 });
  store.macroButtons = '{bad';
  delete store.grblParamsBackups;
  assert.deepEqual({ ...vm.runInNewContext(U.COUNT_SCRIPT, { localStorage: ls }) }, { macros: -1, settingsBackups: 0 });
});

test('index.js: userData comes from resolveUserData(isPackaged) before anything else uses it; result logged; counts after load', () => {
  assert.doesNotMatch(SRC, /setPath\('userData', path\.join\(electronApp\.getPath\('appData'\), 'UrbanCreatorCONTROL-dev'\)\)/);
  const set = SRC.indexOf("electronApp.setPath('userData', userDataLocation.dir)");
  assert.ok(set > 0);
  assert.match(SRC, /const userDataLocation = userDataLocationModule\.resolveUserData\(\{\s*appData: electronApp\.getPath\('appData'\),\s*isPackaged: electronApp\.isPackaged\s*\}\)/);
  for (const use of ["getPath('userData')", 'requestSingleInstanceLock', 'function serialLog']) {
    assert.ok(SRC.indexOf(use) > set, use + ' comes after the userData decision');
  }
  assert.match(SRC, /migrationLogLine\(userDataLocation\.migration\)/);
  assert.match(SRC, /webContents\.executeJavaScript\(userDataLocationModule\.COUNT_SCRIPT\)/);
});
