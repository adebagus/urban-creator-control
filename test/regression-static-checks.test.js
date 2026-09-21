// Static regression checks for P0-P7: these don't need Electron, a browser,
// or hardware - they just confirm the actual committed files still say what
// they're supposed to say. Each one exists because a *previous* stage fixed
// a specific, real problem (see the P0-P7 conversation history) - if one of
// these ever fails, it means something silently reverted that fix.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), 'utf8');
const exists = (relPath) => fs.existsSync(path.join(ROOT, relPath));

// ---------------------------------------------------------------------------
// P0: DEV build isolation
// ---------------------------------------------------------------------------
test('P0: package.json identity is isolated from the real OpenBuilds CONTROL', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'urban-creator-control');
  assert.notEqual(pkg.build.appId, 'openbuilds.control');
  assert.equal(pkg.build.appId, 'id.urbancreator.control.dev');
  assert.notEqual(pkg.build.productName, 'OpenBuildsCONTROL');
});

test('P0: index.js sets a DEV-specific userData path and AUMID before anything else runs', () => {
  const src = read('index.js');
  assert.match(src, /setPath\('userData',\s*path\.join\(electronApp\.getPath\('appData'\),\s*'UrbanCreatorCONTROL-dev'\)\)/);
  assert.match(src, /setAppUserModelId\("id\.urbancreator\.control\.dev"\)/);
});

// ---------------------------------------------------------------------------
// P1/P2: serial lifecycle + app/process lifecycle cleanup (existence markers
// only - the actual behaviour needs real hardware/a real quit, see the
// manual checklist)
// ---------------------------------------------------------------------------
test('P1: the serial-port diagnostic logger and graceful-quit machinery still exist', () => {
  const src = read('index.js');
  assert.match(src, /function serialLog\(level, message\)/);
  assert.match(src, /function quitAndCleanup\(exitCode\)/);
});

test('P2: child-process tracking for firmware flashing (esptool) still exists', () => {
  const src = read('index.js');
  assert.match(src, /var activeChildProcesses = \[\];/);
  assert.match(src, /function killActiveChildProcesses\(\)/);
  assert.match(src, /trackChildProcess\(child, 'esptool \(BLOX flash\)'\)/);
  assert.match(src, /trackChildProcess\(child, 'esptool \(Interface flash\)'\)/);
  assert.match(src, /trackChildProcess\(child, 'esptool \(grblHAL\/BlackBoxX32 flash\)'\)/);
});

// ---------------------------------------------------------------------------
// P3: localhost backend port isolation + CORS/CSRF hardening
// ---------------------------------------------------------------------------
test('P3: default ports are DEV-specific, not the real app\'s 3000/3001', () => {
  const src = read('index.js');
  assert.match(src, /config\.webPorts = \[4000, 4020, 4200, 4220\]/);
  assert.match(src, /config\.webPortSsl = process\.env\.WEB_PORT_SSL \|\| 4001;/);
  assert.doesNotMatch(src, /config\.webPorts = \[3000/);
});

test('P3: the origin allowlist is computed live (not a static array captured before port fallback)', () => {
  const src = read('index.js');
  // Regression guard for the exact bug reported and fixed mid-P3: a `var
  // ALLOWED_ORIGINS = [...]` captured once at module load would go stale
  // the moment httpServerError() falls back to the next port.
  assert.match(src, /function getAllowedOrigins\(\)/);
  assert.doesNotMatch(src, /var ALLOWED_ORIGINS\s*=\s*\[/);
});

test('P3: state-changing requests from a disallowed origin are actively rejected (not just missing a CORS header)', () => {
  const src = read('index.js');
  assert.match(src, /function rejectCrossOriginStateChanges/);
  assert.match(src, /res\.status\(403\)/);
});

// ---------------------------------------------------------------------------
// P4: security audit - OpenBuilds' TLS key removed, auto-updater disabled
// ---------------------------------------------------------------------------
test('P4: OpenBuilds\' original TLS private key/cert are gone, a fork-owned self-signed pair exists instead', () => {
  assert.equal(exists('privkey1.pem'), false, 'privkey1.pem (OpenBuilds\' real key) must not come back');
  assert.equal(exists('fullchain1.pem'), false);
  assert.equal(exists('dev-selfsigned-key.pem'), true);
  assert.equal(exists('dev-selfsigned-cert.pem'), true);
});

test('P4: index.js loads the self-signed dev cert, not the old OpenBuilds filenames', () => {
  const src = read('index.js');
  assert.match(src, /dev-selfsigned-key\.pem/);
  assert.match(src, /dev-selfsigned-cert\.pem/);
  assert.doesNotMatch(src, /readFileSync\(path\.join\(__dirname, 'privkey1\.pem'\)\)/);
});

test('P4: auto-update check is disabled at the source (early return before the OpenBuilds API call)', () => {
  const src = read('app/js/updates.js');
  const fnStart = src.indexOf('function checkUpdate()');
  const getJsonIdx = src.indexOf('api.github.com/repos/OpenBuilds');
  assert.ok(fnStart !== -1 && getJsonIdx !== -1 && getJsonIdx > fnStart, 'expected to find checkUpdate() followed later by the OpenBuilds API URL');
  const guardedRegion = src.slice(fnStart, getJsonIdx);
  assert.match(guardedRegion, /return;/, 'checkUpdate() must return before reaching the getJSON call to OpenBuilds\' API');
});

test('P4: dev-app-update.yml no longer points at the real OpenBuilds/OpenBuilds-CONTROL repo', () => {
  const yml = read('dev-app-update.yml');
  // Strip comment lines first - the file's own explanatory comment mentions
  // "owner: OpenBuilds / repo: OpenBuilds-CONTROL" as history, which would
  // otherwise false-positive against a naive whole-file regex.
  const liveLines = yml
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(liveLines, /owner:\s*OpenBuilds\s*$/m);
  assert.doesNotMatch(liveLines, /repo:\s*OpenBuilds-CONTROL\s*$/m);
});

test('P4: package.json publish config cannot leak an update target to OpenBuilds\' repo', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.build.publish, null);
});

