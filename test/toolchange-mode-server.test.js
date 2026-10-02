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

test("structure: /runjob reads req.body.toolChangeMode with an explicit allow-list (only 'ignore' selects Ignore; anything else, including nothing sent, is 'pause')", () => {
  assert.match(INDEX_SRC, /var recoveryToolChangeMode = \(req\.body && req\.body\.toolChangeMode === 'ignore'\) \? 'ignore' : 'pause';/);
});

test('structure: the validated value is passed into the object runJob() receives', () => {
  assert.match(INDEX_SRC, /fileName: recoveryFileName,\s*lineOffset: recoveryLineOffset,\s*toolChangeMode: recoveryToolChangeMode,\s*\}\s*runJob\(object\)/);
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
    toolChangeQIndexes: new Map(), pendingToolChange: null, toolChangeWizardEmitted: false, toolChangeMode: 'pause',
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
      ['isToolChangeLine', 'toolChangeToolNumber', 'addQToEnd', 'send1Q', 'BufferSpace', 'machineSend', 'runJob']
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

test("runJob(): object.toolChangeMode 'pause' (or missing, or garbage) sets the module mode to 'pause'", () => {
  for (const value of ['pause', undefined, '', 'Ignore', 'IGNORE', ' ignore', 'fixedToolSensor', 0, null]) {
    const ctx = harness();
    ctx.runJob({ isJob: true, data: 'G1 X1 F500', toolChangeMode: value });
    assert.equal(ctx.toolChangeMode, 'pause', JSON.stringify(value));
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
