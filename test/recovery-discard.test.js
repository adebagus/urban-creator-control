// Closing the app-start recovery MODAL now sends "discardRecovery". These tests run the REAL server handler from
// index.js against a REAL jobRecovery (temp dir): the saved record is deleted from disk - and is NOT touched while a
// live job is being tracked (that record belongs to the running job).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createJobRecovery, RECOVERY_FILENAME } = require('../jobRecovery');

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

function grabSocketHandler(event) {
  const marker = 'socket.on("' + event + '", function(';
  const start = INDEX_SRC.indexOf(marker);
  assert.notEqual(start, -1, 'cannot find socket handler ' + event);
  const fnStart = start + ('socket.on("' + event + '", ').length;
  const end = INDEX_SRC.indexOf('\n  });', fnStart);
  assert.notEqual(end, -1);
  return '(' + INDEX_SRC.slice(fnStart, end + '\n  }'.length) + ')';
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-discard-'));
  const jobRecovery = createJobRecovery({ getDir: () => dir, autoTimer: false, getFirstUnackedQ: () => 5, getPlannerBlocks: () => 35 });
  const ctx = { jobRecovery };
  vm.createContext(ctx);
  const discard = vm.runInContext(grabSocketHandler('discardRecovery'), ctx);
  const file = path.join(dir, RECOVERY_FILENAME);
  const begin = () => jobRecovery.begin({ fileName: 'part.nc', lineOffset: 0, lineCount: 50, marks: Array.from({ length: 50 }, (_, i) => ({ q: i, line: i + 1 })) });
  return { jobRecovery, discard, file, begin };
}

test('an interrupted record is deleted from disk by discardRecovery, and peek() then finds nothing', () => {
  const t = setup();
  assert.ok(t.begin());
  t.jobRecovery.finish('interrupted');
  assert.ok(fs.existsSync(t.file), 'precondition: the record is on disk');
  assert.ok(t.jobRecovery.peek());
  t.discard();
  assert.equal(fs.existsSync(t.file), false, 'deleted');
  assert.equal(t.jobRecovery.peek(), null, 'and nothing is offered at the next app start');
});

test('discardRecovery does NOT touch the record of a job that is running right now', () => {
  const t = setup();
  assert.ok(t.begin());
  assert.ok(t.jobRecovery.isTracking());
  t.discard();
  assert.ok(fs.existsSync(t.file), 'the live job keeps its record');
  assert.ok(t.jobRecovery.isTracking());
});

test('discardRecovery with nothing saved does nothing and does not throw', () => {
  const t = setup();
  assert.doesNotThrow(() => t.discard());
  assert.equal(t.jobRecovery.peek(), null);
});
