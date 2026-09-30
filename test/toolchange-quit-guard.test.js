// Tool-change wizard: a hardware-validation finding (Tahap 1a, scenario #2 -
// "tutup app saat wizard tool-change tampil") turned up a bug that is NOT
// specific to the wizard - it is a pre-existing latent issue in the whole
// app, only EXPOSED by the wizard because it is the first long-lived
// Metro.dialog.create() a user is likely to have open while also wanting to
// quit.
//
// Root cause, and why the FIRST attempt at fixing it did not work (both
// confirmed live, by launching the real Electron app with
// --remote-debugging-port and using the Chrome DevTools Protocol to open a
// dialog and check document.elementFromPoint() at the titlebar's close (X)
// button - not by re-reading the CSS and guessing harder):
//
//   The custom titlebar (app/index.html #windowtitlebar) sits inside the
//   app's root wrapper, ".window.bd-uc-accent" (index.html line 33) - Metro's
//   OWN generic ".window" class, reused here purely for its cosmetic
//   flex/border/background styling. That class sets "position: relative;
//   z-index: 1" (metro.css). A Metro.dialog.create() appends its backdrop
//   (.overlay, position:fixed; z-index:1040) as a SEPARATE sibling of
//   .window, directly under <body>.
//
//   The first fix attempt gave #windowtitlebar its own z-index (1900),
//   reasoning that 1900 > 1040 should win. It did not: ANY positioned
//   element with an explicit (non-auto) z-index establishes a NEW stacking
//   context for all its descendants, and .window's "z-index: 1" already
//   does exactly that. #windowtitlebar's z-index only ever competed against
//   OTHER THINGS INSIDE .window - it could never reach up and compete
//   against .overlay, which lives one level up, at the body level. Verified
//   live: with a dialog open, elementFromPoint() at the "X" button's
//   coordinates still returned the .overlay div, confirming the first fix
//   changed a NUMBER that looked right without changing which STACKING
//   CONTEXT it was compared within - which is the one test-writing lesson
//   this file exists to not repeat: two z-index values being numerically
//   correct is NOT sufficient to prove the actual paint/hit-test order
//   unless there is also no differently-stacked ancestor in between. A pure
//   "titlebarZ > overlayZ" test (kept below, second test) would have PASSED
//   on the broken first fix - it is necessary but not sufficient by itself,
//   which is exactly why the first test in this file asserts the actual
//   escape mechanism (.window's z-index being forced back to auto), not
//   just the numbers.
//
//   The real fix (app/css/main.css) has two parts: (1) ".window.bd-uc-accent
//   { z-index: auto; }" - takes the root wrapper out of its own stacking
//   context (a positioned element with z-index:auto still paints above
//   plain static content exactly as before; it just stops trapping its
//   descendants), so #windowtitlebar's z-index is finally compared directly
//   against a dialog's .overlay at the same (body) level; (2) the titlebar
//   keeps its own z-index above ordinary dialogs but below the startup
//   splash (#splash, z-index 2000), which is meant to block absolutely
//   everything, titlebar included. Re-verified live after this fix: the
//   SAME elementFromPoint() check now returns the close button itself, and
//   a real dispatched click on it does reach socket.emit('minimisetotray').
//
// Separately confirmed: the quit CONFIRMATION itself (index.js's
// quitAndCleanup(), triggered by that socket event) is a NATIVE
// dialog.showMessageBoxSync() - not a second Metro dialog, so this was never
// a "two Metro dialogs stacked" z-index fight as first suspected; it never
// even got that far, because the titlebar click that should have triggered
// it was silently swallowed first.
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

test('the escape mechanism itself: the app root wrapper (.window.bd-uc-accent) has its z-index forced back to auto, so it no longer traps its descendants in their own stacking context', () => {
  // This is the part a pure z-index NUMBER comparison (the next test) cannot
  // prove by itself - see the file header. Metro's generic ".window" sets
  // "z-index: 1" (metro.css, loaded via metro-all.min.css in
  // app/index.html); our override must say "auto", not merely a bigger
  // number (a bigger number is still an explicit z-index, so it would still
  // trap descendants the same way). It wins the cascade on SPECIFICITY, not
  // load order: ".window.bd-uc-accent" (two classes) outranks Metro's plain
  // ".window" (one class) regardless of which stylesheet loads first.
  const rule = cssRule(MAIN_CSS, '.window.bd-uc-accent');
  assert.match(rule, /z-index:\s*auto\s*;/, 'must be literally "auto", not just a larger explicit number');
});

test('structure: app/index.html actually loads metro-all.min.css (the file the .window z-index:1 rule really comes from in production, not the unminified metro.css this test reads for readability)', () => {
  assert.match(INDEX_HTML, /<link rel="stylesheet" href="lib\/metro4\/css\/metro-all\.min\.css" \/>/);
});

test('the custom titlebar (#windowtitlebar) has a HIGHER z-index than a Metro dialog overlay - necessary, but (see above) not by itself sufficient', () => {
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

test('structure: ".window" (Metro\'s generic class) is used exactly once in the app, as our own root wrapper - so overriding it here has no blast radius elsewhere', () => {
  const uses = (INDEX_HTML.match(/class="[^"]*\bwindow\b(?!-)[^"]*"/g) || []);
  assert.equal(uses.length, 1, 'expected exactly one element with the bare "window" class: ' + JSON.stringify(uses));
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