// ---------------------------------------------------------------------------
// P5: build reproducibility
// ---------------------------------------------------------------------------
test('P5: package-lock.json exists and is not excluded via .gitignore', () => {
  assert.equal(exists('package-lock.json'), true);
  const gitignore = read('.gitignore');
  assert.doesNotMatch(gitignore, /^package-lock\.json\s*$/m);
});

test('P5: Node engine is pinned', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.engines && pkg.engines.node, '20.x');
});

test('P5: the OpenBuilds changelog auto-fetch on startup is disabled', () => {
  const src = read('app/js/main.js');
  assert.doesNotMatch(src, /^\s*getChangelog\(\)\s*$/m, 'the unconditional startup call must stay commented out');
});

// ---------------------------------------------------------------------------
// P6: machine profiles - OpenBuilds presets removed, Router/Laser only
// ---------------------------------------------------------------------------
test('P6: selectMachine() no longer contains any OpenBuilds machine-brand preset', () => {
  const src = read('app/js/grbl-settings-defaults.js');
  const start = src.indexOf('function selectMachine');
  const end = src.indexOf('\nfunction setMachineButton');
  assert.ok(start !== -1 && end !== -1, 'selectMachine()/setMachineButton() must both still exist');
  const body = src.slice(start, end);
  for (const oldPreset of ['sphinx55', 'sphinx1050', 'workbee1050', 'workbee1010', 'workbee1510', 'acro55', 'acro510', 'acro1010', 'acro1510', 'acro1515', 'acroa1', 'cbeam', 'cbeamxl', 'leadmachine1010', 'minimill']) {
    assert.doesNotMatch(body, new RegExp(oldPreset), `selectMachine() must not reference the old "${oldPreset}" preset`);
  }
  assert.match(body, /type == "laser"/);
});

test('P6: the old combined Hard-Limits+Homing checkbox (#limitsinstalled/enableLimits) is fully gone', () => {
  const jsSrc = read('app/js/grbl-settings.js');
  const htmlSrc = read('app/index.html');
  assert.doesNotMatch(jsSrc, /function enableLimits/);
  assert.doesNotMatch(htmlSrc, /id="limitsinstalled"/);
  assert.match(jsSrc, /function toggleHardLimits\(\)/);
  assert.match(jsSrc, /function toggleHoming\(\)/);
});

test('P6: the toolhead Add-Ons subsystem (scribe/laser/router/plasma/vfd radios) is fully removed', () => {
  const jsSrc = read('app/js/grbl-settings.js');
  for (const fn of ['enableScribe', 'enableLaser', 'enableRouter', 'enablePlasma', 'enableVFD', 'setSelectedToolhead', 'isMatchingConfig']) {
    assert.doesNotMatch(jsSrc, new RegExp('function ' + fn + '\\('), `${fn}() must not exist anymore`);
  }
});

