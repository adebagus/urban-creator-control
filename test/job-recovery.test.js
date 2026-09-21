// Tests for jobRecovery.js (P9 server-side "Recover Job" persistence). Runs the
// REAL module against a real temp directory - no Electron, no hardware.
//
// The tests are organised around the specific ways this feature can hurt an
// operator, because a wrong resume line on a CNC means a skipped cut or a
// gouge:
//   - the saved number must be a SOURCE line (blank lines / comments / the
//     synthetic "$G" queue entries must not shift it),
//   - it must err on the early side, never the late side,
//   - it must survive a crash mid-write and reject a corrupt file,
//   - it must be cleared when the job really finished - and not before.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createJobRecovery,
  queueIndexToSourceLine,
  sanitizeFileName,
  RECOVERY_FILENAME,
} = require('../jobRecovery');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'uc-recovery-'));
}

// A controllable stand-in for index.js's live queue state.
function harness(overrides) {
  const dir = tmpDir();
  const state = { q: 0, planner: 35, time: 1_000_000, logs: [] };
  const rec = createJobRecovery({
    getDir: () => dir,
    getFirstUnackedQ: () => state.q,
    getPlannerBlocks: () => state.planner,
    now: () => state.time,
    log: (level, msg) => state.logs.push([level, msg]),
    autoTimer: false, // tests drive tick() by hand
    ...overrides,
  });
  const file = path.join(dir, RECOVERY_FILENAME);
  const readFile = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { dir, file, state, rec, readFile };
}

// Realistic queue for this source (what runJob()+addQToEnd() actually build):
//   1  G21            -> q0, then "$G" injected at q1 (G21 is modal)
//   2  (blank)        -> dropped
//   3  G90            -> q2, "$G" at q3
//   4  G1 X1 F100     -> q4
//   5  ; comment      -> dropped
//   6  M3 S1000       -> q5, "$G" at q6
//   7  G1 X2          -> q7
const MARKS = [
  { q: 0, line: 1 },
  { q: 2, line: 3 },
  { q: 4, line: 4 },
  { q: 5, line: 6 },
  { q: 7, line: 7 },
];

test('queueIndexToSourceLine maps queue indices to SOURCE lines, absorbing $G entries and dropped lines', () => {
  const expected = { 0: 1, 1: 1, 2: 3, 3: 3, 4: 4, 5: 6, 6: 6, 7: 7 };
  for (const [q, line] of Object.entries(expected)) {
    assert.equal(queueIndexToSourceLine(MARKS, Number(q)), line, `queue index ${q}`);
  }
  // Regression guard for the old behaviour: it stored the raw queue index and
  // treated it as an editor line. At queue index 5 that is line 5 (a comment),
  // but the line actually being run is 6.
  assert.notEqual(queueIndexToSourceLine(MARKS, 5), 5);
});

test('queueIndexToSourceLine is safe at the edges and with no data', () => {
  assert.equal(queueIndexToSourceLine(MARKS, -3), 1, 'before the first mark');
  assert.equal(queueIndexToSourceLine(MARKS, 999), 7, 'past the end sticks to the last line');
  assert.equal(queueIndexToSourceLine([], 4), 1);
  assert.equal(queueIndexToSourceLine(undefined, 4), 1);
});

test('sanitizeFileName strips control characters, trims and caps length; non-strings become empty', () => {
  assert.equal(sanitizeFileName('a\u0000b\nc\td'), 'a b c d');
  assert.equal(sanitizeFileName('   part.nc   '), 'part.nc');
  assert.equal(sanitizeFileName('x'.repeat(500)).length, 200);
  for (const bad of [undefined, null, 42, {}, ['a'], true]) {
    assert.equal(sanitizeFileName(bad), '');
  }
});

test('begin() writes a running record starting at the first source line', () => {
  const h = harness();
  assert.equal(h.rec.begin({ fileName: 'part.nc', lineCount: 7, marks: MARKS }), true);
  assert.equal(h.rec.isTracking(), true);
  const r = h.readFile();
  assert.equal(r.version, 1);
  assert.equal(r.state, 'running');
  assert.equal(r.fileName, 'part.nc');
  assert.equal(r.resumeLine, 1);
  assert.equal(r.totalLines, 7);
  assert.equal(r.plannerBlocks, 35);
  assert.equal(r.startedAt, 1_000_000);
});

