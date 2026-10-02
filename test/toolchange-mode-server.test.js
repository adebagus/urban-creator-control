// Tool-change wizard, Tahap 1b-i, Commit 3: the server side of the mode
// picker - the /runjob route reads req.body.toolChangeMode (validated,
// never trusted blindly - exactly one value, 'ignore', selects Ignore;
// anything else, including nothing sent at all, is 'pause'), and runJob()
// re-validates it independently into the module-level toolChangeMode that
// send1Q() will read (Commit 4).
//
// The /runjob route itself is an Express handler wired through multer -
// too much to stand up for a unit test, so (same convention as
// test/start-from-line.test.js's recoveryLineOffset checks) its field
// extraction is verified by matching the real source text, not executing
// it. runJob()'s OWN validation, in contrast, is a plain function and IS
// executed for real here, same vm-sandbox pattern as every other
// tool-change wizard test file.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createJobRecovery } = require('../jobRecovery');

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

function grabFunction(name) {
  const start = INDEX_SRC.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot extract function ' + name);
  const end = INDEX_SRC.indexOf('\n}\n', start);
  assert.notEqual(end, -1);
  return INDEX_SRC.slice(start, end + 2);
}

// --------------------------------------------------------------------------
// /runjob route: field extraction and validation, verified in the real
// source text (same convention as the existing recoveryLineOffset checks).
// --------------------------------------------------------------------------

test("structure: /runjob reads req.body.toolChangeMode with an explicit allow-list (only 'ignore'/'fixedToolSensor' pass through; anything else, including nothing sent, is 'pause')", () => {
  assert.match(INDEX_SRC, /var recoveryToolChangeMode = \(req\.body && VALID_TOOLCHANGE_MODES\.indexOf\(req\.body\.toolChangeMode\) !== -1\) \? req\.body\.toolChangeMode : 'pause';/);
});

test("structure: the allow-list itself is exactly ['ignore', 'fixedToolSensor'] - 'pause' is the fallback, not a list member", () => {
  assert.match(INDEX_SRC, /var VALID_TOOLCHANGE_MODES = \['ignore', 'fixedToolSensor'\];/);
});

// --------------------------------------------------------------------------
// Tahap 1b-ii Commit 5: /runjob also reads the Fixed Tool Sensor's location
// and first-tool behaviour (sent with every real job POST since Commit 2,
// unread until now).
// --------------------------------------------------------------------------

test('structure: /runjob reads toolSensorX/Y/Z through parseFiniteFloat, building a location only when all three are valid', () => {
  assert.match(INDEX_SRC, /var sensorX = parseFiniteFloat\(req\.body && req\.body\.toolSensorX\);/);
  assert.match(INDEX_SRC, /var sensorY = parseFiniteFloat\(req\.body && req\.body\.toolSensorY\);/);
  assert.match(INDEX_SRC, /var sensorZ = parseFiniteFloat\(req\.body && req\.body\.toolSensorZ\);/);
  assert.match(INDEX_SRC, /var recoverySensorLocation = \(sensorX !== null && sensorY !== null && sensorZ !== null\) \?\s*\{ x: sensorX, y: sensorY, z: sensorZ \} : null;/);
});

test('structure: /runjob reads toolSensorFirstBehaviour through its own allow-list, defaulting to always-wizard', () => {
  assert.match(INDEX_SRC, /var VALID_TOOLSENSOR_FIRST_BEHAVIOURS = \['always-wizard', 'always-probe', 'prompt'\];/);
  assert.match(INDEX_SRC, /var recoverySensorFirstBehaviour = \(req\.body && VALID_TOOLSENSOR_FIRST_BEHAVIOURS\.indexOf\(req\.body\.toolSensorFirstBehaviour\) !== -1\) \?\s*req\.body\.toolSensorFirstBehaviour : 'always-wizard';/);
});

// parseFiniteFloat()/isValidSensorLocation(): plain functions, executed for real.
const parseFiniteFloat = (() => {
  const start = INDEX_SRC.indexOf('function parseFiniteFloat(');
  const end = INDEX_SRC.indexOf('\n}\n', start);
  return new Function('return ' + INDEX_SRC.slice(start, end + 2))();
})();
const isValidSensorLocation = (() => {
  const start = INDEX_SRC.indexOf('function isValidSensorLocation(');
  const end = INDEX_SRC.indexOf('\n}\n', start);
  return new Function('return ' + INDEX_SRC.slice(start, end + 2))();
})();