test('P6: machine-brand images are gone; the toolhead icons other features still use are not', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'app/img/mch')), false, 'app/img/mch (machine-brand logos) must stay deleted');
  assert.equal(exists('app/img/toolhead/router11.png'), true, 'toolhead icons are reused by the Router/Laser toggle - must survive');
  assert.equal(exists('app/img/toolhead/laser.png'), true);
});

// ---------------------------------------------------------------------------
// P7 UI additions: diagonal jog, Stop Jog, distance/mode row, $347, TLS/TCZ
// ---------------------------------------------------------------------------
test('P7: all 4 diagonal jog buttons exist in the HTML with correct, non-swapped icon rotations', () => {
  const html = read('app/index.html');
  const expectations = [
    { id: 'xMyP', rotate: 'rotate--45' }, // NW
    { id: 'xPyP', rotate: 'rotate-45' }, // NE
    { id: 'xMyM', rotate: 'rotate--135' }, // SW - this exact pair was reported
    { id: 'xPyM', rotate: 'rotate-135' }, //   swapped by manual testing once already
  ];
  for (const { id, rotate } of expectations) {
    const btnStart = html.indexOf(`id="${id}"`);
    assert.notEqual(btnStart, -1, `diagonal button #${id} must exist`);
    const snippet = html.slice(btnStart, btnStart + 300);
    assert.match(snippet, new RegExp(rotate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `#${id} must use ${rotate} (NW/SW use negative rotation, NE/SE use positive)`);
  }
});

test('P7: the Stop Jog button exists and calls cancelJog()', () => {
  const html = read('app/index.html');
  assert.match(html, /id="stopJog"/);
  const jsSrc = read('app/js/jog.js');
  assert.match(jsSrc, /\$\('#stopJog'\)\.on\('click', function\(ev\) \{\s*cancelJog\(\);/);
});

test('P7: the 5-way distance/mode row (0.1/1/10/100/CONT) exists in both desktop and mobile HTML', () => {
  for (const htmlPath of ['app/index.html', 'app/jog/index.html']) {
    const html = read(htmlPath);
    for (const id of ['dist01', 'dist1', 'dist10', 'dist100', 'distCONT']) {
      assert.match(html, new RegExp(`id="${id}"`), `${htmlPath} must have #${id}`);
    }
    assert.doesNotMatch(html, /id="jogTypeContinuous"/, `${htmlPath}: the old separate Continuous checkbox must be gone`);
  }
});

test('P7: setting $347 has a real label (no more red "$347"/"?" badge)', () => {
  const src = read('app/js/grbl-settings-templates.js');
  const idx = src.indexOf('347: {');
  assert.notEqual(idx, -1, '$347 must be defined in grblSettingsTemplate2');
  const entry = src.slice(idx, idx + 300);
  assert.doesNotMatch(entry, /title: ``/, '$347 must not have an empty title (that\'s what produces the "?" unit badge)');
});

test('P7: TLS/TCZ toolsetter buttons exist and send the exact custom firmware commands', () => {
  const html = read('app/index.html');
  assert.match(html, /sendGcode\('\$TLS'\)/);
  assert.match(html, /sendGcode\('\$TCZ'\)/);
  // Regression guard for the "buttons overlapping Zero X/Y/Z, no visual
  // separation, left-aligned" bug reported and fixed after first landing.
  // P8 moved ATC/TLS/TCZ out of the DRO column (and then out of the narrow
  // per-slider cells from an intermediate attempt) into a row, #atcTlsTczRow,
  // nested in the same flex-column wrapper as the 3 Jog%/Feed%/Tool%
  // Override sliders, directly below them. mt-4's margin-top is the visual
  // separator from the sliders above (replacing the old border-top, and
  // widened from mt-2 - too tight, read as one group with the sliders
  // instead of a distinct one); text-center keeps the row centered. A
  // green border-top (matching .atc-active's color) was later added as an
  // explicit dividing line on top of that spacing - checked via the tag's
  // full attribute text (order-agnostic) rather than a fixed class regex.
  const rowTagOpenMatch = html.match(/<div id="atcTlsTczRow"[^>]*>/);
  assert.ok(rowTagOpenMatch, '#atcTlsTczRow must exist');
  const rowTagOpen = rowTagOpenMatch[0];
  assert.match(rowTagOpen, /class="[^"]*\btext-center\b[^"]*"/, '#atcTlsTczRow must be centered');
  assert.match(rowTagOpen, /class="[^"]*\bmt-4\b[^"]*"/, '#atcTlsTczRow must have a clear visual separator (margin-top) from the sliders above it');
  assert.match(rowTagOpen, /border-top:\s*1px solid #22c55e/, '#atcTlsTczRow must have a green dividing line from the sliders above it');

  const trocellIdx = html.indexOf('id="trocell"');
  const rowStart = html.indexOf('<div id="atcTlsTczRow"');
  const nextSectionStart = html.indexOf('<div id="controlLogs"', rowStart);
  assert.ok(rowStart > trocellIdx, '#atcTlsTczRow must come after the 3 override slider cells, not be nested inside one of them');

  const tlsIdx = html.indexOf("sendGcode('$TLS')");
  const tczIdx = html.indexOf("sendGcode('$TCZ')");
  assert.ok(tlsIdx > rowStart && tlsIdx < nextSectionStart, 'TLS button must be inside #atcTlsTczRow');
  assert.ok(tczIdx > rowStart && tczIdx < nextSectionStart, 'TCZ button must be inside #atcTlsTczRow');
});

test('$347 fix does not fight for the same key as any other setting', () => {
  const src = read('app/js/grbl-settings-templates.js');
  const matches = src.match(/^\s*347:\s*\{/gm) || [];
  assert.equal(matches.length, 1, 'expected exactly one $347 entry, found ' + matches.length);
});

// ---------------------------------------------------------------------------
// P9: server-side job recovery wiring. index.js can't be require()d from a
// test (it boots Electron and the servers on load), so these confirm the hooks
// that jobRecovery.js depends on are still in place. The module's own logic is
// covered behaviourally in test/job-recovery.test.js - these guard the glue.
// ---------------------------------------------------------------------------

// The working tree is CRLF (git autocrlf) - normalise to LF so multi-line
// patterns and the function-end detection below behave the same on every
// checkout, CRLF or LF.
const readLF = (relPath) => read(relPath).replace(/\r\n/g, '\n');

// Body of a top-level `function name(...) {` up to the next top-level closing
// brace - good enough for index.js's flat, unindented function declarations.
function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'function ' + name + ' must exist');
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'could not find the end of ' + name);
  return src.slice(start, end);
}

test('P9 recovery: runJob records the source line BEFORE each addQToEnd, and only for real jobs', () => {
  const body = fnBody(readLF('index.js'), 'runJob');
  assert.match(body, /trackRecovery\s*=\s*\(object\.isJob\s*===\s*true\)/, 'only isJob:true jobs are tracked (not probing / bbox / console)');
  const markIdx = body.indexOf('recoveryMarks.push');
  const addIdx = body.indexOf('addQToEnd(tosend)');
  assert.ok(markIdx !== -1 && addIdx !== -1, 'both calls must exist');
  assert.ok(markIdx < addIdx, 'the mark must capture gcodeQueue.length BEFORE addQToEnd pushes (and injects $G)');
  assert.match(body, /line:\s*i\s*\+\s*1/, 'marks are 1-based SOURCE line numbers, not queue indices');
  assert.match(body, /jobRecovery\.begin\(/);
  assert.match(body, /lineOffset:\s*object\.lineOffset/, 'slice jobs must be able to report editor line numbers');
});

test('P9 recovery: send1Q marks the job fully-sent BEFORE it dumps the queue', () => {
  const body = fnBody(readLF('index.js'), 'send1Q');
  const markIdx = body.indexOf('jobRecovery.markFullySent()');
  const dumpIdx = body.indexOf('gcodeQueue.length = 0');
  assert.ok(markIdx !== -1, 'send1Q must call jobRecovery.markFullySent()');
  assert.ok(markIdx < dumpIdx, 'it reads the live queue, so it must run before the queue is dumped');
});

test('P9 recovery: the record is cleared on controller Idle with nothing left unacknowledged - not on "last line sent"', () => {
  const src = readLF('index.js');
  assert.match(fnBody(src, 'parseFeedback'), /state\s*==\s*"Idle"\)\s*\{\s*(\/\/[^\n]*\n\s*)*jobRecovery\.onIdle\(sentBuffer\.length\s*===\s*0\)/);
  assert.ok(!/jobRecovery\.clear\(/.test(fnBody(src, 'send1Q')), 'send1Q means "sent", not "finished" - it must not clear the record');
});

test('P9 recovery: every way a job dies snapshots first (stop, connection loss, quit) - and a jog-cancel is not a stop', () => {
  const src = readLF('index.js');
  assert.match(fnBody(src, 'stop'), /if\s*\(!\(data\s*&&\s*data\.jog\)\)\s*\{\s*(\/\/[^\n]*\n\s*)*jobRecovery\.finish\('stopped'\)/);
  assert.match(fnBody(src, 'stopPort'), /^function stopPort\(\) \{\s*(\/\/[^\n]*\n\s*)*jobRecovery\.finish\('interrupted'\);/, 'must be the FIRST thing stopPort does - it wipes the queue right after');
  const quit = fnBody(src, 'quitAndCleanup');
  assert.ok(quit.indexOf('jobRecovery.finish(') > quit.indexOf('isQuitting = true'), 'after the user confirmed the quit');
  assert.ok(quit.indexOf('jobRecovery.finish(') < quit.indexOf('stopMachineBeforeQuit('), 'before the stop sequence / port close');
});

test('P9 recovery: the offer/ack/discard socket API exists and never touches a LIVE job\'s record', () => {
  const src = readLF('index.js');
  assert.match(src, /if \(!jobRecovery\.isTracking\(\)\) \{\s*var pendingRecovery = jobRecovery\.peek\(\);/);
  assert.match(src, /socket\.emit\("recoveryOffer", pendingRecovery\)/);
  assert.match(src, /socket\.on\("getRecoveryInfo", function\(ack\)/);
  assert.match(src, /socket\.on\("discardRecovery", function\(\) \{\s*if \(!jobRecovery\.isTracking\(\)\)/);
});

test('P9 recovery: the /runjob route takes the file name from a form field, as untrusted text', () => {
  const src = readLF('index.js');
  assert.match(src, /typeof req\.body\.fileName === 'string'/);
  assert.match(src, /fileName:\s*recoveryFileName/);
});

test('P9 recovery: the client sends the real file name with every job it starts', () => {
  const main = readLF('app/js/main.js');
  const appended = main.match(/formData\.append\("fileName", loadedFileName \|\| ""\)/g) || [];
  assert.equal(appended.length, 2, 'both runJobFile() branches (memory + editor) must send it');
  assert.match(readLF('app/js/keyboard.js'), /isJob: true,\s*fileName: loadedFileName/);
  assert.match(readLF('app/js/toolchange.js'), /lineOffset:\s*startline \|\| 0/, 'slice jobs report editor line numbers');
});

test('P9 recovery: localStorage is no longer a second source of truth', () => {
  for (const f of ['app/js/websocket.js', 'app/wizards/resume/resume.js', 'app/js/main.js']) {
    const src = readLF(f);
    assert.ok(!/localStorage\.setItem\(\s*['"]gcodeLineNumber/.test(src), f + ' must not write the legacy key');
    assert.ok(!/localStorage\.getItem\(\s*['"]gcodeLineNumber/.test(src), f + ' must not read the legacy key');
  }
  assert.match(readLF('app/js/websocket.js'), /localStorage\.removeItem\('gcodeLineNumber'\)/, 'the stale legacy value is dropped');
});

test('P9 recovery: the renderer never puts server-supplied text into HTML unescaped (nodeIntegration is on)', () => {
  const src = readLF('app/wizards/resume/resume.js');
  assert.match(src, /function recoveryEscapeHtml\(/);
  // Any place a name reaches an HTML string must go through the escaper.
  const raw = src.match(/['"]\s*\+\s*(info\.fileName|loadedFileName)\s*\+\s*['"]/g) || [];
  assert.deepEqual(raw, [], 'raw file-name concatenation found: ' + raw.join(' | '));
  for (const needle of ['recoveryEscapeHtml(info.fileName)', 'recoveryEscapeHtml(savedName)']) {
    assert.ok(src.includes(needle), needle + ' expected');
  }
  // Numbers are coerced, not interpolated as-is (the info panel's line numbers).
  assert.match(src, /var resume = parseInt\(info\.resumeLine, 10\);/);
  assert.match(src, /html \+= ' dari <b>' \+ parseInt\(info\.totalLines, 10\) \+ '<\/b> total baris';/);
  // The phone page must not get a recovery dialog.
  assert.match(readLF('app/js/websocket.js'), /socket\.on\('recoveryOffer', function\(info\) \{\s*if \(isJogWidget\) return;/);
});

test('P9 recovery: the recovery module ships in the package', () => {
  assert.ok(exists('jobRecovery.js'));
  assert.match(readLF('index.js'), /require\('\.\/jobRecovery'\)/);
  const pkg = JSON.parse(readLF('package.json'));
  assert.ok(pkg.build.files.includes('**/*'), 'jobRecovery.js relies on the "**/*" files glob to be bundled');
});
