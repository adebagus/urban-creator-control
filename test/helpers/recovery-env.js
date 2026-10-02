// Shared sandbox for the "Recover Job" / "Lanjutkan dari Baris" tests: the REAL functions
// from app/wizards/resume/resume.js and app/js/main.js (runJobFile, runGcodeSection from
// toolchange.js) run in a vm with a small DOM / editor / socket / XHR fake. Not a test file
// itself - node's runner loads it and it only exports.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8').replace(/\r\n/g, '\n');
const RESUME = read('app/wizards/resume/resume.js');
const MAIN = read('app/js/main.js');
const TOOLCHANGE = read('app/js/toolchange.js');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('cannot find function ' + name);
  let end = src.indexOf('\n}\n', start);
  if (end === -1 && src.endsWith('\n}')) end = src.length - 2;
  if (end === -1) throw new Error('cannot find the end of function ' + name);
  return src.slice(start, end + 2);
}

// A 200-line program.  Lines 1-2 are the opening lines (units/mode/offset, spindle); line 3
// is the first axis move.  Line n (>= 6) is  "G1 X<n> Y<n % 7> F800".  Highest Z is 5.
const PROGRAM = ['G21 G90 G54', 'M3 S12000', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F300'];
for (let n = 6; n <= 200; n++) PROGRAM.push('G1 X' + n + ' Y' + (n % 7) + ' F800');
const lineText = (n) => PROGRAM[n - 1]; // 1-based, like the editor

// What the entry lines for PROGRAM are, worked out by hand (independent of the code under test):
// at start line n (n >= 7) the last X/Y are those of line n-1, Z is -1, the slowest F is 300 (the
// plunge), the last F is 800, and the spindle command is line 2.
const expectedEntry = (n, safeZ) => ['G0 Z' + safeZ, 'M3 S12000', 'G0 X' + (n - 1) + ' Y' + ((n - 1) % 7), 'G1 Z-1 F300', 'F800'];

// A program shaped like a real CAM job (arcs, words written WITHOUT spaces, the spindle command
// AFTER the first moves, the feed on the first arc of each ring only) - the kind of file that
// a bare slice cannot start: a first line that is an arc without F is rejected (error:22 / :33).
//   1 T1  2 G17  3 G21  4 G90  5 G0Z20  6 G0X0Y0  7 S16000M3  8 G0 X.. Y.. Z5
//   ring r (1-4): G1 Z.. F150, then 4 arcs (the first carries F800.0)      lines 9-13, 14-18, 19-23, 24-28
//   29 G0Z5  30 M5  31 G0Z20  32 G0X0Y0  33 M2
const ARC_PROGRAM = ['T1', 'G17', 'G21', 'G90', 'G0Z20.000', 'G0X0.000Y0.000', 'S16000M3', 'G0X10.263Y9.576Z5.000'];
for (let ring = 1; ring <= 4; ring++) {
  ARC_PROGRAM.push('G1Z' + (-1.455 * ring).toFixed(3) + 'F150.0');
  ARC_PROGRAM.push('G3X11.263Y10.576I0.000J1.000F800.0');
  ARC_PROGRAM.push('G3X10.263Y11.576I-1.000J0.000');
  ARC_PROGRAM.push('G3X9.263Y10.576I0.000J-1.000');
  ARC_PROGRAM.push('G3X10.263Y9.576I1.000J0.000');
}
ARC_PROGRAM.push('G0Z5.000', 'M5', 'G0Z20.000', 'G0X0.000Y0.000', 'M2');

const FUNCS = [
  'recoveryEscapeHtml', 'recoveryRewindLines', 'recoverySuggestedLine', 'recoveryOfferInfoHtml', 'showRecoveryNoFile', 'recoveryEditorHasProgram', 'recoveryEditorLine', 'recoverCrashedJob',
  'recoveryShowLine', 'recoveryProgramText', 'recoveryRecordMatchesFile', 'recoveryStartAt', 'recoverJob',
  'showRecoveryOffer', 'recoveryOfferKey', 'recoveryMarkOffered', 'shouldAutoOfferRecovery', 'offerRecoveryOnReconnect', 'dismissRecoveryBanner', 'showRecoveryBanner',
  'recoveryCodeOf', 'recoveryFileFacts', 'recoveryHeaderLength', 'recoveryModalState', 'recoveryEntryPlan', 'recoveryRunPayload', 'recoveryPlanStart', 'recoveryConnectionStatus',
  'recoveryStartDialogHtml', 'recoveryStartMessagesHtml', 'showStartFromLine', 'recoveryInitStartForm', 'recoveryStartRun',
  'recoveryShow3DView', 'recoverySendJob', 'startFromHere',
];
const VARS = [
  'var RECOVERY_DEFAULT_REWIND',
  'var recoveryOfferOpen', 'var RECOVERY_AUTO_OFFER_STATES', 'var recoveryOfferedKeys',
  'var RECOVERY_DEFAULT_SAFE_Z', 'var RECOVERY_MAX_SAFE_Z', 'var recoveryStartLocked', 'var RECOVERY_NOTICE_HINT', 'var RECOVERY_MODAL_HINT',
  'var RECOVERY_UNSAFE_HEADER_RE', 'var RECOVERY_PREMOVE_RE',
];

// opts: text (editor content, default PROGRAM), loadedName, status (connectionStatus, default 1), ack, storage, throwStorage
function makeEnv(opts = {}) {
  const env = {
    text: opts.text === undefined ? PROGRAM.join('\n') : opts.text,
    loadedName: opts.loadedName === undefined ? 'part.nc' : opts.loadedName,
    created: [], gcodeSent: [], posted: [], cursor: null, tabs: [], picker: 0, dialogs: [], emits: [], logs: [], timers: [], intervals: [], cleared: [],
    selRow: 0, topRow: 0, handlers: {}, vals: {}, disabled: {}, htmlOf: {}, viewerVisible: true, viewerActive: true, focused: 0, banner: null, formOpen: false, editorHandlers: [], now: 5_000_000,
    ack: opts.ack, storage: opts.storage || {},
  };
  const ctx = {
    console: { log() {} },
    editor: {
      session: {
        getLength: () => env.text.split('\n').length,
        on(ev, fn) { if (ev === 'change') env.editorHandlers.push(fn); },
        off(ev, fn) { env.editorHandlers = env.editorHandlers.filter((h) => h !== fn); },
      },
      getValue: () => env.text,
      // where the user is in the editor: the cursor row (0-based) and the top visible row
      getSelectionRange: () => ({ start: { row: env.selRow } }),
      getFirstVisibleRow: () => env.topRow,
      gotoLine: (n) => { env.cursor = n; },
      focus() { env.focused++; },
    },
    webgl: opts.webgl === undefined ? true : opts.webgl,
    gcode: opts.gcode === undefined ? false : opts.gcode,
    // P10 Tahap 1b-i: the global app/js/toolchange.js sets this; recoverySendJob() reads it directly.
    toolChangeMode: opts.toolChangeMode === undefined ? 'pause' : opts.toolChangeMode,
    lastJobStartTime: 0,
    get loadedFileName() { return env.loadedName; }, set loadedFileName(v) { env.loadedName = v; },
    laststatus: { comms: { connectionStatus: opts.status === undefined ? 1 : opts.status }, machine: { modals: { homedRecently: true } } },
    window: { localStorage: { getItem: (k) => { if (opts.throwStorage) throw new Error('storage blocked'); return Object.prototype.hasOwnProperty.call(env.storage, k) ? env.storage[k] : null; } } },
    $: (sel) => {
      if (typeof sel === 'string' && sel.charAt(0) === '<') {
        env.created.push(sel);
        return { appendTo() { if (sel.includes('id="recoveryBanner"')) env.banner = sel; return this; } };
      }
      return {
        click() {
          if (sel === '#file') { env.picker++; return this; }
          env.tabs.push(sel);
          if (sel === '#controlTab') env.viewerVisible = true; // Machine Control shows its sub-tabs
          if (sel === '#gcodeviewertab') env.viewerActive = true;
          return this;
        },
        html(v) { if (v === undefined) return env.htmlOf[sel]; env.htmlOf[sel] = v; return this; },
        attr() { return this; },
        closest() { return { hasClass: () => sel === '#gcodeviewertab' && env.viewerActive }; },
        // like the real inputs: what the user typed, else the value the dialog put there
        val() { return env.vals[sel] !== undefined ? env.vals[sel] : (sel === '#recoveryStartLine' || sel === '#recoverySafeZ') ? env.prefillOf(sel) : undefined; },
        prop(name, v) { if (v === undefined) return env.disabled[sel]; if (name === 'disabled') env.disabled[sel] = !!v; return this; },
        on(ev, fn) { (env.handlers[sel] = env.handlers[sel] || {})[ev] = fn; return this; },
        is() { return sel === '#gcodeviewertab' ? env.viewerVisible : false; },
        remove() { if (sel === '#recoveryBanner') env.banner = null; },
        get length() { return sel === '#recoveryStartForm' ? (env.formOpen ? 1 : 0) : 1; },
      };
    },
    Metro: { dialog: { create: (o) => { env.dialogs.push(o); env.formOpen = true; return {}; } } },
    sendGcode: (g) => env.gcodeSent.push(g),
    socket: { emit(ev, cb) { env.emits.push(ev); if (typeof cb === 'function' && env.ack !== 'never') cb(env.ack); } },
    printLog: (m) => env.logs.push(m), parseGcodeInWebWorker() {},
    setTimeout: (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length; }, clearTimeout() {},
    setInterval: (fn) => { env.intervals.push(fn); return env.intervals.length; }, clearInterval: (id) => { env.cleared.push(id); },
    Date: class extends Date { static now() { return env.now; } },
    // what the Run paths POST to the server
    FormData: class { constructor() { this.f = {}; } append(k, v) { this.f[k] = v; } },
    Blob: class { constructor(parts) { this.text = parts.join(''); } },
    File: class { constructor(parts) { this.blob = parts[0]; } },
    XMLHttpRequest: class { open(method, url) { this.m = method; this.u = url; } send(fd) { env.posted.push({ method: this.m, url: this.u, fileName: fd.f.fileName, lineOffset: fd.f.lineOffset, toolChangeMode: fd.f.toolChangeMode, body: fd.f.file.blob.text }); } },
  };
  vm.createContext(ctx);
  for (const decl of VARS) {
    const i = RESUME.indexOf(decl);
    if (i === -1) throw new Error('cannot find ' + decl);
    vm.runInContext(RESUME.slice(i, RESUME.indexOf('\n', i)), ctx); // every extracted var declaration is a single line
  }
  for (const n of FUNCS) vm.runInContext(extractFunction(RESUME, n), ctx);
  vm.runInContext(extractFunction(MAIN, 'runJobFile'), ctx);
  vm.runInContext(extractFunction(TOOLCHANGE, 'runGcodeSection'), ctx);
  env.prefillOf = (sel) => {
    const d = env.dialogs[env.dialogs.length - 1];
    const m = d && d.content.match(new RegExp('id="' + sel.slice(1) + '"[^]*?value="([^"]*)"'));
    return m ? m[1] : undefined;
  };
  env.ctx = ctx;
  env.flush = () => { while (env.timers.length) env.timers.shift().fn(); };
  env.dlg = () => env.dialogs[env.dialogs.length - 1];
  env.startButton = () => env.dlg().actions[0];
  env.setStatus = (s) => { ctx.laststatus.comms.connectionStatus = s; };
  // the user types into the two inputs (the live validation runs on 'input')
  env.type = (start, safe) => {
    if (start !== undefined) env.vals['#recoveryStartLine'] = String(start);
    if (safe !== undefined) env.vals['#recoverySafeZ'] = String(safe);
    // each input has its own listener - fire the one(s) that changed
    if (start !== undefined) { const h = env.handlers['#recoveryStartLine']; if (h && h.input) h.input(); }
    if (safe !== undefined) { const h = env.handlers['#recoverySafeZ']; if (h && h.input) h.input(); }
  };
  // a click on the primary button - only possible while it is enabled
  env.clickStart = () => {
    if (env.disabled['.recovery-start-button']) return false;
    env.startButton().onclick();
    return true;
  };
  env.tick = () => env.intervals[env.intervals.length - 1]();
  // the job the final button sent (there is exactly one, or none)
  env.job = () => env.posted[env.posted.length - 1];
  // the user edits the program
  env.edit = (text) => { env.text = text; env.editorHandlers.slice().forEach((h) => h()); }; // (the editor's change listeners; the feature registers none any more)
  // the user picks a file with the normal picker (what loadFile in main.js does)
  // the user loads a file (what loadFile in main.js does: the editor text and the name change)
  env.pickFile = (name, text) => { env.text = text === undefined ? PROGRAM.join('\n') : text; env.loadedName = name; };
  env.run = () => { env.posted.length = 0; ctx.runJobFile(); return env.posted[0]; };
  // what the dialog shows in its inputs before the user touches them
  env.prefill = () => {
    const html = env.dlg().content;
    return {
      start: Number((html.match(/id="recoveryStartLine"[\s\S]*?value="([^"]*)"/) || [])[1]),
      safe: Number((html.match(/id="recoverySafeZ"[\s\S]*?value="([^"]*)"/) || [])[1]),
    };
  };
  // the values are what the dialog put there; the form reads them via .val()
  env.acceptPrefill = () => {
    const p = env.prefill();
    env.vals['#recoveryStartLine'] = String(p.start);
    env.vals['#recoverySafeZ'] = String(p.safe);
  };
  return env;
}

const info = (over) => Object.assign({ state: 'interrupted', fileName: 'part.nc', resumeLine: 120, totalLines: 200, plannerBlocks: 35, startedAt: 1, savedAt: 1000 }, over);

module.exports = { makeEnv, extractFunction, read, RESUME, MAIN, TOOLCHANGE, PROGRAM, lineText, expectedEntry, ARC_PROGRAM, info };
