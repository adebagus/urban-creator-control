// End-to-end tests for the ribbon "Start from Line" button (formerly "Recover Job") and the "Lanjutkan dari Baris" dialog it opens,
// with the REAL functions from resume.js, main.js and toolchange.js in a vm sandbox
// (test/helpers/recovery-env.js).
//
// THE POINT: the dialog's final button STARTS THE MACHINE as one job - Z up, spindle, rapid to where the
// start line begins, plunge, then the file from the start line on - and that job starts at the
// SAVED position (a few lines before it), NOT at line 1. There is no second "Run" click. The
// automatic notifications (banner, app-start modal) only INFORM: they cannot open this dialog.
// These tests capture what the final click would POST to /runjob.
// (The dialog itself is tested in start-from-line.test.js, the notifications in reconnect-recovery-offer.test.js.)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeEnv, PROGRAM, lineText, expectedEntry, ARC_PROGRAM, info, RESUME, MAIN, extractFunction, read } = require('./helpers/recovery-env');

const lines = (text) => text.split('\n');
const START = 110; // saved line 120 - 10

// The whole point, as an assertion: the job starts at the start line, not at line 1 - and gets there in a way
// the controller accepts: the raise, the file's opening lines, then Z up / spindle / rapid to where the start
// line begins / plunge / feed, and only then the start line itself.
function assertJobStartsAt(job, start, safeZ = 15) {
  assert.ok(job, 'a job was sent');
  const out = lines(job.body);
  assert.equal(out[0], 'G21 G90 G0 Z' + safeZ, 'the raise is the first line');
  assert.deepEqual(out.slice(1, 3), ['G21 G90 G54', 'M3 S12000'], 'the file\'s opening lines next (units, mode, offset, spindle)');
  assert.deepEqual(out.slice(3, 8), expectedEntry(start, safeZ), 'then the entry');
  assert.equal(out[8], lineText(start), 'then the start line ' + start + ': ' + lineText(start));
  assert.equal(out[out.length - 1], lineText(200), 'to the end of the file');
  for (const n of [6, 7, 20, 50, start - 2].filter((k) => k > 5 && k < start)) assert.ok(!out.includes(lineText(n)), 'the already-finished line ' + n + ' must NOT be sent: ' + lineText(n));
  assert.ok(out.length < PROGRAM.length + 6, 'not the whole file');
  assert.equal(job.lineOffset, String(start - 1 - 2 - 5 - 1), 'lineOffset keeps the server\'s record in original file lines');
}

// ===================================================================================
// End to end: "Recover Job" -> dialog (pre-filled) -> "Mulai dari Baris Ini" -> Run
// ===================================================================================

test('END TO END (file already loaded): Recover Job -> dialog pre-filled with X-10 -> ONE click -> the job runs from that line, NOT line 1', () => {
  const env = makeEnv();
  env.ctx.recoverJob(info());
  assert.equal(env.dialogs.length, 1);
  assert.match(env.dlg().title, /Lanjutkan dari Baris/);
  assert.equal(env.prefill().start, START, 'pre-filled with the recommendation');
  assert.equal(env.posted.length, 0, 'nothing has been sent by opening the dialog');
  assert.ok(env.clickStart());
  assert.equal(env.posted.length, 1, 'one click - one job');
  assert.deepEqual(env.gcodeSent, [], 'no separate Z command');
  assertJobStartsAt(env.job(), START);
});

test('END TO END (no program loaded): the button says "open a G-code file first" - no dialog and NO file picker; after loading a file the same button opens the dialog and ONE click runs the job', () => {
  const env = makeEnv({ text: '', loadedName: '', ack: info() });
  env.ctx.recoverCrashedJob();
  assert.equal(env.dialogs.length, 1);
  assert.match(env.dlg().title, /Buka file G-code dulu/);
  assert.match(env.dlg().content, /Ada data job tersimpan untuk file: <b>part\.nc<\/b>/, 'and it names the saved job\'s file');
  assert.equal(env.picker, 0, 'the file picker is NOT opened');
  assert.equal(env.posted.length, 0);
  env.pickFile('part.nc'); // the user opens the file themselves
  env.ctx.recoverCrashedJob();
  assert.match(env.dlg().title, /Lanjutkan dari Baris/);
  assert.equal(env.prefill().start, START);
  env.clickStart();
  assertJobStartsAt(env.job(), START);
});

