// Tests for the renderer's "jobComplete" handler (app/js/websocket.js).
//
// The server emits jobComplete from send1Q's "queue is empty" branch, which
// also runs when a job was stopped/interrupted or when a lone console command
// finishes (failed:true). Before the fix the handler printed
// "[ JOB COMPLETE ] Job completed in 00h00m" and wrote a job-history entry for
// any event that carried a jobStartTime - including that stale, failed one.
// Now only completed && !failed may do either.
//
// Job HISTORY (pastJobs) is fed by two separate channels, on purpose:
//   - "jobComplete": a job that ran to the end. Only completed && !failed may
//     print the log or be stored. A failed jobComplete carrying a start time is
//     the exact shape of the stale-reconnect bug, so this channel NEVER writes
//     an incomplete record.
//   - "jobStopped": the server's explicit notice that a REAL job was cut short
//     (Stop, USB pulled, alarm reset). Recorded as completed:false with the real
//     start/stop times, and never printed as "JOB COMPLETE".
// Keeping the two apart is what makes "a stale event enters the history"
// structurally impossible while "a stopped job is recorded" still works.
//
// The handlers live inside initSocket()'s closure, so the real source text is
// extracted and run in a vm sandbox with recording stubs (same approach as
// test/reconnect-stale-state.test.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'websocket.js'), 'utf8').replace(/\r\n/g, '\n');

function extractHandler(event) {
  event = event || 'jobComplete';
  const marker = 'socket.on("' + event + '", function(data) {';
  const start = SRC.indexOf(marker);
  assert.notEqual(start, -1, 'cannot find the ' + event + ' handler in websocket.js');
  const fnStart = start + ('socket.on("' + event + '", ').length;
  const end = SRC.indexOf('\n  });', fnStart);
  assert.notEqual(end, -1, 'cannot find the end of the ' + event + ' handler');
  return '(' + SRC.slice(fnStart, end + '\n  }'.length) + ')';
}

function extractFunction(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot find function ' + name);
  let end = SRC.indexOf('\n}\n', start);
  // msToTime is the last function in the file, which ends without a newline.
  if (end === -1 && SRC.endsWith('\n}')) end = SRC.length - 2;
  assert.notEqual(end, -1, 'cannot find the end of function ' + name);
  return SRC.slice(start, end + 2);
}

// opts.noStoreJob: emulate the phone page, which does not load jobstats.js.
function makeHandler(opts) {
  opts = opts || {};
  const calls = { storeJob: [], log: [], dialogs: [], html: [] };
  const ctx = {
    // recording stubs for everything the handler touches
    printLogModern(icon, source, string, cls) { calls.log.push({ source, string }); },
    Metro: { dialog: { open(sel) { calls.dialogs.push(sel); } } },
    $(sel) {
      const chain = { html(v) { calls.html.push([sel, v]); return chain; }, focus() { return chain; } };
      return chain;
    },
    setTimeout() { return 1; },
    timeConvert: (m) => m + 'min',
    loadedFileName: 'part.nc',
    object: undefined,
    lastJobStartTime: 12345,
    console: { log() {} },
  };
  if (!opts.noStoreJob) ctx.storeJob = (job) => { calls.storeJob.push(job); };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('msToTime'), ctx); // the real formatter
  const handler = vm.runInContext(extractHandler('jobComplete'), ctx);
  const stopped = vm.runInContext(extractHandler('jobStopped'), ctx);
  return { handler, stopped, calls, ctx };
}

const T0 = 1_700_000_000_000;
const jobLogs = (calls) => calls.log.filter((l) => l.source === 'JOB COMPLETE');

test('a genuine completion prints "JOB COMPLETE" once and is stored in the job history', () => {
  const { handler, calls } = makeHandler();
  handler({ completed: true, failed: false, jobCompletedMsg: '', jobStartTime: T0, jobEndTime: T0 + 90_000 });

  assert.equal(jobLogs(calls).length, 1);
  assert.match(jobLogs(calls)[0].string, /^Job completed in 00h01m$/);
  assert.equal(calls.storeJob.length, 1);
  assert.equal(calls.storeJob[0].completed, true);
  assert.equal(calls.storeJob[0].filename, 'part.nc');
  assert.equal(calls.storeJob[0].startdate, T0);
});

