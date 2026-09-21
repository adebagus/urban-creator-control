'use strict';

// P9: server-side job recovery persistence.
//
// "Recover Job" used to be fed by localStorage in the renderer
// (localStorage.gcodeLineNumber, written on every queueCount event). That had
// three real problems this module exists to fix:
//   1. It lived in the browser profile, so it depended on the renderer being
//      alive to record anything and was never cleared when a job finished.
//   2. The number was a QUEUE INDEX, not a line number. runJob() drops blank
//      lines and ";" comments and addQToEnd() injects synthetic "$G" entries
//      after every modal command / tool word, so the queue index drifts away
//      from the editor line - "Start from line N" pointed at the wrong line.
//   3. It recorded lines SENT to the controller, not lines it had ACKNOWLEDGED.
//
// This module is deliberately dependency-free (no Electron, no globals from
// index.js) so it can be unit-tested with plain node:test; index.js hands it
// the few live values it needs through callbacks.

const fs = require('fs');
const path = require('path');

const RECOVERY_FILENAME = 'job-recovery.json';
const SCHEMA_VERSION = 1;
const MAX_FILENAME_LEN = 200;
const VALID_STATES = ['running', 'completing', 'interrupted', 'stopped'];

// File names reach this module from the client (a form field / socket
// payload) and are later shown in a dialog, so they are untrusted text.
// Normalise here; the renderer additionally escapes when it displays them.
function sanitizeFileName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_FILENAME_LEN);
}

function isNonNegInt(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

// marks: [{ q, line }] in ascending order - `q` is the queue index where a
// source line's first queue entry starts, `line` its 1-based source line.
// Returns the source line that owns queue index `q`. Synthetic "$G" entries
// sit between one mark and the next, so they map to the line that caused them.
function queueIndexToSourceLine(marks, q) {
  if (!Array.isArray(marks) || marks.length === 0) return 1;
  if (!(q > marks[0].q)) return marks[0].line;
  let lo = 0;
  let hi = marks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (marks[mid].q <= q) lo = mid;
    else hi = mid - 1;
  }
  return marks[lo].line;
}