test('parseFiniteFloat(): accepts real numeric strings, including negative/decimal, rejects empty/whitespace/non-numeric/non-string', () => {
  assert.equal(parseFiniteFloat('12.5'), 12.5);
  assert.equal(parseFiniteFloat('-3'), -3);
  assert.equal(parseFiniteFloat('0'), 0);
  for (const bad of ['', '   ', 'abc', '12abc', 'NaN', 'Infinity', undefined, null, 5, {}]) {
    assert.equal(parseFiniteFloat(bad), null, JSON.stringify(bad));
  }
});

test('isValidSensorLocation(): true only for a plain {x, y, z} of finite numbers', () => {
  assert.equal(isValidSensorLocation({ x: 1, y: 2, z: 3 }), true);
  assert.equal(isValidSensorLocation({ x: -1.5, y: 0, z: -40 }), true);
  for (const bad of [null, undefined, {}, { x: 1, y: 2 }, { x: '1', y: 2, z: 3 }, { x: NaN, y: 2, z: 3 }, { x: Infinity, y: 2, z: 3 }]) {
    assert.equal(isValidSensorLocation(bad), false, JSON.stringify(bad));
  }
});

test('structure: the validated value is passed into the object runJob() receives', () => {
  assert.match(INDEX_SRC, /fileName: recoveryFileName,\s*lineOffset: recoveryLineOffset,\s*toolChangeMode: recoveryToolChangeMode,\s*toolSensorLocation: recoverySensorLocation,\s*toolSensorFirstBehaviour: recoverySensorFirstBehaviour,\s*\}\s*runJob\(object\)/);
});

// --------------------------------------------------------------------------
// runJob()'s own validation: executed for real.
// --------------------------------------------------------------------------

const BUFFER_VARS =
  INDEX_SRC.match(/var GRBL_RX_BUFFER_SIZE = [^\n]*\n/)[0] +
  INDEX_SRC.match(/var GRBLHAL_RX_BUFFER_SIZE = [^\n]*\n/)[0];
const MODAL_VARS =
  INDEX_SRC.match(/var modalCommands = \[[^\]]*\]\n/)[0] +
  INDEX_SRC.match(/var modalCommandsRegExp = [^\n]*\n/)[0];

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-tc-mode-'));
  const ctx = {
    gcodeQueue: [], queuePointer: 0, sentBuffer: [], statusLoop: null, queueCounter: null,
    toolChangeQIndexes: new Map(), toolChangeWizardQueue: [], toolChangeWizardPointer: 0, toolChangeWizardSentBuffer: [], VALID_TOOLCHANGE_MODES: ['ignore', 'fixedToolSensor'], VALID_TOOLSENSOR_FIRST_BEHAVIOURS: ['always-wizard', 'always-probe', 'prompt'], pendingToolChange: null, toolChangeWizardEmitted: false, toolChangeMode: 'pause',
    status: {
      comms: { connectionStatus: 2, blocked: false, paused: false, awaitingToolChange: false, runStatus: 'Idle', queue: 0, alarm: '', interfaces: { type: 'usb' } },
      machine: { modals: {}, firmware: { type: 'grbl', platform: 'grbl', rxBufferSize: 254, blockBufferSize: '35', version: '', date: '', buffer: '' }, tool: { nexttool: {} } },
    },
    fluidncConfig: '', jobStartTime: false, uploadedgcode: '', jobCompletedMsg: '', laserTestOn: false,
    jogWindow: null, debug_log() {}, serialLog() {}, setInterval() { return 1; }, clearInterval() {},
    setTimeout(fn) { fn(); return 1; },
    port: { isOpen: true, write() {} },
    io: { sockets: { emit() {} } },
  };
  ctx.jobRecovery = createJobRecovery({
    getDir: () => dir, autoTimer: false,
    getFirstUnackedQ: () => (ctx.gcodeQueue.length === 0 ? -1 : Math.max(0, ctx.queuePointer - ctx.sentBuffer.length)),
    getPlannerBlocks: () => 35,
  });
  vm.createContext(ctx);
  vm.runInContext(
    BUFFER_VARS + MODAL_VARS +
      ['isToolChangeLine', 'toolChangeToolNumber', 'addQToEnd', 'send1Q', 'BufferSpace', 'machineSend', 'isValidSensorLocation', 'runJob']
        .map(grabFunction).join('\n'),
    ctx
  );
  return ctx;
}

