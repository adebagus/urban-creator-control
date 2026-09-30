// The GCODE Editor's active-line highlight. It used to be editor.gotoLine(queueTotal - queueLeft): an index into the
// queue the server built from the PAYLOAD - not a line of the file. Blank/comment lines are dropped, "$G" entries are
// added, and "Start from Line" sends a short slice, so the highlight sat at line ~130 for a job at line ~1500.
//
// Now the server adds a third element to "queueCount": the line of the ORIGINAL file that was just sent, from the same
// mapping as the recovery record (marks + lineOffset); the client uses it and falls back to the old formula when it is
// missing (jobs jobRecovery does not track).
//
// These tests run the REAL runJob / addQToEnd / send1Q / machineSend from index.js (in a vm, against a fake port) and the
// REAL queueCount handler from websocket.js. Every file line is "G1 X<its own line number>", so what was sent tells the
// true file line, and the emitted value can be compared with it exactly.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createJobRecovery } = require('../jobRecovery');
const { makeEnv } = require('./helpers/recovery-env');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const INDEX_SRC = read('index.js');
const WS_SRC = read('app/js/websocket.js');

function grabFunction(name) {
  const start = INDEX_SRC.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot extract function ' + name);
  const end = INDEX_SRC.indexOf('\n}\n', start);
  return INDEX_SRC.slice(start, end + 2);
}
const MODAL_VARS = INDEX_SRC.match(/var modalCommands = \[[^\]]*\]\n/)[0] + INDEX_SRC.match(/var modalCommandsRegExp = [^\n]*\n/)[0];

function harness() {
  const sent = [];
  const counts = []; // [the queue entry just sent (machineSend emits BEFORE it writes), queueCount data]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-hl-'));
  const ctx = {
    gcodeQueue: [], queuePointer: 0, sentBuffer: [], queueCounter: null, toolChangeQIndexes: new Map(),
    status: {
      comms: { connectionStatus: 2, blocked: false, paused: false, runStatus: 'Idle', queue: 0, alarm: '', interfaces: { type: 'usb' } },
      machine: { modals: {}, firmware: { type: 'grbl', platform: 'grbl', rxBufferSize: 254, blockBufferSize: '35', version: '', date: '', buffer: '' }, tool: { nexttool: {} } },
    },
    fluidncConfig: '', jobStartTime: false, uploadedgcode: '', jobCompletedMsg: '', laserTestOn: false,
    jogWindow: null, debug_log() {}, serialLog() {}, setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; },
    port: { isOpen: true, write(s) { sent.push(s.replace(/\n$/, '')); } },
    io: { sockets: { emit(ev, d) { if (ev === 'queueCount') counts.push([ctx.gcodeQueue[ctx.queuePointer - 1], d.slice()]); } } },
  };
  ctx.jobRecovery = createJobRecovery({
    getDir: () => dir, autoTimer: false,
    getFirstUnackedQ: () => (ctx.gcodeQueue.length === 0 ? -1 : Math.max(0, ctx.queuePointer - ctx.sentBuffer.length)),
    getPlannerBlocks: () => 35,
  });
  vm.createContext(ctx);
  vm.runInContext(MODAL_VARS + ['isToolChangeLine', 'toolChangeToolNumber', 'addQToEnd', 'send1Q', 'BufferSpace', 'machineSend', 'runJob'].map(grabFunction).join('\n'), ctx);
  return {
    ctx, sent, counts,
    // run a whole job to the end, answering "ok" for every line
    run(object) {
      ctx.runJob(object);
      for (let guard = 0; guard < 100000 && ctx.sentBuffer.length; guard++) {
        ctx.sentBuffer.shift(); ctx.status.comms.blocked = false; ctx.send1Q();
      }
    },
  };
}

// A file where line n (1-based) is "G1 X<n>" - except a mix of blank lines, comments and modal / tool lines that make the
// queue drift from the file ("$G" is added after G54 / M3 / G21... and after any T word).
function fileLines(total) {
  const lines = [];
  for (let n = 1; n <= total; n++) {
    if (n === 1) lines.push('G21 G90');
    else if (n === 2) lines.push('G0 Z5');
    else if (n === 3) lines.push('S16000M3');
    else if (n % 7 === 0) lines.push('');
    else if (n % 5 === 0) lines.push('; comment ' + n);
    else if (n % 11 === 0) lines.push('M8');
    else if (n % 13 === 0) lines.push('T2 M6');
    else lines.push('G1 X' + n + ' F800');
  }
  return lines;
}
const lineOf = (text) => { const m = /^G1 X(\d+) F800$/.exec(text || ''); return m ? parseInt(m[1], 10) : null; };