test('END TO END (ribbon button): asks the server, then behaves the same', () => {
  const env = makeEnv({ ack: info() });
  env.ctx.recoverCrashedJob();
  assert.deepEqual(env.emits, ['getRecoveryInfo']);
  assert.equal(env.prefill().start, START);
  env.clickStart();
  assertJobStartsAt(env.job(), START);
});

test('END TO END (GCODE Editor right-click): the same dialog, pre-filled from the chosen line minus 10 - and the 3D View is shown', () => {
  const env = makeEnv();
  env.ctx.startFromHere(90);
  assert.equal(env.prefill().start, 80);
  env.viewerActive = false; // the right-click menu lives in the GCODE Editor tab
  env.clickStart();
  assertJobStartsAt(env.job(), 80);
  assert.deepEqual(env.tabs, ['#gcodeviewertab'], 'the view went TO the 3D View');
});

test('END TO END: the user may edit the start line - the job follows what they typed, not the recommendation', () => {
  const env = makeEnv();
  env.ctx.recoverJob(info());
  env.type(40, 12);
  env.clickStart();
  assertJobStartsAt(env.job(), 40, 17);
});

test('END TO END (a real CAM-shaped job: arcs, no spaces, spindle after the first moves): the machine is never handed a bare arc', () => {
  const text = ARC_PROGRAM.join('\n');
  const env = makeEnv({ text });
  env.ctx.recoverJob(info({ resumeLine: 32, totalLines: 33 }));
  assert.equal(env.prefill().start, 22, 'saved line 32 - 10');
  assert.ok(env.clickStart());
  const out = lines(env.job().body);
  // the raise, the opening lines, Z up again, spindle ON (it is written after the first moves in this file), the rapid to
  // where line 22 begins, the plunge at the slowest feed, the cutting feed - and only then the arc
  assert.deepEqual(out.slice(0, 10), ['G21 G90 G0 Z30', 'T1', 'G17', 'G21', 'G90', 'G0 Z30', 'M3 S16000', 'G0 X10.263 Y11.576', 'G1 Z-4.365 F150.0', 'F800.0']);
  assert.equal(out[10], 'G3X9.263Y10.576I0.000J-1.000');
  assert.ok(!/^G[23]/.test(out[5]) && !/^G[23]/.test(out[6]), 'nothing before the entry is a motion');
});

// --- the automatic notifications cannot start any of this

test('the notifications only inform: neither the banner nor the app-start modal has anything that opens the dialog or starts a job', () => {
  const banner = makeEnv();
  banner.ctx.showRecoveryBanner(info());
  assert.ok(banner.banner);
  assert.deepEqual(Object.keys(banner.handlers), ['#recoveryBannerClose']);
  banner.handlers['#recoveryBannerClose'].click();
  assert.equal(banner.banner, null);
  assert.equal(banner.dialogs.length, 0);
  assert.equal(banner.posted.length, 0);

  const modal = makeEnv();
  modal.ctx.showRecoveryOffer(info());
  modal.flush();
  assert.equal(modal.dialogs.length, 1);
  assert.equal(Array.from(modal.dlg().actions, (a) => a.caption).join(), 'Tutup / Close');
  modal.dlg().actions[0].onclick();
  modal.dlg().onClose();
  modal.flush();
  assert.equal(modal.dialogs.length, 1, 'closing opens nothing');
  assert.equal(modal.posted.length, 0);
  assert.deepEqual(modal.emits, [], 'and asks the server for nothing - the saved job is kept');
});

test('the ribbon Recover Job button is the deliberate way in - it still works after a notification was closed', () => {
  const env = makeEnv({ ack: info() });
  env.ctx.showRecoveryBanner(info());
  env.handlers['#recoveryBannerClose'].click();
  env.ctx.recoverCrashedJob();
  assert.equal(env.prefill().start, START);
  env.clickStart();
  assertJobStartsAt(env.job(), START);
});

test('the control: the old behaviour (only scroll the editor) would make Run start from line 1', () => {
  const env = makeEnv();
  env.ctx.recoveryShowLine(START); // scroll only, nothing armed
  const post = env.run();
  assert.equal(lines(post.body)[0], 'G21 G90 G54');
  assert.equal(lines(post.body).length, PROGRAM.length, 'the whole file');
  assert.equal(post.lineOffset, undefined);
});

