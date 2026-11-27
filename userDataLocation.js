// Where Urban Creator CONTROL keeps its user data (Electron "userData").
//
// Up to 2.0.0 the installed app AND a dev run (`electron .`) both used
// %APPDATA%\UrbanCreatorCONTROL-dev - one data folder, and with it one
// single-instance lock, so an open dev app swallowed the installed one.
// From 2.0.1:
//   - dev run (not packaged):  UrbanCreatorCONTROL-dev   (unchanged)
//   - installed (packaged):    UrbanCreatorCONTROL
// On the first start of an installed build (no UrbanCreatorCONTROL folder
// yet) the user's data is COPIED from UrbanCreatorCONTROL-dev: localStorage
// (macros, settings backups, shortcuts, preferences), the job-recovery
// record, the remembered dialog folders and the last uploaded file. Not
// serial.log - the release starts a log of its own - and no browser caches.
// The -dev folder is never changed or deleted. The copy goes into a temporary
// folder that is renamed into place only when complete; if anything fails
// (e.g. a running dev app holds its localStorage open) this session uses the
// -dev folder as before - nothing is lost - and the next start tries again.
'use strict';
const path = require('path');

const DEV_DIR_NAME = 'UrbanCreatorCONTROL-dev';
const RELEASE_DIR_NAME = 'UrbanCreatorCONTROL';
const MIGRATED_ITEMS = ['Local Storage', 'job-recovery.json', 'dialog-dirs.json', 'upload'];

function exists(fs, p) {
  try {
    fs.statSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

// "present (state: interrupted)" / "absent" - what the log says about the
// job-recovery record in `dir`.
function describeJobRecovery(fs, dir) {
  const file = path.join(dir, 'job-recovery.json');
  if (!exists(fs, file)) return 'absent';
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    return 'present' + (rec && rec.state ? ' (state: ' + rec.state + ')' : '');
  } catch (e) {
    return 'present (unreadable)';
  }
}

// -> { dir, migration }  migration is null when there is nothing to report
// (dev run, or the release folder already exists), else
// { status: 'fresh' | 'copied' | 'fallback', from, to, items, jobRecovery, error }
function resolveUserData(opts) {
  const fs = opts.fs || require('fs');
  const devDir = path.join(opts.appData, DEV_DIR_NAME);
  const releaseDir = path.join(opts.appData, RELEASE_DIR_NAME);

  if (!opts.isPackaged) return { dir: devDir, migration: null };
  if (exists(fs, releaseDir)) return { dir: releaseDir, migration: null };
  if (!exists(fs, devDir)) {
    return { dir: releaseDir, migration: { status: 'fresh', from: null, to: releaseDir, items: [], jobRecovery: 'absent' } };
  }

  const tmp = releaseDir + '.migrating';
  const items = [];
  try {
    fs.rmSync(tmp, { recursive: true, force: true }); // a half copy from an earlier failed start
    fs.mkdirSync(tmp, { recursive: true });
    for (const item of MIGRATED_ITEMS) {
      const src = path.join(devDir, item);
      if (!exists(fs, src)) continue;
      fs.cpSync(src, path.join(tmp, item), { recursive: true });
      items.push(item);
    }
    fs.renameSync(tmp, releaseDir);
    return {
      dir: releaseDir,
      migration: { status: 'copied', from: devDir, to: releaseDir, items: items, jobRecovery: describeJobRecovery(fs, releaseDir) },
    };
  } catch (e) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e2) {}
    return {
      dir: devDir,
      migration: { status: 'fallback', from: devDir, to: releaseDir, items: [], jobRecovery: describeJobRecovery(fs, devDir), error: e.message },
    };
  }
}

// The serial.log line for a migration result (null -> nothing to log).
function migrationLogLine(m) {
  if (!m) return null;
  switch (m.status) {
    case 'fresh':
      return 'User data: new install - no earlier data found, starting in ' + m.to;
    case 'copied':
      return 'User data migration: SUCCESS - copied from ' + m.from + ' to ' + m.to +
        ' (' + (m.items.length ? m.items.join(', ') : 'nothing to copy') + '; serial.log not copied)' +
        '; job-recovery: ' + m.jobRecovery + '; ' + m.from + ' left unchanged';
    case 'fallback':
      return 'User data migration: FALLBACK - could not copy from ' + m.from + ' (' + m.error + ')' +
        '; this session uses ' + m.from + ' unchanged, will retry at next start' +
        '; job-recovery: ' + m.jobRecovery;
  }
  return null;
}

// Runs in the renderer (webContents.executeJavaScript): what the copied
// localStorage holds, for the log. -1 = present but unreadable.
const COUNT_SCRIPT = '(function () {' +
  'function n(k) { try { var v = JSON.parse(localStorage.getItem(k) || "[]"); return Array.isArray(v) ? v.length : -1; } catch (e) { return -1; } }' +
  'return { macros: n("macroButtons"), settingsBackups: n("grblParamsBackups") };' +
  '})()';

function countsLogLine(m, counts) {
  return 'User data migration (' + m.status + '): ' + counts.macros + ' macros, ' +
    counts.settingsBackups + ' Grbl settings backups in localStorage';
}

module.exports = {
  resolveUserData, migrationLogLine, countsLogLine, COUNT_SCRIPT,
  DEV_DIR_NAME, RELEASE_DIR_NAME, MIGRATED_ITEMS,
};