// -------------------------------------------------------------------- the server

test('full job from line 1: the emitted line is exactly the file line that was just sent, for every line', () => {
  const h = harness();
  const lines = fileLines(400);
  h.run({ isJob: true, data: lines.join('\n') });
  let checked = 0, drift = 0;
  for (const [text, d] of h.counts) {
    assert.equal(d.length, 3, 'a tracked job always carries the source line: ' + JSON.stringify(d));
    const n = lineOf(text);
    if (n !== null) {
      assert.equal(d[2], n, 'sent "' + text + '" - the highlight must be on its own line');
      checked++;
      if (d[1] - d[0] !== n) drift++;
    }
  }
  assert.ok(checked > 200, 'a real job was checked (' + checked + ' lines)');
  assert.ok(drift > 100, 'the old formula (queue index) really was off for most lines (' + drift + '): the test has teeth');
});

test('full job: the "$G" entries and blank/comment lines never move the highlight off the file line they belong to', () => {
  const h = harness();
  h.run({ isJob: true, data: fileLines(60).join('\n') });
  const gs = h.counts.filter(([t]) => t === '$G');
  assert.ok(gs.length >= 5, '$G entries were really queued (' + gs.length + ')');
  h.counts.forEach(([text, d], i) => {
    if (text === '$G') {
      // it belongs to the line queued right before it
      assert.equal(d[2], h.counts[i - 1][1][2], '$G stays on the line of the command it follows');
    }
  });
  // strictly non-decreasing, and never a line that is not in the file
  let prev = 0;
  for (const [, d] of h.counts) { assert.ok(d[2] >= prev && d[2] <= 60); prev = d[2]; }
});

test('Start from Line 1500 of a 1654-line file: the highlight is around 1500 - NOT the small payload index', () => {
  const lines = fileLines(1654);
  const text = lines.join('\n');
  const env = makeEnv({ text });
  const c = env.ctx;
  const facts = c.recoveryFileFacts(lines);
  const p = c.recoveryRunPayload(text, 1500, 10, facts, 'G21 G90 G0 Z15');
  assert.ok(p.text.split('\n').length < 200, 'the payload is a short slice');
  const h = harness();
  h.run({ isJob: true, data: p.text, lineOffset: p.lineOffset });
  let sliceChecked = 0, oldMax = 0;
  for (const [t, d] of h.counts) {
    assert.equal(d.length, 3);
    oldMax = Math.max(oldMax, d[1] - d[0]);
    assert.ok(d[2] >= 1493 && d[2] <= 1654, 'always in the requested region, never a payload index: ' + d[2]);
    const n = lineOf(t);
    if (n !== null) { assert.equal(d[2], n, 'slice line "' + t + '"'); sliceChecked++; }
  }
  assert.ok(sliceChecked > 60, 'the slice lines were checked (' + sliceChecked + ')');
  assert.ok(oldMax < 200, 'the old formula never got beyond ' + oldMax + ' - the reported bug (126-146)');
  // the opening lines (raise, units, entry) show a line just BEFORE the requested one, never after it
  const first = h.counts[0][1][2];
  assert.ok(first <= 1500 && first >= 1490, 'starts just before line 1500: ' + first);
  const firstSlice = h.counts.find(([t]) => lineOf(t) !== null);
  assert.equal(firstSlice[1][2], lineOf(firstSlice[0]));
  assert.ok(lineOf(firstSlice[0]) >= 1500 && lineOf(firstSlice[0]) <= 1503, 'the first cut line is at the requested line');
});

test('Start from Line at a small line and at the very last line also map exactly', () => {
  const lines = fileLines(300);
  const text = lines.join('\n');
  const env = makeEnv({ text });
  const facts = env.ctx.recoveryFileFacts(lines);
  for (const start of [20, 150, 300]) {
    const p = env.ctx.recoveryRunPayload(text, start, 10, facts, 'G21 G90 G0 Z15');
    const h = harness();
    h.run({ isJob: true, data: p.text, lineOffset: p.lineOffset });
    for (const [t, d] of h.counts) {
      const n = lineOf(t);
      if (n !== null) assert.equal(d[2], n, 'start ' + start + ': "' + t + '"');
    }
    assert.ok(h.counts.length > 0);
  }
});