test('the ribbon button sends nothing until the final button is clicked - at every earlier step', () => {
  for (const loaded of [true, false]) {
    const env = makeEnv(loaded ? {} : { text: '', loadedName: '' });
    env.ctx.recoverJob(info());
    if (!loaded) { env.pickFile('part.nc'); env.ctx.recoverJob(info()); }
    assert.equal(env.posted.length, 0, 'nothing POSTed to /runjob before the click (loaded=' + loaded + ')');
    assert.deepEqual(env.gcodeSent, []);
    assert.ok(!env.emits.some((e) => /runJob|runCommand|stop|pause|resume/i.test(e)), env.emits.join());
    env.clickStart();
    assert.equal(env.posted.length, 1);
  }
});

// ===================================================================================
// Loading the file
// ===================================================================================

// THE BUG this replaces: a saved record for a file whose name differs from the loaded one (another file, an older
// session, or a name that only differs by a space - the real case was "Endcap HGR  Bawah ..." with two spaces)
// made the button open the FILE PICKER instead of the dialog. Now the dialog always opens.
test('ribbon: a saved job that belongs to ANOTHER file (or a differently spelled name) opens the dialog - never the file picker', () => {
  for (const [loaded, saved] of [['other.nc', 'part.nc'], ['Endcap HGR Bawah single 3mm.gcode', 'Endcap HGR  Bawah single 3mm.gcode'], ['part.NC', 'part.nc'], ['part.nc ', 'part.nc']]) {
    const env = makeEnv({ loadedName: loaded, ack: info({ fileName: saved }) });
    env.ctx.recoverCrashedJob();
    assert.equal(env.picker, 0, 'no file picker for ' + JSON.stringify([loaded, saved]));
    assert.equal(env.dialogs.length, 1);
    assert.match(env.dlg().title, /Lanjutkan dari Baris/);
    assert.match(env.dlg().content, /Anda bebas mulai dari baris mana pun/, 'the user chooses the line');
    assert.ok(!/terhenti/.test(env.dlg().content), 'the other file\'s crash is not presented as this file\'s');
    assert.equal(env.prefill().start, 1, 'not the other file\'s saved line');
    assert.ok(env.dlg().content.includes('Ada data job tersimpan untuk file lain (<b>' + saved.replace(/&/g, '&amp;') + '</b>). Tidak dipakai karena file yang dimuat berbeda.'), 'and it says so');
  }
});

test('ribbon: the dialog then works normally - the user types a line and ONE click runs it', () => {
  const env = makeEnv({ loadedName: 'other.nc', ack: info() });
  env.ctx.recoverCrashedJob();
  env.type(40, 12);
  assert.ok(env.clickStart());
  assertJobStartsAt(env.job(), 40, 17);
});

test('ribbon: a saved job for the LOADED file is used (saved line - 10), with no "other file" note', () => {
  const env = makeEnv({ loadedName: 'part.nc', ack: info() });
  env.ctx.recoverCrashedJob();
  assert.equal(env.picker, 0);
  assert.equal(env.prefill().start, START);
  assert.match(env.dlg().content, /Pekerjaan Anda \(total <b>200<\/b> baris\) terhenti sekitar baris <b>120<\/b>/);
  assert.ok(!/file lain/.test(env.dlg().content));
});

test('ribbon: EVERY situation with a program loaded opens the SAME dialog and never the file picker', () => {
  const answers = [null, undefined, {}, info(), info({ state: 'stopped' }), info({ state: 'interrupted' }), info({ fileName: '' }), info({ fileName: 'other.nc' }), info({ resumeLine: 0 }), info({ resumeLine: 900 })];
  for (const ack of answers) {
    const env = makeEnv({ ack });
    env.ctx.recoverCrashedJob();
    assert.equal(env.picker, 0, 'picker for ' + JSON.stringify(ack));
    assert.equal(env.dialogs.length, 1, JSON.stringify(ack));
    assert.match(env.dlg().title, /Lanjutkan dari Baris/, JSON.stringify(ack));
    assert.equal(env.startButton().caption, 'Mulai dari Baris Ini / Start from Line');
  }
  const silent = makeEnv({ ack: 'never' });
  silent.ctx.socket.emit = () => {};
  silent.ctx.recoverCrashedJob();
  silent.timers[0].fn();
  assert.equal(silent.picker, 0);
  assert.match(silent.dlg().title, /Lanjutkan dari Baris/);
});