test('THE REPORTED BUG: the stale event after a USB-pull reconnect (failed:true, old jobStartTime) logs nothing and stores nothing', () => {
  const { handler, calls } = makeHandler();
  // 56 s after the job started - exactly the shape seen on real hardware.
  handler({ completed: true, failed: true, jobCompletedMsg: '', jobStartTime: T0, jobEndTime: T0 + 56_300 });

  assert.equal(jobLogs(calls).length, 0, 'must not print a fake "Job completed in 00h00m"');
  assert.equal(calls.storeJob.length, 0, 'must not write a junk job-history entry');
});

test('empty-queue noise (no job start time at all) logs nothing and stores nothing', () => {
  const { handler, calls } = makeHandler();
  handler({ completed: true, failed: true, jobCompletedMsg: '', jobStartTime: false, jobEndTime: T0 });
  handler({ completed: true, failed: false, jobCompletedMsg: '', jobStartTime: false, jobEndTime: T0 });

  assert.equal(jobLogs(calls).length, 0);
  assert.equal(calls.storeJob.length, 0);
});

test('a genuine completion WITH a message shows the dialog and logs once', () => {
  const { handler, calls } = makeHandler();
  handler({ completed: true, failed: false, jobCompletedMsg: 'Probing done', jobStartTime: T0, jobEndTime: T0 + 5_000 });

  assert.deepEqual(calls.dialogs, ['#completeMsgModal']);
  assert.equal(jobLogs(calls).length, 1);
  assert.match(jobLogs(calls)[0].string, /Probing done/);
  assert.equal(calls.storeJob.length, 1);
});

test('a FAILED event that carries a message does not print "JOB COMPLETE" or enter the history', () => {
  const { handler, calls } = makeHandler();
  handler({ completed: true, failed: true, jobCompletedMsg: 'Probing done', jobStartTime: T0, jobEndTime: T0 + 5_000 });

  assert.equal(jobLogs(calls).length, 0, 'the message branch had its own copy of the log line');
  assert.equal(calls.storeJob.length, 0);
});

test('completed:false never counts as a completion, whatever else the event says', () => {
  const { handler, calls } = makeHandler();
  handler({ completed: false, failed: false, jobCompletedMsg: '', jobStartTime: T0, jobEndTime: T0 + 5_000 });
  handler({ completed: false, failed: false, jobCompletedMsg: 'x', jobStartTime: T0, jobEndTime: T0 + 5_000 });

  assert.equal(jobLogs(calls).length, 0);
  assert.equal(calls.storeJob.length, 0);
});