test('begin() refuses an empty job and leaves nothing tracked', () => {
  const h = harness();
  assert.equal(h.rec.begin({ fileName: 'x', lineCount: 0, marks: [] }), false);
  assert.equal(h.rec.begin(undefined), false);
  assert.equal(h.rec.isTracking(), false);
  assert.equal(fs.existsSync(h.file), false);
});

test('progress is written from the acknowledged position, and no more often than the interval', () => {
  const h = harness({ writeIntervalMs: 2000 });
  h.rec.begin({ fileName: 'part.nc', lineCount: 7, marks: MARKS });
  const firstSavedAt = h.readFile().savedAt;

  // Controller acks up to queue index 5 (line 6) - but only 500ms later.
  h.state.q = 5;
  h.state.time += 500;
  h.rec.tick();
  assert.equal(h.readFile().resumeLine, 1, 'within the write interval: not rewritten yet');
  assert.equal(h.readFile().savedAt, firstSavedAt);

  h.state.time += 1600; // now 2100ms since the last write
  h.rec.tick();
  const r = h.readFile();
  assert.equal(r.resumeLine, 6);
  assert.equal(r.state, 'running');
  assert.ok(r.savedAt > firstSavedAt);
});

test('an unchanged position is never rewritten', () => {
  const h = harness({ writeIntervalMs: 0 });
  h.rec.begin({ fileName: 'p', lineCount: 7, marks: MARKS });
  h.state.q = 4;
  h.state.time += 5000;
  h.rec.tick();
  const savedAt = h.readFile().savedAt;
  h.state.time += 5000;
  h.rec.tick();
  assert.equal(h.readFile().savedAt, savedAt, 'no progress -> no write');
});

test('lineOffset shifts saved lines so a section job still reports EDITOR line numbers', () => {
  const h = harness({ writeIntervalMs: 0 });
  h.rec.begin({ fileName: 'multi.nc', lineOffset: 100, lineCount: 7, marks: MARKS });
  assert.equal(h.readFile().resumeLine, 101);
  assert.equal(h.readFile().totalLines, 107);
  h.state.q = 5;
  h.state.time += 5000;
  h.rec.tick();
  assert.equal(h.readFile().resumeLine, 106);
});

test('finish("stopped") snapshots immediately (ignoring the interval), keeps the file, stops tracking', () => {
  const h = harness({ writeIntervalMs: 60_000 });
  h.rec.begin({ fileName: 'part.nc', lineCount: 7, marks: MARKS });
  h.state.q = 4;
  assert.equal(h.rec.finish('stopped'), true);
  assert.equal(h.rec.isTracking(), false);
  const info = h.rec.peek();
  assert.equal(info.state, 'stopped');
  assert.equal(info.resumeLine, 4);
  assert.equal(info.fileName, 'part.nc');
  assert.equal(h.rec.finish('stopped'), false, 'nothing left to finish');
});

test('finish() with an unknown state is stored as "interrupted"', () => {
  const h = harness();
  h.rec.begin({ fileName: 'p', lineCount: 7, marks: MARKS });
  h.rec.finish('bogus');
  assert.equal(h.rec.peek().state, 'interrupted');
});

test('when the queue is dumped mid-job the LAST GOOD line is kept, never "line 1"', () => {
  // clearAlarm/reset paths set queuePointer=0 and empty the queue. If the
  // tracker recomputed from that it would record "resume from line 1" and
  // silently destroy a good value.
  const h = harness({ writeIntervalMs: 0 });
  h.rec.begin({ fileName: 'part.nc', lineCount: 7, marks: MARKS });
  h.state.q = 5;
  h.state.time += 5000;
  h.rec.tick();
  assert.equal(h.readFile().resumeLine, 6);

  h.state.q = -1; // queue gone
  h.state.time += 5000;
  h.rec.tick();
  assert.equal(h.rec.isTracking(), false);
  const info = h.rec.peek();
  assert.equal(info.state, 'interrupted');
  assert.equal(info.resumeLine, 6);
});