// opts:
//   getDir()            -> directory to keep the file in (userData)
//   getFirstUnackedQ()  -> queue index of the oldest line the controller has
//                          NOT yet acknowledged; a negative number means "the
//                          queue is gone" (dumped by an alarm reset etc.)
//   getPlannerBlocks()  -> controller planner depth, purely informational
//   log(level, msg), now(), writeIntervalMs, autoTimer (tests turn it off)
function createJobRecovery(opts) {
  opts = opts || {};
  const getDir = opts.getDir;
  const getFirstUnackedQ = opts.getFirstUnackedQ || function() { return -1; };
  const getPlannerBlocks = opts.getPlannerBlocks || function() { return 0; };
  const log = opts.log || function() {};
  const now = opts.now || Date.now;
  const writeIntervalMs = opts.writeIntervalMs != null ? opts.writeIntervalMs : 2000;
  const autoTimer = opts.autoTimer !== false;

  let active = null; // the job currently being tracked, or null
  let timer = null;
  let warnedWriteFailure = false;

  function filePath() {
    return path.join(getDir(), RECOVERY_FILENAME);
  }

  // Write to a temp file and rename over the real one so a crash or power cut
  // mid-write can never leave a half-written recovery file. Writes are tiny
  // (<1 KB) and rate-limited, so the sync calls are cheap - and sync is what
  // lets a final snapshot land before the process exits.
  function writeRecord(record) {
    try {
      const target = filePath();
      const tmp = target + '.tmp';
      const body = JSON.stringify(record);
      fs.writeFileSync(tmp, body);
      try {
        fs.renameSync(tmp, target);
      } catch (renameErr) {
        // Windows can refuse to replace a file something (AV, indexer) has
        // open for a moment - fall back to writing the target directly.
        fs.writeFileSync(target, body);
        try { fs.unlinkSync(tmp); } catch (e) {}
      }
      warnedWriteFailure = false;
      return true;
    } catch (e) {
      // Recovery is a safety net, never a reason to disturb a running job.
      if (!warnedWriteFailure) {
        warnedWriteFailure = true;
        log('error', 'Job recovery: could not write recovery file: ' + e.message);
      }
      return false;
    }
  }

  function buildRecord(a) {
    return {
      version: SCHEMA_VERSION,
      state: a.state,
      fileName: a.fileName,
      resumeLine: a.resumeLine,
      totalLines: a.totalLines,
      plannerBlocks: a.plannerBlocks,
      startedAt: a.startedAt,
      savedAt: now()
    };
  }

  function persist() {
    if (!active) return;
    if (writeRecord(buildRecord(active))) active.dirty = false;
    active.lastWriteAt = now();
  }

  function computeResumeLine(a, q) {
    return queueIndexToSourceLine(a.marks, q) + a.lineOffset;
  }

  // Refresh the in-memory resume line from the live queue. Skipped once every
  // line has been sent: from then on index.js has already dumped the queue
  // and reset its pointer, so re-reading it would wrongly yield "line 1".
  function refresh() {
    if (!active || active.fullySent) return;
    const q = getFirstUnackedQ();
    if (typeof q !== 'number' || isNaN(q) || q < 0) return;
    const line = computeResumeLine(active, q);
    if (line !== active.resumeLine) {
      active.resumeLine = line;
      active.dirty = true;
    }
  }

  function startTimer() {
    if (!autoTimer || timer) return;
    timer = setInterval(tick, 1000);
    if (timer.unref) timer.unref(); // never keep the process alive
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Called about once a second. Writes only when the line actually moved AND
  // at least writeIntervalMs passed since the last write - disk I/O is bounded
  // by time rather than by line count, so a fast short-segment job doesn't
  // multiply writes. A stale value errs on the SAFE side (resume slightly
  // earlier than the true stopping point, never later).
  function tick() {
    if (!active) return;
    if (!active.fullySent) {
      const q = getFirstUnackedQ();
      if (typeof q === 'number' && q < 0) {
        // The queue disappeared under us (alarm reset dumped it): the job is
        // dead. Keep the last good line we already hold; do not recompute.
        finish('interrupted');
        return;
      }
      refresh();
    }
    if (active && active.dirty && now() - active.lastWriteAt >= writeIntervalMs) persist();
  }

  // Start tracking a job. info: { fileName, lineOffset, lineCount, marks }
  function begin(info) {
    stopTimer();
    active = null;
    if (!info || !Array.isArray(info.marks) || info.marks.length === 0) return false;
    const lineOffset = isNonNegInt(info.lineOffset) ? info.lineOffset : 0;
    const lineCount = isNonNegInt(info.lineCount) ? info.lineCount : 0;
    active = {
      fileName: sanitizeFileName(info.fileName),
      marks: info.marks,
      lineOffset: lineOffset,
      totalLines: lineOffset + lineCount,
      plannerBlocks: isNonNegInt(getPlannerBlocks()) ? getPlannerBlocks() : 0,
      startedAt: now(),
      state: 'running',
      fullySent: false,
      resumeLine: 0,
      dirty: false,
      lastWriteAt: 0
    };
    active.resumeLine = computeResumeLine(active, info.marks[0].q);
    persist();
    startTimer();
    return true;
  }

  // The job ended abnormally or was stopped by the user: take a final
  // snapshot of where the controller had got to, keep the file so it can be
  // offered for recovery, and stop tracking. Must be called BEFORE the queue
  // is dumped - it reads the live queue state.
  function finish(state) {
    if (!active) return false;
    if (VALID_STATES.indexOf(state) === -1) state = 'interrupted';
    refresh();
    active.state = state;
    persist();
    stopTimer();
    active = null;
    return true;
  }

  // Every line has been handed to the controller. It is NOT finished yet -
  // the last few lines are still queued in the controller's buffers - so keep
  // the file (state "completing") until the controller reports Idle.
  function markFullySent() {
    if (!active || active.fullySent) return;
    refresh();
    active.fullySent = true;
    active.state = 'completing';
    persist();
  }

  // Called for every "Idle" status report. `allAcked` = the controller has
  // acknowledged every line we sent. Only then is Idle proof the job really
  // ended (status reports and acks share one serial stream, so an Idle report
  // that predates the final ack cannot arrive after it).
  function onIdle(allAcked) {
    if (active && active.fullySent && allAcked) clear('completed');
  }

  // Forget the recovery data (job completed normally, or the user discarded
  // the offer).
  function clear(reason) {
    stopTimer();
    active = null;
    try {
      fs.unlinkSync(filePath());
      if (reason) log('info', 'Job recovery data cleared (' + reason + ')');
    } catch (e) {
      // no file to remove is the normal case
    }
  }

  // Read and validate the saved recovery data. Returns a plain sanitised
  // object (only known fields, all type-checked) or null.
  function peek() {
    let raw;
    try {
      raw = fs.readFileSync(filePath(), 'utf8');
    } catch (e) {
      return null;
    }
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch (e) {
      log('warn', 'Job recovery: ignoring unreadable recovery file');
      return null;
    }
    if (!rec || typeof rec !== 'object' || rec.version !== SCHEMA_VERSION) return null;
    if (!Number.isInteger(rec.resumeLine) || rec.resumeLine < 1) return null;
    return {
      state: VALID_STATES.indexOf(rec.state) !== -1 ? rec.state : 'interrupted',
      fileName: sanitizeFileName(rec.fileName),
      resumeLine: rec.resumeLine,
      totalLines: isNonNegInt(rec.totalLines) ? rec.totalLines : 0,
      plannerBlocks: isNonNegInt(rec.plannerBlocks) ? rec.plannerBlocks : 0,
      startedAt: typeof rec.startedAt === 'number' && isFinite(rec.startedAt) ? rec.startedAt : 0,
      savedAt: typeof rec.savedAt === 'number' && isFinite(rec.savedAt) ? rec.savedAt : 0
    };
  }

  function isTracking() {
    return active !== null;
  }

  return {
    begin: begin,
    tick: tick,
    finish: finish,
    markFullySent: markFullySent,
    onIdle: onIdle,
    clear: clear,
    peek: peek,
    isTracking: isTracking
  };
}

module.exports = {
  createJobRecovery: createJobRecovery,
  queueIndexToSourceLine: queueIndexToSourceLine,
  sanitizeFileName: sanitizeFileName,
  RECOVERY_FILENAME: RECOVERY_FILENAME
};