test("runJob(): object.toolChangeMode 'ignore' sets the module mode to 'ignore'", () => {
  const ctx = harness();
  ctx.runJob({ isJob: true, data: 'G1 X1 F500', toolChangeMode: 'ignore' });
  assert.equal(ctx.toolChangeMode, 'ignore');
});

test("runJob(): object.toolChangeMode 'fixedToolSensor' sets the module mode to 'fixedToolSensor'", () => {
  const ctx = harness();
  ctx.runJob({ isJob: true, data: 'G1 X1 F500', toolChangeMode: 'fixedToolSensor' });
  assert.equal(ctx.toolChangeMode, 'fixedToolSensor');
});

test("runJob(): object.toolChangeMode 'pause' (or missing, or garbage) sets the module mode to 'pause'", () => {
  for (const value of ['pause', undefined, '', 'Ignore', 'IGNORE', ' ignore', 'FixedToolSensor', 'fixed-tool-sensor', 0, null]) {
    const ctx = harness();
    ctx.runJob({ isJob: true, data: 'G1 X1 F500', toolChangeMode: value });
    assert.equal(ctx.toolChangeMode, 'pause', JSON.stringify(value));
  }
});

test("runJob(): all THREE modes are correctly distinguished from each other, not just each one individually falling back to pause", () => {
  for (const mode of ['pause', 'ignore', 'fixedToolSensor']) {
    const ctx = harness();
    ctx.runJob({ isJob: true, data: 'G1 X1 F500', toolChangeMode: mode });
    assert.equal(ctx.toolChangeMode, mode, mode);
  }
});

test("runJob(): an UNTRACKED run (isJob: false - probing/console) never changes the mode, even if it tries to claim 'ignore'", () => {
  const ctx = harness();
  ctx.toolChangeMode = 'pause';
  ctx.runJob({ isJob: false, data: 'G1 X1 F500', toolChangeMode: 'ignore' });
  assert.equal(ctx.toolChangeMode, 'pause', 'a probe/console command has no mode of its own to set it to');
});

// --------------------------------------------------------------------------
// The exact scenario asked for: two tracked jobs back to back, no reset in
// between (there is none, by design - see the comment above the variable's
// declaration in index.js) - the SECOND job's own choice must win outright,
// proving the scalar can never get "stuck" on a previous job's mode.
// --------------------------------------------------------------------------

test("runJob(): job 1 'ignore' immediately followed by job 2 'pause', with NO reset in between, leaves the mode correctly at 'pause' - not stuck on job 1's", () => {
  const ctx = harness();

  ctx.runJob({ isJob: true, data: 'G1 X1 F500\nT2 M6\nG1 X2 F500', toolChangeMode: 'ignore' });
  assert.equal(ctx.toolChangeMode, 'ignore', 'precondition: job 1 really did set ignore');

  ctx.runJob({ isJob: true, data: 'G1 X1 F500', toolChangeMode: 'pause' });
  assert.equal(ctx.toolChangeMode, 'pause', 'job 2 must not inherit job 1\'s mode');
});

test("runJob(): the same, the OTHER way round - job 1 'pause' then job 2 'ignore' - job 2's choice also wins outright", () => {
  const ctx = harness();

  ctx.runJob({ isJob: true, data: 'G1 X1 F500\nT2 M6\nG1 X2 F500', toolChangeMode: 'pause' });
  assert.equal(ctx.toolChangeMode, 'pause');

  ctx.runJob({ isJob: true, data: 'G1 X1 F500', toolChangeMode: 'ignore' });
  assert.equal(ctx.toolChangeMode, 'ignore');
});

test("runJob(): job 1 'ignore', then an UNTRACKED probe (isJob:false), then job 2 with NO toolChangeMode field at all - job 2 still correctly resets to 'pause' (the probe in between changes nothing either way)", () => {
  const ctx = harness();

  ctx.runJob({ isJob: true, data: 'G1 X1 F500', toolChangeMode: 'ignore' });
  assert.equal(ctx.toolChangeMode, 'ignore');

  ctx.runJob({ isJob: false, data: 'G1 X1 F500' }); // a bounding-box/probe move, in between
  assert.equal(ctx.toolChangeMode, 'ignore', 'the probe did not touch it (previous test already covers this alone)');

  ctx.runJob({ isJob: true, data: 'G1 X1 F500' }); // job 2: no toolChangeMode field sent at all
  assert.equal(ctx.toolChangeMode, 'pause', 'job 2 is a fresh tracked job - it gets the safe default, not whatever was left lying around');
});
