// The custom titlebar's buttons (minimise/close) must keep working while ANY
// Metro.dialog is open - the Alarm dialog, the error toast dialog, settings
// dialogs, etc. Before this fix a click on the titlebar's X was silently
// swallowed by the dialog's backdrop, so the only way out was Task Manager.
//
// Root cause (confirmed live through the Chrome DevTools Protocol with
// document.elementFromPoint() on the X button, not by reasoning about CSS):
// the titlebar sits inside the app's root wrapper ".window.bd-uc-accent", and
// Metro's generic ".window" class sets "position: relative; z-index: 1". Any
// positioned element with an explicit z-index starts its own stacking
// context, so #windowtitlebar's z-index only competed with things INSIDE
// .window and could never beat a dialog's .overlay (z-index 1040), which is a
// sibling of .window directly under <body>. Giving the titlebar a bigger
// z-index alone (the first attempt) changed a number without changing which
// stacking context it was compared in - it did not work on hardware.
//
// The fix (app/css/main.css) forces ".window.bd-uc-accent { z-index: auto; }"
// so the wrapper stops trapping its descendants, and gives the titlebar a
// z-index above ordinary dialogs but below the startup splash. The first test
// below asserts that escape mechanism itself; the plain number comparison is
// kept but is necessary, not sufficient.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('the escape mechanism itself: the app root wrapper (.window.bd-uc-accent) has its z-index forced back to auto, so it no longer traps its descendants in their own stacking context', () => {
  // Wins the cascade on specificity (two classes vs Metro's one), not load order.
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

test('structure: the "job running - quit anyway?" confirmation is dialog.showMessageBoxSync, not Metro.dialog.create (never a Metro-vs-Metro z-index fight)', () => {
  const start = INDEX_JS.indexOf('function quitAndCleanup(exitCode)');
  assert.notEqual(start, -1);
  const end = INDEX_JS.indexOf('\n}\n', start);
  const body = INDEX_JS.slice(start, end);
  assert.match(body, /dialog\.showMessageBoxSync\(/, 'must be the native Electron dialog');
  assert.ok(!/Metro\.dialog/.test(body), 'must NOT be a second Metro (DOM) dialog');
});