test('the file picker is never opened by this feature at all', () => {
  assert.ok(!/#file/.test(RESUME), "resume.js has no reference to the file input ('#file')");
  assert.ok(!/recoveryPendingOpen|recoveryFileOpened|RECOVERY_OPEN_WINDOW_MS/.test(RESUME + MAIN), 'the wait-for-a-file machinery is gone');
});

test('a record without a file name uses whatever is loaded', () => {
  const env = makeEnv({ loadedName: 'anything.nc' });
  env.ctx.recoverJob(info({ fileName: '' }));
  assert.equal(env.picker, 0);
  assert.equal(env.prefill().start, START);
});

test('a saved line beyond the loaded file shows the wrong-file warning and pre-fills inside the file', () => {
  const env = makeEnv();
  env.ctx.recoverJob(info({ resumeLine: 900 }));
  assert.equal(env.prefill().start, 200);
  assert.match(env.dlg().content, /melebihi panjang file/);
});

test('an unusable record is treated as "no saved job": the manual dialog opens (file loaded) or "open a file first" (no file)', () => {
  for (const bad of [null, undefined, {}, info({ resumeLine: 0 }), info({ resumeLine: 'x' })]) {
    const env = makeEnv();
    env.ctx.recoverJob(bad);
    assert.match(env.dlg().title, /Lanjutkan dari Baris/, JSON.stringify(bad));
    assert.match(env.dlg().content, /Anda bebas mulai dari baris mana pun/);
    const empty = makeEnv({ text: '', loadedName: '' });
    empty.ctx.recoverJob(bad);
    assert.match(empty.dlg().title, /Buka file G-code dulu/, JSON.stringify(bad));
  }
});

// ===================================================================================
// The ribbon button works with or without a saved job
// ===================================================================================

test('ribbon, NO saved job, file loaded: the SAME "Lanjutkan dari Baris" dialog opens - it is not blocked', () => {
  for (const noRecord of [null, undefined, {}, info({ resumeLine: 0 })]) {
    const env = makeEnv({ ack: noRecord });
    env.ctx.recoverCrashedJob();
    assert.deepEqual(env.emits, ['getRecoveryInfo']);
    assert.equal(env.dialogs.length, 1);
    assert.match(env.dlg().title, /Lanjutkan dari Baris/);
    assert.match(env.dlg().title, /Start From Line/);
    assert.equal(env.startButton().caption, 'Mulai dari Baris Ini / Start from Line');
    assert.ok(!/Tidak ada job tersimpan/.test(env.dlg().title + env.dlg().content));
  }
});

test('ribbon, NO saved job: the start line is the line the user is at in the editor, else 1 - not the crash "-10"; Safe Height still 10', () => {
  const plain = makeEnv({ ack: null });
  plain.ctx.recoverCrashedJob();
  assert.deepEqual(plain.prefill(), { start: 1, safe: 10 }, 'nothing scrolled or clicked: line 1');

  const clicked = makeEnv({ ack: null });
  clicked.selRow = 59; // the cursor is on line 60
  clicked.ctx.recoverCrashedJob();
  assert.equal(clicked.prefill().start, 60, 'exactly the line - no step back');

  const scrolled = makeEnv({ ack: null });
  scrolled.topRow = 119; // scrolled so line 120 is at the top, cursor untouched
  scrolled.ctx.recoverCrashedJob();
  assert.equal(scrolled.prefill().start, 120);

  const both = makeEnv({ ack: null });
  both.selRow = 9; both.topRow = 99;
  both.ctx.recoverCrashedJob();
  assert.equal(both.prefill().start, 10, 'a clicked cursor wins over the scroll position');

  const beyond = makeEnv({ ack: null });
  beyond.selRow = 999;
  beyond.ctx.recoverCrashedJob();
  assert.equal(beyond.prefill().start, 200, 'clamped to the file');
});

test('ribbon, NO saved job: the dialog says the user is free to start anywhere - and gives no crash recommendation', () => {
  const env = makeEnv({ ack: null });
  env.ctx.recoverCrashedJob();
  const html = env.dlg().content;
  assert.ok(html.includes('File ini punya <b>200</b> baris. Anda bebas mulai dari baris mana pun.'));
  assert.ok(!/terhenti|Disarankan|Anda memilih/.test(html), 'no "job stopped" text and no recommendation');
  assert.ok(html.includes('Pastikan mesin sudah di-Home dan Set Zero ulang sebelum melanjutkan.'), 'the safety note stays');
  assert.match(html, /id="recoverySafeZ"[^]*?value="10"/);
});

test('ribbon, NO saved job: the user can type ANY line and press Start - the job then starts there, not at line 1', () => {
  const env = makeEnv({ ack: null });
  env.ctx.recoverCrashedJob();
  env.type(40, 12);
  assert.ok(env.clickStart());
  assert.deepEqual(env.gcodeSent, [], 'no separate Z command');
  assert.equal(env.posted.length, 1, 'the one click started the job');
  assertJobStartsAt(env.job(), 40, 17);
});

test('ribbon, NO saved job: an invalid or empty line keeps the button disabled, like every other path', () => {
  const env = makeEnv({ ack: null });
  env.ctx.recoverCrashedJob();
  env.type('');
  assert.equal(env.disabled['.recovery-start-button'], true);
  env.type('999');
  assert.equal(env.disabled['.recovery-start-button'], true);
  env.type('1');
  assert.equal(env.disabled['.recovery-start-button'], false);
});

test('ribbon, NO saved job and NO program loaded: ONLY then the message "Buka file G-code dulu" (a clear fallback, not the default)', () => {
  for (const text of ['', '   ', '\n\n']) {
    const env = makeEnv({ ack: null, text, loadedName: '' });
    env.ctx.recoverCrashedJob();
    assert.equal(env.dialogs.length, 1);
    assert.match(env.dlg().title, /Buka file G-code dulu/);
    assert.match(env.dlg().title, /Open a G-code file first/);
    assert.match(env.dlg().content, /Buka file G-code dulu, lalu klik Start from Line lagi/);
    assert.ok(!/Ada data job tersimpan/.test(env.dlg().content), 'nothing saved to mention');
    assert.equal(env.dlg().actions.length, 1);
    assert.equal(env.dlg().actions[0].caption, 'Tutup / Close');
    assert.ok(!/Lanjutkan dari Baris/.test(env.dlg().title), 'no start dialog without a program');
    assert.equal(env.picker, 0, 'and still no file picker');
  }
});

test('ribbon, saved job PRESENT and NO program loaded: the message names the saved job\'s file - no picker', () => {
  const env = makeEnv({ ack: info(), text: '', loadedName: '' });
  env.ctx.recoverCrashedJob();
  assert.equal(env.picker, 0);
  assert.equal(env.dialogs.length, 1);
  assert.match(env.dlg().title, /Buka file G-code dulu/);
  assert.ok(env.dlg().content.includes('Ada data job tersimpan untuk file: <b>part.nc</b>.'));
  const escaped = makeEnv({ ack: info({ fileName: '<img src=x onerror=alert(1)>.nc' }), text: '', loadedName: '' });
  escaped.ctx.recoverCrashedJob();
  assert.ok(!/<img/i.test(escaped.dlg().content));
});

test('ribbon, saved job PRESENT: the scroll position of the editor does not change the recovery pre-fill', () => {
  const env = makeEnv({ ack: info() });
  env.selRow = 59; env.topRow = 30;
  env.ctx.recoverCrashedJob();
  assert.equal(env.prefill().start, 110);
});

test('ribbon: a silent server (2 s) or no socket -> the manual dialog, not a dead button; a late answer is ignored', () => {
  const env = makeEnv({ ack: 'never' });
  let late;
  env.ctx.socket.emit = (ev, cb) => { late = cb; };
  env.ctx.recoverCrashedJob();
  assert.equal(env.dialogs.length, 0);
  assert.equal(env.timers[0].ms, 2000);
  env.timers[0].fn();
  assert.equal(env.dialogs.length, 1);
  assert.match(env.dlg().title, /Lanjutkan dari Baris/);
  assert.match(env.dlg().content, /Anda bebas mulai dari baris mana pun/);
  late(info());
  assert.equal(env.dialogs.length, 1, 'the late answer does not open a second dialog');

  const noSocket = makeEnv();
  noSocket.ctx.socket = undefined;
  noSocket.ctx.recoverCrashedJob();
  assert.match(noSocket.dlg().title, /Lanjutkan dari Baris/);

  const noSocketNoFile = makeEnv({ text: '', loadedName: '' });
  noSocketNoFile.ctx.socket = undefined;
  noSocketNoFile.ctx.recoverCrashedJob();
  assert.match(noSocketNoFile.dlg().title, /Buka file G-code dulu/);
});

test('both ways (ribbon and right-click) open the very same dialog - only the pre-fill differs', () => {
  const ribbon = makeEnv({ ack: null });
  ribbon.ctx.recoverCrashedJob();
  const menu = makeEnv();
  menu.ctx.startFromHere(50);
  const strip = (h) => h.replace(/value="\d+"/g, 'value="N"').replace(/<div class="remark info">[^]*?<\/div>/, '').replace(/<p>Disarankan[^]*?<\/p>/, '');
  assert.equal(strip(ribbon.dlg().content), strip(menu.dlg().content), 'same inputs, same note, same button');
  assert.equal(ribbon.dlg().title, menu.dlg().title);
  assert.equal(ribbon.startButton().caption, menu.startButton().caption);
  assert.equal(ribbon.prefill().start, 1);
  assert.equal(menu.prefill().start, 40);
});

// ===================================================================================
// Wiring
// ===================================================================================

test('wiring: main.js knows nothing about the recovery any more, and the ids used exist', () => {
  assert.ok(!/recoveryFileOpened|recovery/i.test(extractFunction(MAIN, 'loadFile')), 'loadFile has no hook');
  const html = read('app/index.html');
  assert.match(html, /id="gcodeeditortab"/);
});

test('ribbon label: the button says "Start from Line" (caption, icon, tooltip) and the File menu item follows', () => {
  const html = read('app/index.html');
  const btn = html.match(/<button id="recoverJobBtn"[^]*?<\/button>/)[0];
  assert.match(btn, /onclick="recoverCrashedJob\(\);"/, 'still wired to the same handler');
  assert.match(btn, /<span class="caption">Start from<br>Line<\/span>/);
  assert.match(btn, /<i class="fas fa-forward"><\/i>/);
  assert.match(btn, /title="Start from Line: start the job from any line - also to continue after a stop or a crash"/);
  assert.ok(!/Recover<br>Job|Recover a stopped\/crashed|fa-route/.test(btn), 'the old label / tooltip / icon are gone');
  assert.match(html, /<li onclick="recoverCrashedJob\(\);"><a href="#"><i class="fas fa-fw fa-forward"><\/i> Start from Line\.\.\. \(also after a stop or crash\) <\/a><\/li>/);
  assert.ok(!/Recover stopped\/crashed job/.test(html));
});

test('ribbon label: the icon exists in the bundled Font Awesome', () => {
  const fa = fs.readFileSync(path.join(__dirname, '..', 'app/lib/fontawesome5/js/all.min.js'), 'utf8');
  assert.match(fa, /forward:\[512,512/);
});

test('ribbon label: the notifications point at the new name', () => {
  assert.match(RESUME, /tombol Start from Line di ribbon\. Menutup ini tidak menghapus data\. \/ To resume: use the ribbon Start from Line button\./);
  assert.ok(!/Recover Job di ribbon|ribbon Recover Job|klik Recover Job/.test(RESUME));
});

test('wiring: the button opens the dialog in one place - the saved line only when the record belongs to the loaded file', () => {
  const rj = extractFunction(RESUME, 'recoverJob');
  assert.match(rj, /if \(!recoveryEditorHasProgram\(\)\) \{\n    showRecoveryNoFile\(/);
  assert.match(rj, /if \(usable && recoveryRecordMatchesFile\(info\)\) \{\n    recoveryStartAt\(info\.resumeLine\);/);
  assert.match(rj, /showStartFromLine\(1, 'manual', usable \? info\.fileName : ''\)/);
  assert.match(extractFunction(RESUME, 'recoveryStartAt'), /showStartFromLine\(stoppedLine, 'recovery'\)/);
  assert.ok(!/runJob|sendGcode|setValue|POST|#file/.test(rj + extractFunction(RESUME, 'recoveryStartAt')), 'it only opens a dialog');
  const rc = extractFunction(RESUME, 'recoverCrashedJob');
  assert.equal((rc.match(/recoverJob\(/g) || []).length, 3, 'the server answer, the 2 s fallback and "no socket" all go through recoverJob');
});

