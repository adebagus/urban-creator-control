// Tests for the "Lanjutkan dari Baris" / "Start From Line" dialog (app/wizards/resume/resume.js),
// opened by "Recover Job" (banner / modal / ribbon - with a saved crash record, or by the user with none)
// and by the GCODE Editor's right-click "Recover job from Line".
//
// What it does - and, on purpose, does NOT do:
//   * suggests a start line 10 lines before where the job stopped (configurable), pre-filled but editable;
//   * "Safe Height (Z)": one rapid up to (highest Z in the file + Safe Height);
//   * arms the NEXT Run to send the file from the chosen line: the file's own opening lines
//     (units, mode, offset, spindle... everything before the first axis move) then the lines from
//     the start line on. Run otherwise always sends the whole editor from line 1.
//   * it does NOT compute an entry X/Y position, does NOT search for the last spindle command and
//     does NOT rewrite the program in the editor - those were the source of earlier bugs.
// The REAL functions run in a vm sandbox (test/helpers/recovery-env.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, PROGRAM, lineText, expectedEntry, RESUME, MAIN, extractFunction, read } = require('./helpers/recovery-env');

const KEYBOARD = read('app/js/keyboard.js');
const TOOLCHANGE = read('app/js/toolchange.js');
const CSS = read('app/css/main.css');
const INDEX_JS = read('index.js');

const lines = (text) => text.split('\n');
const open = (x = 120, over) => { const env = makeEnv(over); env.ctx.showStartFromLine(x, 'recovery'); return env; };

// ============================================================ the suggested start line (X - 10)

test('rewind: 10 lines by default; a stored number (0-1000) overrides it; anything else falls back to 10', () => {
  assert.equal(makeEnv().ctx.recoveryRewindLines(), 10);
  for (const [stored, expected] of [['25', 25], ['0', 0], ['1000', 1000], [' 7 ', 7]]) {
    assert.equal(makeEnv({ storage: { recoveryRewindLines: stored } }).ctx.recoveryRewindLines(), expected, stored);
  }
  for (const bad of ['-1', 'abc', '1001', '12345', '', '3.5', '1e2', 'NaN']) {
    assert.equal(makeEnv({ storage: { recoveryRewindLines: bad } }).ctx.recoveryRewindLines(), 10, JSON.stringify(bad));
  }
  assert.equal(makeEnv({ throwStorage: true }).ctx.recoveryRewindLines(), 10, 'blocked storage must not break the dialog');
});

test('suggested line = stopped line - 10, never below 1', () => {
  const sug = makeEnv().ctx.recoverySuggestedLine;
  assert.equal(sug(120), 110);
  assert.equal(sug(11), 1);
  assert.equal(sug(10), 1);
  assert.equal(sug(1), 1);
  assert.equal(sug('50'), 40, 'a string (from an input) behaves like a number');
  assert.equal(sug(200), 190);
});

test('suggested line follows the configured rewind', () => {
  const env = makeEnv({ storage: { recoveryRewindLines: '25' } });
  assert.equal(env.ctx.recoverySuggestedLine(120), 95);
  env.ctx.showStartFromLine(120, 'recovery');
  assert.equal(env.prefill().start, 95);
  assert.match(env.dlg().content, /Disarankan mulai sekitar baris <b>95<\/b>/);
});

// ============================================================ the dialog

test('dialog: title, description, job info, suggestion and note - the requested texts', () => {
  const env = open(120);
  const d = env.dlg();
  assert.match(d.title, /Lanjutkan dari Baris/);
  assert.match(d.title, /class='recovery-title-en'>Start From Line</);
  assert.ok(d.content.includes('Melanjutkan pekerjaan setelah listrik mati, koneksi putus, atau gangguan lain.'));
  assert.ok(d.content.includes('Pekerjaan Anda (total <b>200</b> baris) terhenti sekitar baris <b>120</b>.'));
  assert.ok(d.content.includes('Disarankan mulai sekitar baris <b>110</b> untuk hasil lebih aman.'));
  assert.ok(d.content.includes('Pastikan mesin sudah di-Home dan Set Zero ulang sebelum melanjutkan.'));
});

test('dialog: the button is "Mulai dari Baris Ini / Start from Line", the only action, plus a close (x)', () => {
  const d = open().dlg();
  assert.equal(d.actions.length, 1);
  assert.equal(d.actions[0].caption, 'Mulai dari Baris Ini / Start from Line');
  assert.equal(d.closeButton, true);
});

test('dialog: "Mulai dari baris" is PRE-FILLED with the recommendation (X - 10) - not X, not empty, not 0 - and stays editable', () => {
  const env = open(120);
  const html = env.dlg().content;
  assert.match(html, /id="recoveryStartLine"[^]*?data-prepend="Mulai dari baris:"/);
  assert.equal(env.prefill().start, 110);
  assert.notEqual(env.prefill().start, 120, 'not the raw stopped line');
  assert.ok(env.prefill().start > 0, 'not empty / 0');
  const input = html.match(/<input id="recoveryStartLine"[^>]*>/)[0];
  assert.match(input, /type="number"/);
  assert.match(input, /data-editable="true"/);
  assert.ok(!/readonly|disabled/i.test(input), 'editable');
  assert.match(input, /min="1" max="200"/);
});

test('dialog: "Safe Height (Z)" is a number input in mm with a sensible default of 10', () => {
  const env = open();
  const input = env.dlg().content.match(/<input id="recoverySafeZ"[^>]*>/)[0];
  assert.match(input, /data-prepend="Safe Height \(Z\), mm:"/);
  assert.match(input, /type="number"/);
  assert.match(input, /value="10"/);
  assert.equal(env.prefill().safe, 10);
  assert.ok(env.dlg().content.includes('tinggi (mm) di atas titik tertinggi file (Z5)'));
});

test('dialog: the editor is scrolled to the suggested line for context', () => {
  assert.equal(open(120).cursor, 110);
});