test('after markFullySent the line is frozen even though index.js resets its queue pointer to 0', () => {
  const h = harness({ writeIntervalMs: 0 });
  h.rec.begin({ fileName: 'part.nc', lineCount: 7, marks: MARKS });
  h.state.q = 7; // last line acknowledged-through-6, line 7 still pending
  h.rec.markFullySent();
  assert.equal(h.readFile().state, 'completing');
  assert.equal(h.readFile().resumeLine, 7);

  // send1Q's completion branch now dumps the queue: pointer -> 0.
  h.state.q = 0;
  h.state.time += 5000;
  h.rec.tick();
  h.rec.tick();
  assert.equal(h.readFile().resumeLine, 7, 'must not fall back to line 1');
  assert.equal(h.rec.isTracking(), true);
});

test('USB pulled AFTER the last line was sent: finish() keeps the frozen line, not "line 1"', () => {
  // Real sequence: send1Q's completion branch dumps the queue and zeroes the
  // pointer while the controller is still executing its buffered tail; then
  // the cable comes out -> stopPort() -> finish(). finish() must not
  // recompute from the (now meaningless) reset pointer. The guard lives in
  // refresh(), separate from the one in tick(), so it needs its own test.
  const h = harness({ writeIntervalMs: 0 });
  h.rec.begin({ fileName: 'part.nc', lineCount: 7, marks: MARKS });
  h.state.q = 7;
  h.rec.markFullySent();
  h.state.q = 0; // pointer reset by the completion branch
  assert.equal(h.rec.finish('interrupted'), true);
  const info = h.rec.peek();
  assert.equal(info.state, 'interrupted');
  assert.equal(info.resumeLine, 7, 'must not regress to line 1');
});

test('the file is cleared only when the controller is Idle AND has acknowledged everything', () => {
  const h = harness();
  h.rec.begin({ fileName: 'part.nc', lineCount: 7, marks: MARKS });

  h.rec.onIdle(true); // Idle but the job is not fully sent yet (e.g. starved planner)
  assert.equal(fs.existsSync(h.file), true, 'Idle mid-send must not clear it');

  h.state.q = 7;
  h.rec.markFullySent();
  h.rec.onIdle(false); // Idle report older than the final ack
  assert.equal(fs.existsSync(h.file), true, 'unacknowledged lines remain: keep it');
  assert.equal(h.rec.isTracking(), true);

  h.rec.onIdle(true);
  assert.equal(fs.existsSync(h.file), false, 'finished for real: cleared');
  assert.equal(h.rec.isTracking(), false);
  assert.equal(h.rec.peek(), null);
});

test('clear() removes the file and is harmless when there is none', () => {
  const h = harness();
  h.rec.begin({ fileName: 'p', lineCount: 7, marks: MARKS });
  h.rec.clear('discarded');
  assert.equal(fs.existsSync(h.file), false);
  assert.equal(h.rec.isTracking(), false);
  assert.doesNotThrow(() => h.rec.clear('again'));
});

test('a new job replaces an old recovery record', () => {
  const h = harness();
  h.rec.begin({ fileName: 'old.nc', lineCount: 7, marks: MARKS });
  h.rec.finish('stopped');
  assert.equal(h.rec.peek().fileName, 'old.nc');
  h.rec.begin({ fileName: 'new.nc', lineCount: 7, marks: MARKS });
  const info = h.rec.peek();
  assert.equal(info.fileName, 'new.nc');
  assert.equal(info.state, 'running');
});

test('writes are atomic: no temp file is left behind', () => {
  const h = harness({ writeIntervalMs: 0 });
  h.rec.begin({ fileName: 'p', lineCount: 7, marks: MARKS });
  for (let q = 1; q <= 7; q++) {
    h.state.q = q;
    h.state.time += 5000;
    h.rec.tick();
  }
  h.rec.finish('stopped');
  assert.deepEqual(fs.readdirSync(h.dir).sort(), [RECOVERY_FILENAME]);
});

// --- peek(): the file is untrusted input on the next start ------------------

function seed(h, content) {
  fs.writeFileSync(h.file, typeof content === 'string' ? content : JSON.stringify(content));
}