test('every branch uses the SAME completion rule (one shared flag, so they cannot drift apart)', () => {
  const handler = extractHandler();
  assert.match(handler, /var isRealCompletion = !!\(data\.completed && !data\.failed\);/);
  // every place that stores history or prints the log is gated on it
  assert.match(handler, /if \(isRealCompletion && data\.jobStartTime && data\.jobEndTime\) \{\s*console\.log\("jobComplete"/);
  assert.match(handler, /if \(isRealCompletion\) \{\s*var icon = ''\s*var source = "JOB COMPLETE"/);
  assert.match(handler, /else if \(isRealCompletion && data\.jobStartTime && data\.jobEndTime\) \{/);
  const printSites = handler.match(/printLogModern\(/g) || [];
  assert.equal(printSites.length, 2, 'two JOB COMPLETE log sites exist today; if you add a third, gate it too');
});

// ---------------------------------------------------------------------------
// jobStopped: a real job that was cut short is recorded as INCOMPLETE.
// ---------------------------------------------------------------------------

test('a stopped job is recorded as INCOMPLETE with its real start and stop times - and never printed as "JOB COMPLETE"', () => {
  const { stopped, calls } = makeHandler();
  stopped({ completed: false, reason: 'stopped', jobStartTime: T0, jobEndTime: T0 + 45_000 });

  assert.equal(calls.storeJob.length, 1);
  const rec = calls.storeJob[0];
  assert.equal(rec.completed, false, 'the history must show it did NOT complete');
  assert.equal(rec.filename, 'part.nc');
  assert.equal(rec.startdate, T0);
  assert.equal(rec.enddate, T0 + 45_000);
  assert.equal(rec.streamruntime, 45_000);
  assert.equal(jobLogs(calls).length, 0, 'no fake "Job completed" message for a job that did not complete');
  assert.deepEqual(calls.dialogs, [], 'no completion dialog either');
});

test('a stopped job is recorded with the SAME record shape as a completed one (the job-history view renders both)', () => {
  const a = makeHandler();
  a.handler({ completed: true, failed: false, jobCompletedMsg: '', jobStartTime: T0, jobEndTime: T0 + 90_000 });
  const b = makeHandler();
  b.stopped({ completed: false, reason: 'interrupted', jobStartTime: T0, jobEndTime: T0 + 45_000 });

  assert.deepEqual(Object.keys(b.calls.storeJob[0]).sort(), Object.keys(a.calls.storeJob[0]).sort());
});

test('the record says completed:false whatever the payload claims (a stopped job can never be filed as complete)', () => {
  const { stopped, calls } = makeHandler();
  stopped({ completed: true, failed: false, reason: 'stopped', jobStartTime: T0, jobEndTime: T0 + 1_000 });
  assert.equal(calls.storeJob[0].completed, false);
});

test('the estimate comes from the loaded toolpath, like a normal completion', () => {
  const { stopped, calls, ctx } = makeHandler();
  ctx.object = { userData: { totalTime: 42 } };
  stopped({ completed: false, jobStartTime: T0, jobEndTime: T0 + 1_000 });
  assert.equal(calls.storeJob[0].estruntime, 42);

  const none = makeHandler();
  none.stopped({ completed: false, jobStartTime: T0, jobEndTime: T0 + 1_000 });
  assert.equal(none.calls.storeJob[0].estruntime, 0, 'no toolpath loaded -> 0, not a crash');
});

test('a jobStopped that is not a real, timed run is ignored (noise never becomes history)', () => {
  const { stopped, calls } = makeHandler();
  for (const bad of [
    undefined, null, {}, 'stopped', 42,
    { jobStartTime: false, jobEndTime: T0 },
    { jobStartTime: 0, jobEndTime: T0 },
    { jobStartTime: T0 },
    { jobEndTime: T0 },
    { jobStartTime: T0, jobEndTime: T0 - 1 },   // stopped before it started
    { jobStartTime: 'abc', jobEndTime: T0 },
  ]) {
    assert.doesNotThrow(() => stopped(bad), 'must not throw on ' + JSON.stringify(bad));
  }
  assert.equal(calls.storeJob.length, 0);
});

test('the phone page (no job-history code loaded) ignores jobStopped without throwing', () => {
  const { stopped, calls } = makeHandler({ noStoreJob: true });
  assert.doesNotThrow(() => stopped({ completed: false, jobStartTime: T0, jobEndTime: T0 + 1_000 }));
  assert.equal(calls.storeJob.length, 0);
});

// --- the separation that keeps the stale hole closed -------------------------

test('NO failed jobComplete - whatever it carries - ever reaches the job history', () => {
  // Every shape a failed jobComplete can take, including the exact one the
  // stale-reconnect bug produced (failed + a start time, with and without a
  // message). Not one may be stored: history for stopped jobs arrives ONLY via
  // jobStopped.
  const { handler, calls } = makeHandler();
  for (const withStart of [true, false]) {
    for (const msg of ['', 'Probing done']) {
      for (const completed of [true, false]) {
        handler({ completed, failed: true, jobCompletedMsg: msg, jobStartTime: withStart ? T0 : false, jobEndTime: T0 + 56_300 });
      }
    }
  }
  assert.equal(calls.storeJob.length, 0);
  assert.equal(jobLogs(calls).length, 0);
});

test('structural: the jobComplete handler has exactly one storeJob call, inside the isRealCompletion gate; jobStopped never logs "JOB COMPLETE"', () => {
  const complete = extractHandler('jobComplete');
  assert.equal((complete.match(/storeJob\(/g) || []).length, 1, 'jobComplete may store history in exactly one place');
  const gateStart = complete.indexOf('if (isRealCompletion && data.jobStartTime && data.jobEndTime) {');
  const store = complete.indexOf('storeJob(');
  const gateEnd = complete.indexOf('\n    // With jobCompletedMsg Message');
  assert.ok(gateStart !== -1 && gateStart < store && store < gateEnd, 'that one call must sit inside the isRealCompletion block');

  const stoppedSrc = extractHandler('jobStopped');
  assert.match(stoppedSrc, /"completed": false,/, 'the record is hard-coded incomplete');
  assert.ok(!/printLogModern\(|Metro\.dialog/.test(stoppedSrc), 'a stopped job shows no completion message or dialog');
  assert.equal((stoppedSrc.match(/storeJob\(/g) || []).length, 1);
});