test('dialog: start line clamps into the file, and a stopped line beyond the file warns (wrong file?)', () => {
  const env = open(900); // 900 > 200 lines
  assert.equal(env.prefill().start, 200, 'X - 10 = 890, clamped to the last line');
  assert.match(env.dlg().content, /recovery-start-error">Baris 900 melebihi panjang file yang dimuat \(200 baris\)/);
  assert.ok(!/melebihi/.test(open(120).dlg().content), 'no warning for a normal line');
});

test('dialog: line 1 (and small numbers) pre-fill 1 - never 0 or negative', () => {
  for (const x of [1, 5, 10, 11]) {
    const env = open(x);
    assert.equal(env.prefill().start, 1, 'X=' + x);
  }
  assert.equal(open(12).prefill().start, 2);
});

test('dialog: an unusable stopped line is treated as line 1', () => {
  for (const bad of [0, -5, NaN, undefined, 'abc']) {
    const env = makeEnv();
    env.ctx.showStartFromLine(bad, 'recovery');
    assert.equal(env.prefill().start, 1, String(bad));
  }
});

test('dialog: from the GCODE Editor right-click it is pre-filled from the chosen line, also minus 10', () => {
  const env = makeEnv();
  env.ctx.startFromHere(50);
  assert.equal(env.prefill().start, 40);
  assert.ok(env.dlg().content.includes('Anda memilih baris <b>50</b> (total <b>200</b> baris).'));
  assert.ok(!/terhenti/.test(env.dlg().content), 'a chosen line is not a "stopped" line');
  assert.ok(env.dlg().content.includes('Disarankan mulai sekitar baris <b>40</b>'));
  assert.equal(env.dlg().actions[0].caption, 'Mulai dari Baris Ini / Start from Line', 'the same dialog');
  makeEnv().ctx.startFromHere('75'); // the menu passes a number, an input would pass a string
});

test('dialog: only numbers are interpolated into the HTML', () => {
  const env = makeEnv();
  env.ctx.showStartFromLine('120<script>alert(1)</script>', 'recovery');
  assert.ok(!/<script>/.test(env.dlg().content));
});

// ============================================================ live validation

const enabled = (env) => env.disabled['.recovery-start-button'] === false;

test('validation: with the pre-filled values and a connected, idle machine the button is enabled, and it shows where Z goes', () => {
  const env = open();
  assert.ok(enabled(env));
  assert.match(env.htmlOf['#recoveryStartMessages'], /Urutan \(mm\): <b>Z15<\/b>.*&rarr; baris <b>110<\/b>/);
});

test('validation: an invalid start line disables the button and says why; fixing it re-enables', () => {
  const env = open();
  for (const bad of ['0', '201', '-3', 'abc', '', '1.5', '1e1', '  ']) {
    env.type(bad);
    assert.equal(env.disabled['.recovery-start-button'], true, 'start=' + JSON.stringify(bad));
    assert.match(env.htmlOf['#recoveryStartMessages'], /Nomor baris harus bilangan bulat antara 1 dan 200/);
  }
  for (const good of ['1', '200', '77', ' 90 ']) {
    env.type(good);
    assert.ok(enabled(env), 'start=' + JSON.stringify(good));
  }
});

test('validation: the start line is editable to ANY valid number, not just the recommendation', () => {
  const env = open(120);
  env.type(37);
  assert.ok(enabled(env));
  assert.match(env.htmlOf['#recoveryStartMessages'], /&rarr; baris <b>37<\/b>/);
});

test('validation: Safe Height must be 0-500 mm', () => {
  const env = open();
  for (const bad of ['-1', '501', 'x', '', '1e2', '10.1234', '99999']) {
    env.type(undefined, bad);
    assert.equal(env.disabled['.recovery-start-button'], true, JSON.stringify(bad));
    assert.match(env.htmlOf['#recoveryStartMessages'], /Safe Height harus angka antara 0 dan 500 mm/);
  }
  for (const [good, z] of [['0', 5], ['2.5', 7.5], ['500', 505], ['10', 15]]) {
    env.type(undefined, good);
    assert.ok(enabled(env), good);
    assert.ok(env.htmlOf['#recoveryStartMessages'].includes('Z' + z + '</b>'), good + ' -> Z' + z);
  }
});

test('validation: the machine must be connected and idle (status 1 or 2); it follows the live status', () => {
  for (const [status, ok] of [[0, false], [1, true], [2, true], [3, false], [4, false], [5, false], [6, false]]) {
    const env = open(120, { status });
    assert.equal(enabled(env), ok, 'status ' + status);
    if (!ok) assert.match(env.htmlOf['#recoveryStartMessages'], /Mesin belum terhubung atau belum siap/);
  }
  const nostatus = open(120);
  nostatus.ctx.laststatus = {}; // no status received yet
  nostatus.tick();
  assert.ok(!enabled(nostatus), 'unknown status is not treated as ready');
  const env = open(120, { status: 0 });
  assert.ok(!enabled(env));
  env.setStatus(1);
  env.tick(); // the 500 ms refresh
  assert.ok(enabled(env), 'becomes enabled once the machine is ready');
  env.setStatus(3);
  env.tick();
  assert.ok(!enabled(env), 'and disabled again when a job is running');
});

test('validation: the refresh timer stops when the dialog is gone', () => {
  const env = open();
  env.tick();
  assert.equal(env.cleared.length, 0);
  env.formOpen = false;
  env.tick();
  assert.equal(env.cleared.length, 1);
});

test('validation: an incremental (G91) file cannot be resumed mid-way - the button stays disabled', () => {
  const text = ['G21 G91', 'G0 Z5', ...PROGRAM.slice(3)].join('\n');
  const env = open(120, { text });
  assert.ok(!enabled(env));
  assert.match(env.htmlOf['#recoveryStartMessages'], /mode inkremental \(G91\)/);
});

test('validation: the start button cannot do anything while disabled', () => {
  const env = open(120, { status: 0 });
  assert.equal(env.clickStart(), false);
  assert.deepEqual(env.gcodeSent, []);
  env.ctx.recoveryStartRun({ facts: { maxZ: 5, inch: false, relative: false }, total: 200, lines: PROGRAM, text: PROGRAM.join('\n'), fileName: 'part.nc' }); // even if called directly
  assert.deepEqual(env.gcodeSent, [], 'nothing sent');
  assert.equal(env.posted.length, 0, 'no job');
  assert.match(env.logs.join(' '), /Not started/);
});

// ============================================================ facts about the file

test('facts: highest Z over the whole file, ignoring comments; none -> null', () => {
  const f = makeEnv().ctx.recoveryFileFacts;
  assert.equal(f(PROGRAM).maxZ, 5);
  assert.equal(f(['G1 Z-1', 'G1 Z-3.5', 'G0 Z-0.2']).maxZ, -0.2, 'negative only');
  assert.equal(f(['G0 X1 Y1', 'G1 X2']).maxZ, null);
  assert.equal(f(['G0 Z2 ; Z99', '(Z88) G0 Z3', 'G0 Z1']).maxZ, 3, 'comments are ignored');
  assert.equal(f(['G1 Z 7.25', 'G1 X1 Z.5']).maxZ, 7.25);
  assert.equal(f(['']).maxZ, null);
});

test('facts: inches and incremental mode', () => {
  const f = makeEnv().ctx.recoveryFileFacts;
  assert.equal(f(['G20 G90', 'G0 Z0.2']).inch, true);
  assert.equal(f(['G21 G90']).inch, false);
  assert.equal(f(['G20', 'G21']).inch, false, 'both present: not treated as inches');
  assert.equal(f(['G21 G91', 'G1 X1']).relative, true);
  assert.equal(f(['G21 G91.1', 'G1 X1']).relative, false, 'G91.1 (arc offsets) is not incremental positioning');
  assert.equal(f(['G21 G90']).relative, false);
});

// ============================================================ the file's opening lines

test('header: everything before the first axis move; the sample program has 2', () => {
  const h = makeEnv().ctx.recoveryHeaderLength;
  assert.equal(h(PROGRAM), 2);
  assert.equal(h(['G21 G90 G54', 'M3 S12000', 'G4 P2', 'F1000', 'G43 H1', 'G0 X5']), 5, 'dwell, feed, tool length offset are not moves');
  assert.equal(h(['G0 X1']), 0);
  assert.equal(h(['G21', 'G90']), 2, 'a file with only opening lines');
  assert.equal(h([]), 0);
});

test('header: blank and comment-only lines belong to it; comments never hide or fake a move', () => {
  const h = makeEnv().ctx.recoveryHeaderLength;
  assert.equal(h(['; job', '(part)', '', 'G21', 'G0 X1']), 4);
  assert.equal(h(['G21 (X9 Y9)', 'M3 ; Z5', 'G0 X1']), 2, 'axis words inside comments do not end it');
});

test('header: it stops BEFORE anything that must not be replayed', () => {
  const h = makeEnv().ctx.recoveryHeaderLength;
  for (const stop of ['G0', 'G00', 'G1 F100', 'G01', 'G2', 'G3', 'G28', 'G30', 'G53 G0', 'G92 X0', 'G10 L20 P1', 'G38.2 Z-5', 'M0', 'M1', 'M2', 'M6 T1', 'M06', 'M30', '$H', '$J=X1', 'X10', 'Y5', 'Z5', 'A90']) {
    assert.equal(h(['G21 G90 G54', 'M3 S12000', stop, 'G0 X5']), 2, 'must stop at: ' + stop);
  }
});

test('header: harmless lines are kept', () => {
  const h = makeEnv().ctx.recoveryHeaderLength;
  for (const ok of ['G21', 'G20', 'G90', 'G54', 'G55', 'G17', 'G94', 'G43 H1', 'G4 P1', 'G04 P1', 'M3 S12000', 'M03 S9000', 'M4', 'M5', 'M8', 'M9', 'F1000', 'S18000', 'T1', 'G21 G90 G94 G17 G54']) {
    assert.equal(h(['G21', ok, 'G0 X5']), 2, 'must be kept: ' + ok);
  }
});

// ============================================================ the payload and its line offset

const SAFE = 15; // PROGRAM's highest Z is 5, plus the default Safe Height 10
const payloadOf = (start) => makeEnv().ctx.recoveryRunPayload(PROGRAM.join('\n'), start, SAFE);

test('payload: the file\'s opening lines, then the entry lines, then the file from the start line - in that order', () => {
  const p = payloadOf(110);
  const out = lines(p.text);
  assert.equal(p.headerLines, 2);
  assert.equal(p.entryLines, 5);
  assert.deepEqual(out.slice(0, 2), ['G21 G90 G54', 'M3 S12000'], 'opening lines: verbatim');
  assert.deepEqual(out.slice(2, 7), expectedEntry(110, SAFE), 'entry lines');
  assert.equal(out[7], lineText(110), 'then the start line, untouched');
  assert.equal(out[out.length - 1], lineText(200));
  assert.equal(out.length, 2 + 5 + (200 - 110 + 1));
  assert.equal(p.lineOffset, 102, '110 - 2 opening - 5 entry - 1');
});

test('payload: every line past the inserted ones maps back to the SAME text at its original line (lineOffset math)', () => {
  for (const start of [8, 20, 85, 199, 200]) {
    const p = payloadOf(start);
    const out = lines(p.text);
    for (let i = p.headerLines + p.entryLines; i < out.length; i++) {
      const originalLine = (i + 1) + p.lineOffset;
      assert.equal(out[i], lineText(originalLine), 'start=' + start + ' payload line ' + (i + 1) + ' -> file line ' + originalLine);
    }
  }
});

test('payload: the total the server records stays the ORIGINAL file length (lineOffset + payload lines)', () => {
  for (const start of [8, 50, 200]) {
    const p = payloadOf(start);
    assert.equal(p.lineOffset + lines(p.text).length, 200, 'start=' + start);
  }
});

test('payload: a start line inside (or right after) the opening lines sends the WHOLE file - nothing has happened before it', () => {
  for (const start of [1, 2, 3]) {
    const p = payloadOf(start);
    assert.equal(p.text, PROGRAM.join('\n'), 'start=' + start);
    assert.equal(p.lineOffset, 0);
    assert.equal(p.entryLines, 0);
    assert.equal(p.headerLines, 0);
  }
});

test('payload: near the top the offset is clamped at 0 (never negative), and the text is still right', () => {
  const p = payloadOf(7); // 7 - 2 - 5 - 1 = -1
  assert.equal(p.lineOffset, 0);
  const out = lines(p.text);
  assert.deepEqual(out.slice(2, 7), expectedEntry(7, SAFE));
  assert.equal(out[7], lineText(7));
});

test('payload: the last line', () => {
  const out = lines(payloadOf(200).text);
  assert.deepEqual(out, ['G21 G90 G54', 'M3 S12000', ...expectedEntry(200, SAFE), lineText(200)]);
});

test('payload: the source text is never modified', () => {
  const text = PROGRAM.join('\n');
  makeEnv().ctx.recoveryRunPayload(text, 110, SAFE);
  assert.equal(text, PROGRAM.join('\n'));
});

// ============================================================ the entry: what the file had set up at the start line

const ctxOf = () => makeEnv().ctx;
const entryOf = (progLines, start, safe = 15, facts = { inch: false }) => ctxOf().recoveryEntryPlan(progLines, start, safe, facts);
const arcs = () => require('./helpers/recovery-env').ARC_PROGRAM;

test('entry, real-job shape: an arc start line WITHOUT F gets the spindle, position, plunge and feed it needs (this is what killed the job)', () => {
  const e = entryOf(arcs(), 22);
  assert.deepEqual(Array.from(e.lines), ['G0 Z15', 'M3 S16000', 'G0 X10.263 Y11.576', 'G1 Z-4.365 F150.0', 'F800.0']);
  assert.equal(e.error, '');
  assert.equal(e.prefix, null, 'the arc line already says G3');
});

test('entry, real-job shape: the full payload for that start line', () => {
  const env = makeEnv({ text: arcs().join('\n') });
  const p = env.ctx.recoveryRunPayload(arcs().join('\n'), 22, 15, env.ctx.recoveryFileFacts(arcs()));
  const out = lines(p.text);
  assert.deepEqual(out.slice(0, 4), ['T1', 'G17', 'G21', 'G90'], 'opening lines (stop at G0Z20)');
  assert.deepEqual(out.slice(4, 9), ['G0 Z15', 'M3 S16000', 'G0 X10.263 Y11.576', 'G1 Z-4.365 F150.0', 'F800.0']);
  assert.equal(out[9], 'G3X9.263Y10.576I0.000J-1.000', 'file line 22, untouched');
  assert.equal(p.lineOffset, 22 - 4 - 5 - 1);
});

test('entry: the spindle command that sits AFTER the first moves ("S16000M3", no spaces) is restored - and only after Z is up', () => {
  const l = Array.from(entryOf(arcs(), 22).lines);
  assert.ok(l.includes('M3 S16000'));
  assert.ok(l.indexOf('G0 Z15') < l.indexOf('M3 S16000'), 'Z up first, spindle second');
  assert.ok(l.indexOf('M3 S16000') < l.indexOf('G0 X10.263 Y11.576'), 'spindle before it travels');
});

test('entry: the rapid goes to where the start line begins (the END of the previous line), Z to the last Z, at the SLOWEST feed the file used', () => {
  const l = ['G21', 'M3 S1000', 'G0 X1 Y1 Z5', 'G1 Z-1 F100', 'G1 X10 Y10 F1200', 'G1 X20 Y5 Z-2 F600', 'G1 X30 Y30'];
  const e = entryOf(l, 7); // start at 'G1 X30 Y30'
  assert.deepEqual(Array.from(e.lines), ['G0 Z15', 'M3 S1000', 'G0 X20 Y5', 'G1 Z-2 F100', 'F600']);
  const first = entryOf(l, 5); // start at 'G1 X10 Y10 F1200': before it: X1 Y1 Z-1, F100 only
  assert.deepEqual(Array.from(first.lines), ['G0 Z15', 'M3 S1000', 'G0 X1 Y1', 'G1 Z-1 F100', 'F100']);
});

test('entry: G-code words written without spaces are read ("G0X10Y20Z5", "G1Z-1F150", "S8000M3")', () => {
  const l = ['G21G90', 'G0X10Y20Z5', 'S8000M3', 'G1Z-1F150', 'G1X30Y40F900', 'G1X50Y60'];
  assert.deepEqual(Array.from(entryOf(l, 6).lines), ['G0 Z15', 'M3 S8000', 'G0 X30 Y40', 'G1 Z-1 F150', 'F900']);
});

test('entry: only the lines BEFORE the start line count - later lines never influence it', () => {
  const l = ['G21', 'M3 S1000', 'G1 X1 Y1 Z-1 F100', 'G1 X2 Y2', 'G1 X999 Y999 Z-50 F50', 'M5'];
  assert.deepEqual(Array.from(entryOf(l, 4).lines), ['G0 Z15', 'M3 S1000', 'G0 X1 Y1', 'G1 Z-1 F100', 'F100']);
});

test('entry: spindle - M5 before the start line is replayed as M5; no spindle command means none; M4 and a lone S line work', () => {
  const off = ['G21', 'M3 S1000', 'G1 X1 F100', 'M5', 'G1 X2 F100', 'G1 X3'];
  assert.equal(Array.from(entryOf(off, 6).lines)[1], 'M5');
  const none = ['G21', 'G1 X1 F100', 'G1 X2', 'G1 X3'];
  assert.ok(!Array.from(entryOf(none, 4).lines).some((x) => /^M/.test(x)));
  const four = ['G21', 'M4 S500', 'G1 X1 F100', 'G1 X2'];
  assert.equal(Array.from(entryOf(four, 4).lines)[1], 'M4 S500');
  const lone = ['G21', 'S12000', 'M3', 'G1 X1 F100', 'G1 X2'];
  assert.equal(Array.from(entryOf(lone, 5).lines)[1], 'M3 S12000');
  const bare = ['G21', 'M3', 'G1 X1 F100', 'G1 X2'];
  assert.equal(Array.from(entryOf(bare, 4).lines)[1], 'M3', 'no S seen: just M3');
});

test('entry: a dwell right after the spindle start (the spin-up wait) is kept', () => {
  const l = ['G21', 'M3 S12000', 'G4 P3', 'G1 X1 F100', 'G1 X2'];
  assert.deepEqual(Array.from(entryOf(l, 5).lines).slice(0, 3), ['G0 Z15', 'M3 S12000', 'G4 P3']);
  const notDwell = ['G21', 'M3 S12000', 'G1 X1 F100', 'G4 P3', 'G1 X2'];
  assert.ok(!Array.from(entryOf(notDwell, 5).lines).some((x) => /^G4/.test(x)), 'a later dwell is not the spin-up wait');
});

test('entry: lines that use machine coordinates or change offsets say nothing about the work position', () => {
  const l = ['G21', 'G1 X5 Y6 Z-1 F100', 'G53 G0 Z0', 'G28 Z0', 'G30 X0 Y0', 'G92 X0 Y0 Z0', 'G10 L20 P1 X0 Y0 Z0', 'G53G0X-100Y-100', 'G1 X9'];
  assert.deepEqual(Array.from(entryOf(l, 9).lines), ['G0 Z15', 'G0 X5 Y6', 'G1 Z-1 F100', 'F100']);
});

test('entry: no position yet -> no rapid; no Z yet -> no plunge', () => {
  assert.deepEqual(Array.from(entryOf(['G21', 'M3 S1000', 'G0 F100', 'G1 X5'], 4).lines), ['G0 Z15', 'M3 S1000', 'F100']);
  assert.deepEqual(Array.from(entryOf(['G21', 'G0 X1 Y2', 'G1 X5 F100'], 3).lines), ['G0 Z15', 'G0 X1 Y2']);
  assert.deepEqual(Array.from(entryOf(['G21', 'G1 X5 F100', 'G1 X9'], 3).lines), ['G0 Z15', 'G0 X5', 'F100']);
});

test('entry: the A axis is carried along', () => {
  assert.deepEqual(Array.from(entryOf(['G21', 'G1 X1 Y2 A45 Z-1 F100', 'G1 X3'], 3).lines), ['G0 Z15', 'G0 X1 Y2 A45', 'G1 Z-1 F100', 'F100']);
});

test('entry: comments are ignored', () => {
  const l = ['G21', '(M5 stop) M3 S1000 ; M5', 'G1 X1 Y1 (Z-99) Z-1 F100 ; F999', 'G1 X2'];
  assert.deepEqual(Array.from(entryOf(l, 4).lines), ['G0 Z15', 'M3 S1000', 'G0 X1 Y1', 'G1 Z-1 F100', 'F100']);
});

test('entry: an inch file - the safe height is converted, and rounded to 4 decimals', () => {
  assert.equal(Array.from(entryOf(['G20', 'G1 X1 F10', 'G1 X2'], 3, 15, { inch: true }).lines)[0], 'G0 Z0.5906');
  assert.equal(Array.from(entryOf(['G21', 'G1 X1 F10', 'G1 X2'], 3, 15, { inch: false }).lines)[0], 'G0 Z15');
});

test('entry: a first move that does not say which motion it is gets it restored - G0/G1 as a lone word, G2/G3 in front of the line', () => {
  const linear = ['G21', 'G1 X1 Y1 F100', 'X2 Y2', 'X3 Y3', 'X4 Y4'];
  const l = entryOf(linear, 4);
  assert.deepEqual(Array.from(l.lines).slice(-2), ['F100', 'G1'], 'a lone G1 sets the mode without moving');
  assert.equal(l.prefix, null);
  const rapid = ['G21', 'G0 X1 Y1', 'F100', 'X2 Y2', 'X3'];
  assert.equal(Array.from(entryOf(rapid, 4).lines).slice(-1)[0], 'G0');
  const arc = ['G21', 'G2 X1 Y1 I1 J0 F100', 'X2 Y2 I1 J0', 'X3 Y3 I1 J0'];
  const a = entryOf(arc, 3);
  assert.deepEqual({ index: a.prefix.index, word: a.prefix.word }, { index: 2, word: 'G2' }); // (a plain copy: vm objects fail deepEqual)
  assert.ok(!Array.from(a.lines).includes('G2'), 'a lone G2 is not a valid line');
  const p = makeEnv().ctx.recoveryRunPayload(arc.join('\n'), 3, 15, { inch: false });
  assert.ok(lines(p.text).includes('G2 X2 Y2 I1 J0'), 'the arc word is put in front of the line');
  assert.equal(lines(p.text).filter((x) => x === 'X2 Y2 I1 J0').length, 0);
});

test('entry: the motion mode is found in words written without spaces too ("G1X1Y1F100", then "X2Y2")', () => {
  const l = ['G21G90', 'G1X1Y1F100', 'X2Y2', 'X3Y3'];
  assert.deepEqual(Array.from(entryOf(l, 4).lines).slice(-1), ['G1'], 'the last mode was G1, written as G1X1Y1F100');
  const arc = ['G21G90', 'G2X1Y1I1J0F100', 'X2Y2I1J0', 'X3Y3I1J0'];
  assert.deepEqual({ i: entryOf(arc, 3).prefix.index, w: entryOf(arc, 3).prefix.word }, { i: 2, w: 'G2' });
});

test('entry: the unresumable-start-line check also applies for machine status 2 (connected, idle) - not only status 1', () => {
  const text = ['G21', 'G1 X1', 'G1 X2', 'G1 X3', 'G1 X4'].join('\n');
  const env = makeEnv({ text, status: 2 });
  env.ctx.showStartFromLine(1, 'manual');
  env.type(3);
  assert.equal(env.disabled['.recovery-start-button'], true);
  assert.match(env.htmlOf['#recoveryStartMessages'], /Tidak ada kata F/);
});

test('entry: a first move that already names its motion is left alone', () => {
  const l = entryOf(['G21', 'G1 X1 F100', 'G1 X2', 'G0 X3'], 3);
  assert.ok(!Array.from(l.lines).some((x) => /^G[0-3]$/.test(x)));
  assert.equal(l.prefix, null);
});

test('entry: a start line that cuts with NO feed anywhere before it cannot be resumed - it says so', () => {
  const cutting = ['G21', 'G1 X1', 'G1 X2', 'G1 X3'];
  assert.match(entryOf(cutting, 3).error, /Tidak ada kata F/);
  const arc = ['G21', 'G0 X1', 'G3 X2 Y2 I1 J0'];
  assert.match(entryOf(arc, 3).error, /Tidak ada kata F/);
  const withF = ['G21', 'G1 X1 F100', 'G1 X2'];
  assert.equal(entryOf(withF, 3).error, '');
  const ownF = ['G21', 'G0 X1', 'G1 X2 F100'];
  assert.equal(entryOf(ownF, 3).error, '', 'the line brings its own F');
  const rapid = ['G21', 'G0 X1', 'G0 X2', 'G0 X3'];
  assert.equal(entryOf(rapid, 3).error, '', 'rapids need no feed');
});

test('entry: a plunge Z needs a feed too - without any F the entry refuses', () => {
  assert.match(entryOf(['G21', 'G0 X1 Z-1', 'G0 X2'], 3).error, /Z tidak bisa diturunkan/);
});

test('entry: the dialog blocks a start line that cannot be resumed, with the reason', () => {
  const text = ['G21', 'G1 X1', 'G1 X2', 'G1 X3', 'G1 X4'].join('\n');
  const env = makeEnv({ text });
  env.ctx.showStartFromLine(1, 'manual');
  env.type(3);
  assert.equal(env.disabled['.recovery-start-button'], true);
  assert.match(env.htmlOf['#recoveryStartMessages'], /Tidak ada kata F \(feed rate\)/);
});

test('entry: the dialog shows what will be sent before the start line - so nothing is a surprise', () => {
  const env = makeEnv({ text: arcs().join('\n') });
  env.ctx.showStartFromLine(1, 'manual');
  env.type(22);
  const m = env.htmlOf['#recoveryStartMessages'];
  assert.match(m, /Urutan \(mm\):.*&rarr; baris <b>22<\/b>/);
  assert.match(m, /<b>Z30<\/b>/); // the file's highest Z is 20 (G0Z20) + Safe Height 10
  assert.match(m, /<b>M3 S16000<\/b>/);
  assert.match(m, /<b>X10\.263 Y11\.576<\/b>/);
  assert.match(m, /<b>Z-4\.365 \(F150\.0\)<\/b>/);
  assert.match(m, /<b>F800\.0<\/b>/);
  assert.ok(m.indexOf('Z30') < m.indexOf('M3 S16000') && m.indexOf('M3 S16000') < m.indexOf('X10.263'), 'in the order they are sent');
});

test('entry: the scan is done once per set of numbers - the 500 ms refresh does not redo it', () => {
  const env = makeEnv();
  let scans = 0;
  const real = env.ctx.recoveryEntryPlan;
  env.ctx.recoveryEntryPlan = function () { scans++; return real.apply(this, arguments); };
  env.ctx.showStartFromLine(120, 'recovery');
  const afterOpen = scans;
  for (let i = 0; i < 6; i++) env.tick();
  assert.equal(scans, afterOpen, 'six refreshes, no new scan');
  env.type(60);
  assert.equal(scans, afterOpen + 1, 'a new number scans once');
  env.setStatus(3);
  env.tick();
  assert.ok(scans <= afterOpen + 2);
});

test('entry: G-code words without spaces do not hide G20 / G91 either ("G21G90", "G20G91")', () => {
  const f = makeEnv().ctx.recoveryFileFacts;
  assert.equal(f(['G21G90', 'G0X1']).inch, false);
  assert.equal(f(['G20G90', 'G0X1']).inch, true);
  assert.equal(f(['G21G91', 'G1X1']).relative, true);
  assert.equal(f(['G21G90G91.1', 'G1X1']).relative, false);
  assert.equal(f(['G0Z20.000', 'G0X0.000Y0.000']).maxZ, 20);
});

test('header: words without spaces stop it too ("G0Z20.000", "G1F100", "G21G90" are handled correctly)', () => {
  const h = makeEnv().ctx.recoveryHeaderLength;
  assert.equal(h(['T1', 'G17', 'G21', 'G90', 'G0Z20.000', 'S16000M3']), 4);
  assert.equal(h(['G21G90G54', 'M3S1000', 'G1F100', 'G0X1']), 2, 'a motion word (G1) ends it, even without an axis word');
});

// ============================================================ started by the user, with no saved job ("manual")

const openManual = (over) => { const env = makeEnv(over); env.ctx.showStartFromLine(1, 'manual'); return env; };

test('manual: the same dialog, but no crash wording and no crash recommendation', () => {
  const html = openManual().dlg().content;
  assert.ok(html.includes('File ini punya <b>200</b> baris. Anda bebas mulai dari baris mana pun.'));
  assert.ok(!/terhenti|Disarankan|Anda memilih|melebihi/.test(html));
  assert.ok(html.includes('Melanjutkan pekerjaan setelah listrik mati'), 'same description');
  assert.ok(html.includes('Pastikan mesin sudah di-Home dan Set Zero ulang sebelum melanjutkan.'), 'same safety note');
  assert.match(html, /id="recoveryStartLine"/);
  assert.match(html, /id="recoverySafeZ"[^]*?value="10"/);
});

test('manual: the start line is where the user is in the editor - the cursor line, else the top visible line, else 1 (no step back)', () => {
  assert.equal(openManual().prefill().start, 1);
  const cursor = makeEnv(); cursor.selRow = 59; cursor.ctx.showStartFromLine(1, 'manual');
  assert.equal(cursor.prefill().start, 60);
  const top = makeEnv(); top.topRow = 119; top.ctx.showStartFromLine(1, 'manual');
  assert.equal(top.prefill().start, 120);
  const both = makeEnv(); both.selRow = 9; both.topRow = 99; both.ctx.showStartFromLine(1, 'manual');
  assert.equal(both.prefill().start, 10, 'the cursor wins once the user clicked into the text');
  const past = makeEnv(); past.selRow = 5000; past.ctx.showStartFromLine(1, 'manual');
  assert.equal(past.prefill().start, 200, 'clamped into the file');
});

test('manual: the "stopped line" argument plays no role, and the recovery -10 is NOT applied', () => {
  const env = makeEnv(); env.selRow = 49;
  env.ctx.showStartFromLine(999, 'manual');
  assert.equal(env.prefill().start, 50, 'not 999, not 40');
  assert.ok(!/melebihi/.test(env.dlg().content));
});

test('manual: the editor is scrolled to the pre-filled line, and the rewind setting is ignored', () => {
  const env = makeEnv({ storage: { recoveryRewindLines: '25' } }); env.selRow = 59;
  env.ctx.showStartFromLine(1, 'manual');
  assert.equal(env.cursor, 60);
  assert.equal(env.prefill().start, 60);
});

test('manual: an unreadable editor position falls back to line 1 (no crash)', () => {
  const env = makeEnv();
  env.ctx.editor.getSelectionRange = () => { throw new Error('no editor'); };
  env.ctx.showStartFromLine(1, 'manual');
  assert.equal(env.prefill().start, 1);
  assert.equal(makeEnv().ctx.recoveryEditorLine(), 1);
});

test('manual: everything after the dialog is identical - validation, one job with the raise first, 3D View', () => {
  const env = openManual();
  assert.ok(enabled(env));
  env.type('0');
  assert.equal(env.disabled['.recovery-start-button'], true);
  env.type(75, 5);
  assert.ok(env.clickStart());
  assert.equal(env.posted.length, 1);
  const out = lines(env.job().body);
  assert.equal(out[0], 'G21 G90 G0 Z10');
  assert.deepEqual(out.slice(3, 8), expectedEntry(75, 10));
  assert.equal(out[8], lineText(75));
  assert.equal(env.job().lineOffset, '66'); // 75 - 1 - 2 - 5 - 1
});

test('manual: the machine must still be connected and idle', () => {
  const env = openManual({ status: 0 });
  assert.ok(!enabled(env));
  assert.match(env.htmlOf['#recoveryStartMessages'], /Mesin belum terhubung/);
});

test('editor helpers: a program is "loaded" when the editor has any non-blank text', () => {
  for (const [text, expected] of [['G21', true], ['', false], ['   ', false], ['\n\n', false], ['G0 X1\nG0 X2', true]]) {
    assert.equal(makeEnv({ text }).ctx.recoveryEditorHasProgram(), expected, JSON.stringify(text));
  }
  assert.equal(makeEnv({ text: 'File too large', gcode: 'G21\nG0 X1' }).ctx.recoveryEditorHasProgram(), true, 'very large files (global gcode)');
  assert.equal(makeEnv({ text: '', gcode: 'G21' }).ctx.recoveryEditorHasProgram(), true);
});

// ============================================================ the Z raise plan

test('plan: Z raise = highest Z in the file + Safe Height, in work coordinates, absolute, millimetres', () => {
  const plan = makeEnv().ctx.recoveryPlanStart;
  const p = plan({ maxZ: 5, inch: false, relative: false }, 200, '110', '10', 1);
  assert.equal(p.ok, true);
  assert.equal(p.preMove, 'G21 G90 G0 Z15');
  assert.equal(p.targetZ, 15);
  assert.equal(p.start, 110);
  assert.equal(plan({ maxZ: 5 }, 200, '110', '2.5', 1).preMove, 'G21 G90 G0 Z7.5');
  assert.equal(plan({ maxZ: null }, 200, '110', '10', 1).preMove, 'G21 G90 G0 Z10', 'no Z in the file: measured from 0');
  assert.equal(plan({ maxZ: -1 }, 200, '110', '0.5', 1).preMove, 'G21 G90 G0 Z-0.5', 'still above the file\'s highest point');
  assert.equal(plan({ maxZ: 0 }, 200, '110', '0', 1).preMove, 'G21 G90 G0 Z0');
});

test('plan: an inch file\'s highest Z is converted, the raise is always sent in millimetres', () => {
  const plan = makeEnv().ctx.recoveryPlanStart;
  const p = plan({ maxZ: 0.2, inch: true, relative: false }, 200, '110', '10', 1);
  assert.equal(p.preMove, 'G21 G90 G0 Z15.08');
  assert.equal(plan({ maxZ: 0.2, inch: true }, 200, '110', '10', 1).targetZ, 15.08);
});

test('plan: the raise is never a machine-coordinate move and always matches the strict pattern', () => {
  const plan = makeEnv().ctx.recoveryPlanStart;
  for (const [maxZ, safe] of [[5, '10'], [null, '0'], [-3.3333333, '1'], [12.3456789, '0.001'], [100, '500']]) {
    const p = plan({ maxZ, inch: false, relative: false }, 200, '5', safe, 1);
    assert.match(p.preMove, /^G21 G90 G0 Z-?\d+(\.\d+)?$/, JSON.stringify([maxZ, safe]));
    assert.ok(!/G53/.test(p.preMove));
  }
  assert.equal(plan({ maxZ: 12.3456789 }, 200, '5', '0.001', 1).targetZ, 12.347, 'rounded to 3 decimals');
});

test('plan: an absurdly high Z in the file cannot produce a malformed move (exponent form)', () => {
  const plan = makeEnv().ctx.recoveryPlanStart;
  const p = plan({ maxZ: 1e23, inch: false, relative: false }, 200, '110', '10', 1);
  assert.equal(p.ok, false);
  assert.equal(p.preMove, '');
  assert.match(p.errors.join(' '), /Tinggi aman tidak bisa dihitung/);
  assert.equal(makeEnv().ctx.recoveryFileFacts(['G0 Z99999999999999999999999']).maxZ, 1e23);
});

test('plan: an invalid form produces no Z move at all', () => {
  const plan = makeEnv().ctx.recoveryPlanStart;
  const p = plan({ maxZ: 5 }, 200, '110', 'oops', 1);
  assert.equal(p.ok, false);
  assert.equal(p.preMove, '');
});

// ============================================================ the final button: ONE action - validated, sent as ONE job, 3D View shown

const go = (x = 120, over) => { const env = open(x, over); assert.ok(env.clickStart(), 'the button must be enabled'); return env; };
const PRE15 = 'G21 G90 G0 Z15'; // the raise: mm, absolute - the first line of the job

test('button: ONE click sends ONE job - the Z raise is its first line - and nothing else is sent (no separate command, no second Run)', () => {
  const env = go(120);
  assert.equal(env.posted.length, 1, 'exactly one job');
  assert.deepEqual(env.gcodeSent, [], 'no separate runCommand any more');
  assert.ok(!env.emits.some((e) => /runJob|runCommand/i.test(e)));
  const job = env.job();
  assert.equal(job.method, 'POST');
  assert.equal(job.url, '/runjob', 'the same endpoint as the ordinary Run button');
  assert.equal(job.fileName, 'part.nc');
  assert.equal(job.lineOffset, '101'); // 110 - 1 raise - 2 opening - 5 entry - 1
  const out = lines(job.body);
  assert.equal(out[0], PRE15, 'the raise comes first');
  assert.deepEqual(out.slice(1, 3), ['G21 G90 G54', 'M3 S12000'], 'then the file\'s opening lines');
  assert.deepEqual(out.slice(3, 8), expectedEntry(110, 15), 'then the entry: Z up, spindle, rapid to the start point, plunge, feed');
  assert.equal(out[8], lineText(110), 'then the chosen start line');
  assert.equal(out[out.length - 1], lineText(200), 'to the end of the file');
  for (const n of [6, 50, 100, 109]) assert.ok(!out.includes(lineText(n)), 'finished line ' + n + ' must not be sent');
});

test('button: no pause - the whole sequence is in that single job, and a later Run press is a separate ordinary job', () => {
  const env = go(120);
  assert.equal(env.posted.length, 1);
  const later = env.run(); // (env.run resets and posts a NEW ordinary job)
  assert.equal(later.body, PROGRAM.join('\n'), 'the ordinary Run still sends the whole file from line 1');
  assert.equal(later.lineOffset, undefined);
});

test('button: uses what the user typed - another start line and another Safe Height', () => {
  const env = open(120);
  env.type(60, 20);
  assert.ok(env.clickStart());
  const out = lines(env.job().body);
  assert.equal(out[0], 'G21 G90 G0 Z25');
  assert.deepEqual(out.slice(3, 8), expectedEntry(60, 25));
  assert.equal(out[8], lineText(60));
  assert.equal(env.job().lineOffset, '51');
  assert.equal(env.cursor, 60);
});

test('button: the editor is scrolled to the start line, but NO tab is switched (not GCODE Editor, not Log) and the editor takes no focus', () => {
  const env = go(120);
  assert.equal(env.cursor, 110);
  assert.deepEqual(env.tabs, [], 'no tab was clicked at all - the 3D View was already showing');
  assert.ok(!env.tabs.includes('#gcodeeditortab') && !env.tabs.includes('#consoletab'));
  assert.equal(env.focused, 0, 'no keyboard focus is taken from the 3D View');
});

test('button: opening the dialog does not switch tabs either', () => {
  const env = open(120);
  assert.deepEqual(env.tabs, []);
  assert.equal(env.focused, 0);
  assert.equal(env.cursor, 110, 'it only scrolls the editor');
});

// --- the 3D View: to be able to watch the first moves and press Stop

test('3D View: already showing -> nothing is clicked', () => {
  const env = go(120);
  assert.deepEqual(env.tabs, []);
});

test('3D View: the user is on another tab (e.g. the right-click started from the GCODE Editor) -> the view goes TO the 3D View', () => {
  const env = open(120);
  env.viewerActive = false; // the GCODE Editor tab is showing, the sub-tabs are visible
  assert.ok(env.clickStart());
  assert.deepEqual(env.tabs, ['#gcodeviewertab']);
  assert.equal(env.viewerActive, true);
});

test('3D View: Machine Control itself is not showing -> it is brought up first, then the 3D View', () => {
  const env = open(120);
  env.viewerVisible = false;
  env.viewerActive = false;
  assert.ok(env.clickStart());
  assert.deepEqual(env.tabs, ['#controlTab', '#gcodeviewertab']);
});

test('3D View: no WebGL (no 3D View on this computer) -> the tab is left alone, never sent to the console', () => {
  const env = open(120, { webgl: false });
  env.viewerVisible = false; env.viewerActive = false;
  assert.ok(env.clickStart());
  assert.deepEqual(env.tabs, []);
  assert.equal(env.posted.length, 1, 'the job still starts');
});

test('3D View: it is shown AFTER the job was sent, and never before the checks pass (a refused start switches nothing)', () => {
  const env = open(120, { status: 0 });
  env.viewerActive = false;
  env.startButton().onclick(); // called directly: the machine is not connected
  assert.deepEqual(env.tabs, []);
  assert.equal(env.posted.length, 0);
});

// --- everything is checked again at the click, before anything is sent

test('button: the machine state is re-checked AT THE CLICK - it changed to "running" after the dialog was opened', () => {
  const env = open(120);
  env.setStatus(3); // no refresh tick in between: only the click's own check can catch this
  env.startButton().onclick();
  assert.equal(env.posted.length, 0, 'nothing sent');
  assert.match(env.logs.join(' '), /Not started: .*Mesin belum terhubung/);
});

test('button: the start line is re-validated at the click too', () => {
  const env = open(120);
  env.vals['#recoveryStartLine'] = '0';
  env.startButton().onclick();
  assert.equal(env.posted.length, 0);
  env.vals['#recoveryStartLine'] = '999';
  env.startButton().onclick();
  assert.equal(env.posted.length, 0);
  env.vals['#recoveryStartLine'] = '110';
  env.vals['#recoverySafeZ'] = '9999';
  env.startButton().onclick();
  assert.equal(env.posted.length, 0);
});

test('button: an unresumable start line (no feed rate anywhere before it) sends nothing, even if the handler is called directly', () => {
  const l = ['G21', 'G1 X1', 'G1 X2', 'G1 X3', 'G1 X4'];
  const text = l.join('\n');
  const env = makeEnv({ text });
  env.ctx.showStartFromLine(1, 'manual');
  env.type(3);
  env.ctx.recoveryStartRun({ facts: env.ctx.recoveryFileFacts(l), total: 5, lines: l, text, fileName: 'part.nc' });
  assert.equal(env.posted.length, 0, 'nothing sent');
  assert.match(env.logs.join(' '), /Not started: .*Tidak ada kata F/);
});

test('button: the program changed while the dialog was open -> nothing is sent', () => {
  const env = open(120);
  env.text = PROGRAM.join('\n') + '\nG0 X0';
  env.startButton().onclick();
  assert.equal(env.posted.length, 0);
  assert.match(env.logs.join(' '), /the program changed since this dialog was opened\. Nothing was sent/);
});

test('button: another file was loaded while the dialog was open (even with the same text) -> nothing is sent', () => {
  const env = open(120);
  env.loadedName = 'other.nc';
  env.startButton().onclick();
  assert.equal(env.posted.length, 0);
  assert.match(env.logs.join(' '), /Nothing was sent/);
});

test('button: a double click sends the job ONCE; a genuine second start (after 3 s) is possible', () => {
  const env = open(120);
  env.startButton().onclick();
  env.startButton().onclick();
  assert.equal(env.posted.length, 1, 'the second click of a double click is ignored');
  assert.equal(env.timers[env.timers.length - 1].ms, 3000);
  env.flush();
  env.startButton().onclick();
  assert.equal(env.posted.length, 2);
});

test('button: a refused start does not take the double-click lock', () => {
  const env = open(120);
  env.setStatus(3);
  env.startButton().onclick();
  env.setStatus(1);
  env.startButton().onclick();
  assert.equal(env.posted.length, 1, 'the refused click did not block the real one');
});

test('button: the start-inside-the-opening-lines case still gets the raise first, then the whole file', () => {
  const env = open(2, { text: PROGRAM.join('\n') }); // suggested line 1
  env.type(3);
  assert.ok(env.clickStart());
  const out = lines(env.job().body);
  assert.equal(out[0], PRE15);
  assert.deepEqual(out.slice(1), PROGRAM);
  assert.equal(env.job().lineOffset, '0');
});

test('button: very large files (the global gcode holds the text) work the same way', () => {
  const big = PROGRAM.join('\n');
  const env = makeEnv({ text: 'File part.nc is too large to load into the editor', gcode: big });
  env.ctx.showStartFromLine(120, 'recovery');
  assert.match(env.dlg().content, /total <b>200<\/b> baris/);
  assert.ok(env.clickStart());
  const out = lines(env.job().body);
  assert.equal(out[0], PRE15);
  assert.deepEqual(out.slice(3, 8), expectedEntry(110, 15));
  assert.equal(out[8], lineText(110));
  assert.equal(env.job().lineOffset, '101');
});

test('button: on the real-job shape (arcs, no spaces, spindle after the first moves) the first thing after the opening lines is NOT an arc', () => {
  const text = arcs().join('\n');
  const env = makeEnv({ text });
  env.ctx.showStartFromLine(1, 'manual');
  env.type(22, 10);
  assert.ok(env.clickStart());
  const out = lines(env.job().body);
  assert.deepEqual(out.slice(0, 10), ['G21 G90 G0 Z30', 'T1', 'G17', 'G21', 'G90', 'G0 Z30', 'M3 S16000', 'G0 X10.263 Y11.576', 'G1 Z-4.365 F150.0', 'F800.0']);
  assert.equal(out[10], 'G3X9.263Y10.576I0.000J-1.000');
});

// --- what the dialog says before the final click

test('dialog: a red-orange warning says the machine moves IMMEDIATELY - it sits above the button, with the safety note', () => {
  const html = open(120).dlg().content;
  assert.match(html, /<div class="recovery-start-warn" role="alert"><b>Mesin akan LANGSUNG bergerak begitu tombol di bawah diklik:<\/b> Z naik, spindle menyala, gerak cepat ke titik awal, turun, lalu memotong dari baris yang dipilih\. Pantau di 3D View dan siap menekan Stop\.<\/div>/);
  assert.ok(html.indexOf('recovery-start-warn') > html.indexOf('id="recoveryStartMessages"'), 'after the preview of what will run');
  assert.ok(html.indexOf('Pastikan mesin sudah di-Home dan Set Zero ulang') > html.indexOf('recovery-start-warn'));
  assert.ok(!/Run berikutnya|Run baris|tekan Run|klik Run/.test(html), 'no mention of a separate Run step');
});

test('dialog: the preview of what will run is still shown (it must be reviewed BEFORE the final click)', () => {
  const env = open(120);
  const m = env.htmlOf['#recoveryStartMessages'];
  assert.match(m, /Urutan \(mm\): <b>Z15<\/b> &rarr; <b>M3 S12000<\/b> &rarr; <b>X109 Y4<\/b> &rarr; <b>Z-1 \(F300\)<\/b> &rarr; <b>F800<\/b> &rarr; baris <b>110<\/b>/);
});

// ============================================================ nothing is left armed - the mechanism is gone

test('gone: no armed Run, no label on the Run button, no guard in any Run path, no pop-up', () => {
  const removed = ['recoveryArmRun', 'recoveryDisarm', 'recoverySubmitArmedRun', 'recoverySetRunLabel', 'recoveryArmed', 'recoveryChangeHandler', 'recoveryRunCaption',
    'RECOVERY_ARMED_ID', 'recoveryArmedNotice', 'recoveryArmedCancel', 'recovery-armed', 'Run berikutnya', 'RECOVERY_DIALOG_HANDOFF_MS'];
  for (const [name, src] of [['resume.js', RESUME], ['main.js', MAIN], ['keyboard.js', KEYBOARD], ['toolchange.js', TOOLCHANGE], ['main.css', CSS]]) {
    for (const word of removed) assert.ok(!src.includes(word), name + ' still contains ' + word);
  }
  assert.match(MAIN, /function runJobFile\(\) \{\n  if \(gcode\) \{/, 'the Run button is the plain original');
  assert.match(extractFunction(TOOLCHANGE, 'runGcodeSection'), /console\.log\(newGcodeString\)\n  socket\.emit\('runJob'/);
});

test('gone: the editor is never switched to and never focused by this feature', () => {
  assert.ok(!/gcodeeditortab|consoletab|\.focus\(/.test(RESUME), 'resume.js touches neither the GCODE Editor tab, the Log tab, nor focus');
  const show = extractFunction(RESUME, 'recoveryShowLine');
  assert.equal(show.replace(/\/\/[^\n]*\n/g, ''), "function recoveryShowLine(line) {\n  editor.gotoLine(Math.min(line, editor.session.getLength()));\n}");
});

// ============================================================ server side

test('server: /runjob accepts a validated lineOffset and passes it to runJob', () => {
  assert.match(INDEX_JS, /var recoveryLineOffset = \(req\.body && typeof req\.body\.lineOffset === 'string' && \/\^\\d\{1,9\}\$\/\.test\(req\.body\.lineOffset\)\) \? parseInt\(req\.body\.lineOffset, 10\) : 0;/);
  assert.match(INDEX_JS, /fileName: recoveryFileName,\s*lineOffset: recoveryLineOffset,\s*\}\s*runJob\(object\)/);
});

test('server: the payload with its raise line - the recorded resume line is a line of the ORIGINAL file (also through the inserted lines)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createJobRecovery, RECOVERY_FILENAME } = require('../jobRecovery');
  const p = makeEnv().ctx.recoveryRunPayload(PROGRAM.join('\n'), 85, 15, { inch: false }, PRE15); // 1 raise + 2 opening + 5 entry + file lines 85..200
  const payload = lines(p.text);
  const n = payload.length;
  assert.equal(p.preLines, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-startline-'));
  const state = { q: 0, t: 1e6 };
  const rec = createJobRecovery({ getDir: () => dir, getFirstUnackedQ: () => state.q, getPlannerBlocks: () => 0, now: () => state.t, log() {}, autoTimer: false });
  // what runJob() records: queue index = payload line - 1 (every line is a command here)
  const marks = Array.from({ length: n }, (_, i) => ({ q: i, line: i + 1 }));
  rec.begin({ fileName: 'part.nc', lineOffset: p.lineOffset, lineCount: n, marks });
  const saved = () => JSON.parse(fs.readFileSync(path.join(dir, RECOVERY_FILENAME), 'utf8'));
  const firstFileLine = p.preLines + p.headerLines + p.entryLines;
  for (const q of [firstFileLine, firstFileLine + 1, 40, n - 1]) {
    state.q = q;
    state.t += 5000; // past the write throttle
    rec.tick();
    assert.equal(lineText(saved().resumeLine), payload[q], 'payload entry ' + q + ' -> file line ' + saved().resumeLine);
  }
  for (const q of [0, 1, 2, 3, p.preLines + p.headerLines + 3]) { // interrupted inside the inserted lines: an EARLIER line, never a later one
    state.q = q;
    state.t += 5000;
    rec.tick();
    assert.ok(saved().resumeLine <= 85, 'an interruption in the raise / opening / entry lines resumes at or before the start line (' + saved().resumeLine + ')');
  }
  assert.equal(saved().totalLines, 200, 'and the total stays the original file length');
});

test('payload: with a raise line the offset accounts for it; without one nothing changes', () => {
  const ctx = makeEnv().ctx;
  const withPre = ctx.recoveryRunPayload(PROGRAM.join('\n'), 110, 15, { inch: false }, PRE15);
  const without = ctx.recoveryRunPayload(PROGRAM.join('\n'), 110, 15, { inch: false });
  assert.equal(lines(withPre.text)[0], PRE15);
  assert.equal(lines(withPre.text).length, lines(without.text).length + 1);
  assert.equal(withPre.lineOffset, without.lineOffset - 1);
  assert.equal(withPre.preLines, 1);
  assert.equal(without.preLines, 0);
  const whole = ctx.recoveryRunPayload(PROGRAM.join('\n'), 2, 15, { inch: false }, PRE15);
  assert.deepEqual(lines(whole.text), [PRE15, ...PROGRAM]);
  assert.equal(whole.lineOffset, 0, 'clamped: the recorded lines are at worst one line late, before anything was cut');
});

// ============================================================ visuals

const cssRule = (sel) => {
  const i = CSS.lastIndexOf('\n' + sel + ' {'); // the standalone rule (a grouped rule may end with the same selector)
  assert.notEqual(i, -1, 'cannot find CSS rule ' + sel);
  return CSS.slice(i, CSS.indexOf('}', i));
};
const cssProp = (rule, prop) => (rule.match(new RegExp('(?:^|[\\s;{])' + prop + ':\\s*([^;!]+)')) || [])[1];
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('visual: the error boxes and the note have SOLID backgrounds and AA text contrast', () => {
  for (const sel of ['.recovery-start-error', '.recovery-start-warn', '.recovery-start-note']) {
    const r = cssRule(sel);
    const bg = cssProp(r, 'background-color').trim();
    const fg = cssProp(r, 'color').trim();
    assert.match(bg, /^#[0-9a-f]{6}$/i, sel + ' solid colour');
    assert.ok(contrast(fg, bg) >= 4.5, sel + ' contrast ' + contrast(fg, bg).toFixed(1));
  }
  assert.match(CSS, /\.recovery-start-button:disabled \{[^}]*not-allowed/, 'a disabled start button looks disabled');
});

// ============================================================ what stayed out

test('not rebuilt: no entry position, no spindle search, no program rewrite, no gate, no rename', () => {
  const gone = ['recoveryArmRun', 'recoverySubmitArmedRun', 'redoJob', 'resumeXYA', 'resumeZm', 'resumeSpindle', 'resumeLastLine', 'foundSpindle', 'lineFmin', 'lineFmax', 'GcodeLineXYA', 'recoveryPlanRaiseZ',
    'RECOVERY_ACK_ID', 'confirmRecoveredRun', 'recoveryRecoveredName', '(recovered)', 'Recover Job From Line Number', 'runJobFileNow'];
  for (const [name, src] of [['resume.js', RESUME], ['main.js', MAIN], ['keyboard.js', KEYBOARD], ['toolchange.js', TOOLCHANGE]]) {
    for (const word of gone) assert.ok(!src.includes(word), name + ' still contains ' + word);
  }
  // the program in the editor is never rewritten by this feature
  const feature = ['showStartFromLine', 'recoveryStartRun', 'recoverySendJob', 'recoveryShow3DView', 'startFromHere', 'recoveryRunPayload']
    .map((n) => extractFunction(RESUME, n)).join('\n');
  assert.ok(!/setValue|parseGcodeInWebWorker/.test(feature));
});

test('kept: the right-click item still calls startFromHere, the ribbon still calls recoverCrashedJob', () => {
  const html = read('app/index.html');
  assert.match(html, /onclick="startFromHere\(editor\.getSelectionRange\(\)\.start\.row \+ 1\);"[^>]*>[^]*?Recover job from Line/);
  assert.match(html, /id="recoverJobBtn"[^>]*onclick="recoverCrashedJob\(\);"/);
});

// ============================================================ compact dialog (the action button must stay on screen)

test('compact: the entry sequence is ONE dense line, always visible (no collapsed/hidden part), and the old wordy text is gone', () => {
  const env = open(120);
  const m = env.htmlOf['#recoveryStartMessages'];
  assert.equal((m.match(/Urutan \(mm\):/g) || []).length, 1);
  assert.ok(!/Urutan sebelum baris|Z akan naik ke/.test(m), 'no second sentence repeating where Z goes');
  assert.ok(!/<details|display:\s*none|hidden/.test(env.dlg().content + m), 'nothing the user must see is hidden behind a toggle');
  const html = env.dlg().content;
  assert.ok(!/rinciannya tampil|dikirim ulang lebih dulu/.test(html), 'the explanatory paragraph under the Home/Set Zero note is gone');
  assert.ok(html.includes('Pastikan mesin sudah di-Home dan Set Zero ulang sebelum melanjutkan.'), 'the safety note stays');
  assert.ok(html.includes('recovery-start-warn'), 'the orange warning stays');
});

test('compact: the dialog body scrolls on a short screen so the action button stays visible', () => {
  const env = open(120);
  assert.equal(env.dlg().clsContent, 'recovery-start-content');
  const css = read('app/css/main.css');
  assert.match(css, /\.recovery-start-content \{\s*max-height: calc\(100vh - \d+px\);\s*overflow-y: auto;/);
});

test('compact: no "other file" block in any source, and the function no longer takes it', () => {
  assert.ok(!/otherFile/.test(RESUME));
  assert.ok(!/Ada data job tersimpan untuk file lain/.test(RESUME));
});