test('peek() returns null for a missing, empty or corrupt file', () => {
  const h = harness();
  assert.equal(h.rec.peek(), null, 'missing');
  seed(h, '');
  assert.equal(h.rec.peek(), null, 'empty');
  seed(h, '{"version":1,"resumeLine":12');
  assert.equal(h.rec.peek(), null, 'truncated json');
  seed(h, 'not json at all');
  assert.equal(h.rec.peek(), null, 'garbage');
});

test('peek() rejects the wrong schema version and any invalid resume line', () => {
  const h = harness();
  const good = { version: 1, state: 'interrupted', fileName: 'a', resumeLine: 10, savedAt: 5 };
  seed(h, good);
  assert.equal(h.rec.peek().resumeLine, 10);

  seed(h, { ...good, version: 2 });
  assert.equal(h.rec.peek(), null, 'unknown version');
  for (const bad of [0, -4, 1.5, '12', null, NaN, Infinity]) {
    seed(h, { ...good, resumeLine: bad });
    assert.equal(h.rec.peek(), null, 'resumeLine ' + String(bad));
  }
});

test('peek() sanitises fields and never passes unknown properties through', () => {
  const h = harness();
  seed(h, {
    version: 1,
    state: 'exploded',
    fileName: 'evil\u0000name' + 'x'.repeat(500),
    resumeLine: 3,
    totalLines: 'lots',
    plannerBlocks: -9,
    startedAt: 'yesterday',
    savedAt: 12,
    evil: '<script>alert(1)</script>',
    __proto__: { polluted: true },
  });
  const info = h.rec.peek();
  assert.equal(info.state, 'interrupted', 'unknown state falls back');
  assert.ok(info.fileName.length <= 200);
  assert.ok(!info.fileName.includes('\u0000'));
  assert.equal(info.totalLines, 0);
  assert.equal(info.plannerBlocks, 0);
  assert.equal(info.startedAt, 0);
  assert.equal(info.savedAt, 12);
  assert.deepEqual(Object.keys(info).sort(), [
    'fileName', 'plannerBlocks', 'resumeLine', 'savedAt', 'startedAt', 'state', 'totalLines',
  ]);
  assert.equal(({}).polluted, undefined);
});

// --- failure isolation -------------------------------------------------------

test('an unwritable location never throws into the caller, and is reported only once', () => {
  const h = harness({ getDir: () => path.join(os.tmpdir(), 'uc-does-not-exist-' + Date.now(), 'nested') , writeIntervalMs: 0 });
  assert.doesNotThrow(() => {
    h.rec.begin({ fileName: 'p', lineCount: 7, marks: MARKS });
    for (let q = 1; q <= 5; q++) {
      h.state.q = q;
      h.state.time += 5000;
      h.rec.tick();
    }
    h.rec.finish('stopped');
  });
  const errors = h.state.logs.filter(([level]) => level === 'error');
  assert.equal(errors.length, 1, 'one log line, not one per attempt');
  assert.equal(h.rec.peek(), null);
});

test('a throwing getDir() is contained', () => {
  const h = harness({ getDir: () => { throw new Error('userData unavailable'); } });
  assert.doesNotThrow(() => h.rec.begin({ fileName: 'p', lineCount: 7, marks: MARKS }));
  assert.equal(h.rec.peek(), null);
  assert.doesNotThrow(() => h.rec.clear('x'));
});

test('recovery survives a "process restart": a fresh instance sees what the old one wrote', () => {
  const h = harness({ writeIntervalMs: 0 });
  h.rec.begin({ fileName: 'part.nc', lineCount: 7, marks: MARKS });
  h.state.q = 5;
  h.state.time += 5000;
  h.rec.tick();
  // ...USB yanked, app restarted: brand-new instance over the same directory.
  const after = createJobRecovery({ getDir: () => h.dir, autoTimer: false });
  const info = after.peek();
  assert.equal(info.state, 'running', 'a "running" file at startup means the previous run died');
  assert.equal(info.resumeLine, 6);
  assert.equal(info.fileName, 'part.nc');
  assert.equal(after.isTracking(), false);
});