test('the emitted line agrees with what the recovery record would say at the same moment', () => {
  const lines = fileLines(500);
  const text = lines.join('\n');
  const env = makeEnv({ text });
  const p = env.ctx.recoveryRunPayload(text, 400, 10, env.ctx.recoveryFileFacts(lines), 'G21 G90 G0 Z15');
  const h = harness();
  h.ctx.runJob({ isJob: true, data: p.text, lineOffset: p.lineOffset });
  for (let i = 0; i < 40; i++) { h.ctx.sentBuffer.shift(); h.ctx.status.comms.blocked = false; h.ctx.send1Q(); }
  const last = h.counts[h.counts.length - 1][1][2];
  h.ctx.jobRecovery.finish('interrupted'); // what USB removal / Stop does
  const rec = h.ctx.jobRecovery.peek();
  assert.ok(rec.resumeLine >= 1, 'a record was saved');
  assert.ok(Math.abs(rec.resumeLine - last) <= 2, 'highlight ' + last + ' and recorded resume ' + rec.resumeLine + ' are the same region');
  assert.ok(rec.resumeLine >= 395 && rec.resumeLine <= 500, 'the recovery record itself is in original file lines: ' + rec.resumeLine);
});

test('an untracked job (isJob:false: probing, console commands) sends only two elements, so the client falls back', () => {
  const h = harness();
  h.run({ isJob: false, data: 'G0 X1\nG0 X2\nG0 X3' });
  assert.ok(h.counts.length >= 3);
  for (const [, d] of h.counts) assert.equal(d.length, 2, JSON.stringify(d));
});

test('jobRecovery.sourceLineAt: null without a tracked job or for a bad index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-hl2-'));
  const jr = createJobRecovery({ getDir: () => dir, autoTimer: false, getFirstUnackedQ: () => 0, getPlannerBlocks: () => 0 });
  assert.equal(jr.sourceLineAt(0), null, 'nothing tracked');
  jr.begin({ fileName: 'a.nc', lineOffset: 100, lineCount: 3, marks: [{ q: 0, line: 1 }, { q: 1, line: 2 }, { q: 3, line: 3 }] });
  assert.equal(jr.sourceLineAt(0), 101);
  assert.equal(jr.sourceLineAt(2), 102, 'an injected entry stays on its line');
  assert.equal(jr.sourceLineAt(3), 103);
  for (const bad of [-1, 1.5, NaN, '2', undefined, null]) assert.equal(jr.sourceLineAt(bad), null, String(bad));
  jr.finish('interrupted');
  assert.equal(jr.sourceLineAt(0), null, 'after the job ended');
});

test('index.js: the third element is added only when a source line exists, from queue index queuePointer-1', () => {
  const ms = grabFunction('machineSend');
  assert.match(ms, /jobRecovery\.sourceLineAt\(queuePointer - 1\)/);
  assert.match(ms, /if \(sourceLine !== null\) data\.push\(sourceLine\);/);
  assert.ok(ms.indexOf('data.push(queueTotal)') < ms.indexOf('data.push(sourceLine)'), 'after the two existing elements');
});

// -------------------------------------------------------------------- the client

function clientHandler() {
  const marker = 'socket.on("queueCount", ';
  const start = WS_SRC.indexOf(marker);
  assert.notEqual(start, -1, 'cannot find the queueCount handler');
  const end = WS_SRC.indexOf('\n  })\n', start);
  const fn = WS_SRC.slice(start + marker.length, end + '\n  }'.length);
  const goto = [];
  const ctx = {
    laststatus: { comms: { connectionStatus: 3 } },
    editor: { gotoLine: (n) => goto.push(n) },
    lastJobStartTime: 0,
    $: () => ({ data: () => null, html() {}, empty() {} }),
    typeof: undefined,
  };
  vm.createContext(ctx);
  return { handler: vm.runInContext('(' + fn + ')', ctx), goto, ctx };
}

test('client: with a third element the editor goes to THAT line', () => {
  const { handler, goto } = clientHandler();
  handler([40, 155, 1523]);
  assert.deepEqual(goto, [1523]);
});

test('client: without a third element it falls back to the old formula (total - left)', () => {
  const { handler, goto } = clientHandler();
  handler([40, 155]);
  assert.deepEqual(goto, [115]);
});

test('client: a bad third element (0, negative, text, fraction) is ignored, not trusted', () => {
  const { handler, goto } = clientHandler();
  for (const bad of [0, -5, '1500', 2.5, null, NaN]) handler([40, 155, bad]);
  assert.deepEqual(goto, [115, 115, 115, 115, 115, 115]);
});

test('client: nothing moves the editor unless the job is running (connectionStatus 3), as before', () => {
  const { handler, goto, ctx } = clientHandler();
  ctx.laststatus.comms.connectionStatus = 2;
  handler([40, 155, 1523]);
  assert.deepEqual(goto, []);
});
