// Tool-change wizard, Tahap 1a - Commit 1: detecting M6 lines while a job's
// queue is built (index.js's runJob()), before any pause/gate logic exists.
//
// index.js cannot be require()d from a test (it boots Electron and the
// servers), so isToolChangeLine()/toolChangeToolNumber() are extracted from
// its source text and run in a vm sandbox - same pattern as
// test/reconnect-stale-state.test.js and test/dialog-default-dir.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

function grabFunction(name) {
  const start = INDEX_SRC.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot extract function ' + name + ' from index.js');
  const end = INDEX_SRC.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'cannot find the end of function ' + name);
  return INDEX_SRC.slice(start, end + 2);
}

const ctx = {};
vm.createContext(ctx);
vm.runInContext(['isToolChangeLine', 'toolChangeToolNumber'].map(grabFunction).join('\n'), ctx);

// --- isToolChangeLine --------------------------------------------------------

test('isToolChangeLine: recognises M6 in its common forms', () => {
  for (const line of ['M6', 'm6', 'T2 M6', 'M6 T2', 'M06', 'M006', 'G0 X1 M6']) {
    assert.equal(ctx.isToolChangeLine(line), true, line);
  }
});

test('isToolChangeLine: does NOT mistake M60/M600/M16 or a bare T-word for a tool change', () => {
  for (const line of ['M60', 'M600', 'M16', 'T2', 'G0 X1', '']) {
    assert.equal(ctx.isToolChangeLine(line), false, line);
  }
});

test('isToolChangeLine: a bracket comment mentioning M6 is not a tool change', () => {
  assert.equal(ctx.isToolChangeLine('(switch to M6 next)'), false);
  assert.equal(ctx.isToolChangeLine('G0 X1 (M6 later)'), false);
  // ...but a real M6 next to an unrelated bracket comment still counts
  assert.equal(ctx.isToolChangeLine('M6 (change tool)'), true);
});

// --- toolChangeToolNumber -----------------------------------------------------

test('toolChangeToolNumber: reads the T word next to M6', () => {
  assert.equal(ctx.toolChangeToolNumber('T2 M6'), '2');
  assert.equal(ctx.toolChangeToolNumber('M6 T14'), '14');
});

test('toolChangeToolNumber: null when there is no T word (or it is inside a comment)', () => {
  assert.equal(ctx.toolChangeToolNumber('M6'), null);
  assert.equal(ctx.toolChangeToolNumber('M6 (T2 in a comment)'), null);
});

// --- integration: runJob() builds toolChangeQIndexes from a real job ---------
//
// Same vm-harness pattern as test/reconnect-stale-state.test.js: extract the
// REAL functions runJob() calls (send1Q, machineSend, ...) rather than
// stubbing runJob() itself, so this exercises the shipped code.

const BUFFER_VARS =
  INDEX_SRC.match(/var GRBL_RX_BUFFER_SIZE = [^\n]*\n/)[0] +
  INDEX_SRC.match(/var GRBLHAL_RX_BUFFER_SIZE = [^\n]*\n/)[0];
const MODAL_VARS =
  INDEX_SRC.match(/var modalCommands = \[[^\]]*\]\n/)[0] +
  INDEX_SRC.match(/var modalCommandsRegExp = [^\n]*\n/)[0];

function jobHarness() {
  const written = [];
  const jobCtx = {
    gcodeQueue: [], queuePointer: 0, sentBuffer: [], toolChangeQIndexes: new Map(), toolChangeWizardQueue: [], toolChangeWizardPointer: 0, toolChangeWizardSentBuffer: [], VALID_TOOLCHANGE_MODES: ['ignore', 'fixedToolSensor'], VALID_TOOLSENSOR_FIRST_BEHAVIOURS: ['always-wizard', 'always-probe', 'prompt'],
    statusLoop: null, queueCounter: null,
    status: {
      comms: { connectionStatus: 2, blocked: false, paused: false, queue: 0, runStatus: 'Idle' },
      machine: { modals: {}, firmware: { type: 'grbl', rxBufferSize: 254 }, tool: { nexttool: {} } },
    },
    fluidncConfig: '', jobStartTime: false, jobCompletedMsg: '',
    jogWindow: null, debug_log() {}, setInterval() { return 1; }, clearInterval() {},
    port: { isOpen: true, write(s) { written.push(s); } },
    io: { sockets: { emit() {} } },
    jobRecovery: { begin() {}, sourceLineAt() { return null; }, markFullySent() {} },
  };
  vm.createContext(jobCtx);
  vm.runInContext(
    BUFFER_VARS + MODAL_VARS +
      ['isToolChangeLine', 'toolChangeToolNumber', 'addQToEnd', 'BufferSpace', 'machineSend', 'send1Q', 'isValidSensorLocation', 'runJob']
        .map(grabFunction).join('\n'),
    jobCtx
  );
  return { jobCtx, written };
}

test('runJob(): toolChangeQIndexes gets one entry per M6 line, at the right queue index and source line', () => {
  const { jobCtx } = jobHarness();
  // Only ";" comments are stripped before this point - a "(...)" one is a real
  // queue entry, same as everywhere else in this file (grbl's own parser skips
  // it). And addQToEnd() pushes an extra "$G" after every T-word, so the queue
  // index of the SECOND tool change is not simply "one past the first" - this
  // is exactly the kind of drift recoveryMarks already has to account for.
  const gcode = [
    'G0 X1',              // line 1 -> queue index 0
    '(header)',           // line 2 -> queue index 1 (a real entry, not dropped)
    'T2 M6',               // line 3 -> queue index 2 (then addQToEnd adds a "$G" at index 3)
    'G0 Z1',               // line 4 -> queue index 4
    'T3 M6 (2nd change)', // line 5 -> queue index 5
  ].join('\n');

  jobCtx.runJob({ isJob: true, data: gcode, fileName: 'part.nc' });

  // Compared field-by-field, not with deepEqual: the {line, tool} objects were
  // built by code running INSIDE the vm sandbox, so they come from a
  // different Object.prototype than this file's own object literals -
  // deepStrictEqual (which assert.deepEqual aliases) treats that as unequal
  // even when every property matches.
  assert.deepEqual([...jobCtx.toolChangeQIndexes.keys()], [2, 5]);
  const first = jobCtx.toolChangeQIndexes.get(2);
  assert.equal(first.line, 3);
  assert.equal(first.tool, '2');
  const second = jobCtx.toolChangeQIndexes.get(5);
  assert.equal(second.line, 5);
  assert.equal(second.tool, '3');
});

test('runJob(): a probing/console run (isJob: false) is never intercepted, even with an M6 in it', () => {
  const { jobCtx } = jobHarness();
  jobCtx.jobRecovery.begin = () => { throw new Error('must not be called for isJob:false'); };

  jobCtx.runJob({ isJob: false, data: 'M6\nG0 X1' });

  assert.equal(jobCtx.toolChangeQIndexes.size, 0);
});

test('runJob(): starting a new tracked job clears any leftover entries from before', () => {
  const { jobCtx } = jobHarness();
  jobCtx.toolChangeQIndexes.set(99, { line: 1, tool: null });

  jobCtx.runJob({ isJob: true, data: 'G0 X1' });

  assert.equal(jobCtx.toolChangeQIndexes.has(99), false);
});
