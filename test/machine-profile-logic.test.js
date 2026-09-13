// Automated regression tests for the P6 Router/Laser profile logic. Runs
// the REAL app/js/grbl-settings-defaults.js through the sandbox (see
// test/helpers/sandbox.js) - no browser, no hardware.
//
// These tests exist specifically to catch the exact class of mistake this
// project already had a user-facing incident over: silently writing more
// settings than documented, or assuming a default value for $44/$45 that
// this codebase never actually established (see the P6/P7 conversation -
// the user explicitly chose "$44=0, leave $45 untouched" over the safer
// "$44=3, $45=0" alternative, precisely BECAUSE no default could be
// confirmed). If a future change makes Laser touch $45, or makes Router
// touch anything at all, these tests should fail.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppScript } = require('./helpers/sandbox');

function freshProfile(extraGlobals) {
  return loadAppScript('app/js/grbl-settings-defaults.js', {
    checkifchanged: () => {},
    ...extraGlobals,
  });
}

test('Router profile touches zero settings ($21/$22/$32/$44/$45 all untouched)', () => {
  const { context, $, socket } = freshProfile();
  context.selectMachine('router');

  for (const key of ['#val-21-input', '#val-22-input', '#val-32-input', '#val-44-input', '#val-45-input', '#val-46-input']) {
    assert.equal($.wasTouched(key), false, `Router must not touch ${key}`);
  }
  // The only side effects Router is allowed: the $I= marker (so reconnect
  // remembers the profile) and the radio-button highlight.
  const sentGcode = socket.emitted.filter((e) => e.event === 'runCommand').map((e) => e.data);
  assert.deepStrictEqual(sentGcode, ['$I=router']);
});

test('Laser profile sets $32=1 and $44=0, and never touches $45 (per explicit P6 decision)', () => {
  const { context, $ } = freshProfile();
  context.selectMachine('laser');

  assert.equal($.values['#val-32-input'], 1, 'Laser must turn Laser mode ON ($32=1)');
  assert.equal($.values['#val-44-input'], 0, 'Laser must disable homing cycle 1 ($44=0)');
  assert.equal($.wasTouched('#val-45-input'), false, '$45 must be left exactly as the firmware reports it - this was an explicit, deliberate decision, not an oversight');
  assert.equal($.wasTouched('#val-46-input'), false, '$46 has no established default anywhere in this codebase - must not be touched');
});

test('Laser profile does not touch anything outside $32/$44 (no spindle/PWM/toolhead settings)', () => {
  const { context, $ } = freshProfile();
  context.selectMachine('laser');

  // This is the exact bug class the old OpenBuilds toolhead system had
  // (enableLaser() used to also rewrite $30/$33/$34/$35/$36) - the P6/P7
  // profile system was deliberately built to NOT do that.
  for (const key of ['#val-21-input', '#val-22-input', '#val-30-input', '#val-33-input', '#val-34-input', '#val-35-input', '#val-36-input']) {
    assert.equal($.wasTouched(key), false, `Laser must not touch ${key} - Hard Limits/Homing are independent toggles, not part of this profile`);
  }
});

test('selectMachine sends the $I= marker matching the selected profile, for both profiles', () => {
  const { context: ctxRouter, socket: sockRouter } = freshProfile();
  ctxRouter.selectMachine('router');
  assert.ok(sockRouter.emitted.some((e) => e.event === 'runCommand' && e.data === '$I=router'));

  const { context: ctxLaser, socket: sockLaser } = freshProfile();
  ctxLaser.selectMachine('laser');
  assert.ok(sockLaser.emitted.some((e) => e.event === 'runCommand' && e.data === '$I=laser'));
});

test('setMachineButton checks the Laser radio for "laser" and the Router radio otherwise', () => {
  const { context, $ } = freshProfile();

  context.setMachineButton('laser');
  assert.ok($.callsFor('#simpleprofile_laser').some((c) => c.method === 'prop' && c.args[0] === 'checked' && c.args[1] === true));
  assert.ok($.callsFor('#simpleprofile_router').some((c) => c.method === 'prop' && c.args[0] === 'checked' && c.args[1] === false));

  context.setMachineButton('router');
  assert.ok($.callsFor('#simpleprofile_router').some((c) => c.method === 'prop' && c.args[0] === 'checked' && c.args[1] === true));
});

test('setMachineButton degrades gracefully for an unknown/legacy type (defaults to Router, does not throw)', () => {
  const { context, $ } = freshProfile();
  // Simulates a $I= value left over from before P6 (e.g. an old backup file
  // that still says "leadmachine1010") - must not crash, must default sane.
  assert.doesNotThrow(() => context.setMachineButton('leadmachine1010'));
  assert.ok($.callsFor('#simpleprofile_router').some((c) => c.method === 'prop' && c.args[0] === 'checked' && c.args[1] === true));
  assert.ok($.callsFor('#simpleprofile_laser').some((c) => c.method === 'prop' && c.args[0] === 'checked' && c.args[1] === false));
});

// --- fixGrblHALSettings() is intentionally still used by backup/restore ----
// (see app/js/grbl-settings.js loadGrblBackupFile/restoreAutoBackup) even
// though selectMachine() no longer calls it. This just confirms it still
// exists with its original signature/behaviour, since "preserve backup/
// restore exactly as-is" was an explicit P6 requirement.

test('fixGrblHALSettings still exists and only acts when platform is grblHAL', () => {
  const { context, $ } = freshProfile({
    laststatus: { machine: { firmware: { platform: 'grblHAL' } } },
  });
  assert.equal(typeof context.fixGrblHALSettings, 'function');
  context.fixGrblHALSettings('10');
  assert.equal($.values['#val-10-input'], 511);
});

test('fixGrblHALSettings does nothing when platform is plain grbl', () => {
  const { context, $ } = freshProfile({
    laststatus: { machine: { firmware: { platform: '' } } },
  });
  context.fixGrblHALSettings('10');
  assert.equal($.wasTouched('#val-10-input'), false);
});
