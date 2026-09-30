// Tool-change wizard: a hardware-validation finding (Tahap 1a, scenario #2 -
// "tutup app saat wizard tool-change tampil") turned up a bug that is NOT
// specific to the wizard - it is a pre-existing latent issue in the whole
// app, only EXPOSED by the wizard because it is the first long-lived
// Metro.dialog.create() a user is likely to have open while also wanting to
// quit.
//
// Root cause (confirmed by reading the code, not by guessing): the app's
// custom HTML titlebar close/minimize/maximize buttons (app/index.html
// #windowtitlebar) are a normal static-flow element with no z-index of its
// own. Metro's dialog backdrop (.overlay, from app/lib/metro4/js/metro.js's
// _overlay(), styled in app/lib/metro4/css/metro.css as position:fixed;
// z-index:1040) therefore paints ON TOP of the titlebar whenever ANY
// Metro.dialog.create() is open (Alarm, Error, or the new tool-change
// wizard) - so a click on the titlebar's "X" lands on the overlay instead
// and never reaches the titlebar's onclick, which is what emits
// 'minimisetotray'. The quit CONFIRMATION itself (index.js's
// quitAndCleanup(), triggered by that socket event) is a NATIVE
// dialog.showMessageBoxSync() - not a second Metro dialog, so this was never
// a "two Metro dialogs stacked" z-index fight as first suspected; it never
// even got that far, because the titlebar click that should have triggered
// it was silently swallowed first.
//
// Fix: app/css/main.css gives #windowtitlebar position:relative + a z-index
// above every ordinary Metro dialog (but still below the startup splash,
// which is meant to block everything). These tests pin that ordering, and
// separately confirm isMachineBusy() (the function quitAndCleanup() calls to
// decide whether to show its own confirmation at all) correctly reports
// "busy" while a tool-change wait is parked - so once the titlebar click
// gets through, the existing confirmation dialog fires as designed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const MAIN_CSS = read('app/css/main.css');
const METRO_CSS = read('app/lib/metro4/css/metro.css');
const SPLASH_CSS = read('app/css/splash.css');
const INDEX_JS = read('index.js');
const INDEX_HTML = read('app/index.html');

function cssRule(css, selector) {
  const i = css.indexOf(selector + ' {');
  assert.notEqual(i, -1, 'cannot find CSS rule ' + selector);
  return css.slice(i, css.indexOf('}', i));
}
function zIndexOf(rule) {
  const m = rule.match(/z-index:\s*(-?\d+)/);
  assert.ok(m, 'no z-index in rule: ' + rule);
  return parseInt(m[1], 10);
}

// --------------------------------------------------------------------------
// The fix: the titlebar now outranks ordinary Metro dialogs
// --------------------------------------------------------------------------

test('the custom titlebar (#windowtitlebar) has a HIGHER z-index than a Metro dialog overlay, so its buttons stay clickable while one is open', () => {
  const titlebarRule = cssRule(MAIN_CSS, '#windowtitlebar');
  assert.match(titlebarRule, /position:\s*relative/, 'z-index has no effect on a static (non-positioned) element');
  const titlebarZ = zIndexOf(titlebarRule);
  const overlayZ = zIndexOf(cssRule(METRO_CSS, '.overlay'));
  assert.ok(titlebarZ > overlayZ, 'titlebar z-index (' + titlebarZ + ') must beat Metro .overlay (' + overlayZ + ')');
});

test('the titlebar still stays BELOW the startup splash - that one is meant to block everything, including the titlebar', () => {
  const titlebarZ = zIndexOf(cssRule(MAIN_CSS, '#windowtitlebar'));
  const splashZ = zIndexOf(cssRule(SPLASH_CSS, '#splash'));
  assert.ok(titlebarZ < splashZ, 'titlebar (' + titlebarZ + ') must stay under #splash (' + splashZ + ')');
});

test('structure: the titlebar in app/index.html is the same element this CSS rule targets', () => {
  assert.match(INDEX_HTML, /<div id="windowtitlebar" class="window-caption[^"]*"/);
});

// --------------------------------------------------------------------------
// Ruling out the OTHER half of the original theory: the quit confirmation is
// a NATIVE dialog, not a second Metro one - there was never a Metro-vs-Metro
// z-index fight to begin with.
// --------------------------------------------------------------------------

test('structure: the "job running - quit anyway?" confirmation is dialog.showMessageBoxSync, not Metro.dialog.create', () => {
  const start = INDEX_JS.indexOf('function quitAndCleanup(exitCode)');
  assert.notEqual(start, -1);
  const end = INDEX_JS.indexOf('\n}\n', start);
  const body = INDEX_JS.slice(start, end);
  assert.match(body, /dialog\.showMessageBoxSync\(/, 'must be the native Electron dialog');
  assert.ok(!/Metro\.dialog/.test(body), 'must NOT be a second Metro (DOM) dialog');
});

// --------------------------------------------------------------------------
// isMachineBusy(): does it correctly see a tool-change wait as "busy"?
// (If not, quitAndCleanup would skip the confirmation ENTIRELY - a much
// worse bug than a swallowed click, since the app would just quit silently
// mid-wait. It does not: awaitingToolChange never changes
// status.comms.connectionStatus, which stays 3 the whole time - see Commit 2
// of the tool-change wizard work - so isMachineBusy's very first check
// already covers it.)
// --------------------------------------------------------------------------

function grabFunction(name) {
  const start = INDEX_JS.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot extract function ' + name);
  const end = INDEX_JS.indexOf('\n}\n', start);
  assert.notEqual(end, -1);
  return INDEX_JS.slice(start, end + 2);
}
// isMachineBusy() takes NO parameter - it reads the module-level `status`
// straight out of its own closure (wrapped in try/catch, so a MISSING status
// silently returns false rather than throwing - which is exactly why passing
// one as an argument, as a first attempt at this test did, silently tests
// nothing: the function never looks at its arguments at all).
function checkBusy(status) {
  const ctx = { status };
  vm.createContext(ctx);
  vm.runInContext(grabFunction('isMachineBusy'), ctx);
  return ctx.isMachineBusy();
}

test('isMachineBusy(): reports busy while parked at a tool-change wait, exactly as it would for an ordinary running job', () => {
  // The controller genuinely reports Idle at this point (Commit 3 already
  // waits for that before showing the wizard) - it is connectionStatus
  // (still 3, "streaming") that must carry the "busy" signal here, since
  // runStatus alone ("Idle") would not.
  assert.equal(checkBusy({ comms: { connectionStatus: 3, runStatus: 'Idle', awaitingToolChange: true } }), true);
});

test('isMachineBusy(): connectionStatus 3 alone (no awaitingToolChange field at all) is already enough - an ordinary running job is unaffected', () => {
  assert.equal(checkBusy({ comms: { connectionStatus: 3, runStatus: 'Idle' } }), true);
});

test('isMachineBusy(): NOT busy once the wait (and the job) is fully done - connectionStatus back to 2, queue empty', () => {
  assert.equal(checkBusy({ comms: { connectionStatus: 2, runStatus: 'Idle', awaitingToolChange: false } }), false);
});

test('isMachineBusy(): a missing/broken status object never throws - it just means "not busy" (this is what let the earlier version of this test pass for the wrong reason - documented so it cannot happen silently again)', () => {
  assert.equal(checkBusy(undefined), false);
  assert.equal(checkBusy({}), false);
});
