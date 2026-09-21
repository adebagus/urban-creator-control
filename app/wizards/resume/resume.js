// Courtesy of https://github.com/rlwoodjr/Basic-SENDER/commit/01f991b7b5171e5e60db59f6cbcba6a286794911#diff-e11dedd96127264342c2b083f0eeaa2e632fd0f9374c13aea861915577f949e8R602
// as per https://github.com/OpenBuilds/OpenBuilds-CONTROL/issues/96#issuecomment-1420150128
// Thanks @rlwoodjr

// P9: the suggested start line used to come from localStorage.gcodeLineNumber
// (a browser-side queue index that drifted from the real line and was never
// cleared). It now comes from the SERVER, which persists a true source line
// number to disk (see jobRecovery.js / job-recovery.json in userData), so it
// survives an app restart and a crash.

// Everything from the server is untrusted text (the file name in particular
// originates from a client-supplied form field) and this renderer runs with
// nodeIntegration, so nothing may be interpolated into HTML unescaped.
// NOTE: despite the name this is the app's shared HTML escaper - it is also
// used by wizards/jobstats/jobstats.js (showJobLog). Keep it defined, and
// resume.js loaded on the desktop page, or the job history dialog breaks.
function recoveryEscapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function(ch) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    } [ch];
  });
}

// ---- "Start from Line" (ribbon button; formerly "Recover Job") ----------------
// The ribbon button ALWAYS opens the "Lanjutkan dari Baris" / "Start From Line" dialog -
// the same one the GCODE Editor's right-click opens - as long as a G-code program is
// loaded in the editor. It never opens the file picker. What differs is only the
// pre-fill of the start line:
//   - a saved job (stop / crash record) for the LOADED file: saved line - 10;
//   - no saved job, or one that belongs to another file: the line the user is at in
//     the editor (else 1) - the user chooses. (A saved job of another file is not used,
//     and the dialog says so.)
// With no program loaded at all the button only says "open a G-code file first".
var RECOVERY_DEFAULT_REWIND = 10; // lines before the stopped line to suggest starting at

// How many lines to step back from where the job stopped. 10 by default; it can
// be changed without touching the code: localStorage.setItem('recoveryRewindLines', '25')
// in the developer console (whole number 0-1000; anything else falls back to 10).
function recoveryRewindLines() {
  try {
    var v = window.localStorage.getItem('recoveryRewindLines');
    if (v !== null && /^\d{1,4}$/.test(String(v).trim()) && parseInt(v, 10) <= 1000) {
      return parseInt(v, 10);
    }
  } catch (e) {}
  return RECOVERY_DEFAULT_REWIND;
}

// "ok" from the controller only means a line went into its planner, not that it
// finished moving, so the line the job "stopped at" can be ahead of the tool:
// suggest starting a few lines earlier.
function recoverySuggestedLine(stoppedLine) {
  return Math.max(1, parseInt(stoppedLine, 10) - recoveryRewindLines());
}

// The info text of both offers (banner and modal): where it stopped, which file,
// and from which line it will resume.
function recoveryOfferInfoHtml(info) {
  var resume = parseInt(info.resumeLine, 10);
  var start = recoverySuggestedLine(resume);
  var html = 'Pekerjaan terhenti di baris <b>' + resume + '</b>';
  if (info.totalLines > 0) {
    html += ' dari <b>' + parseInt(info.totalLines, 10) + '</b> total baris';
  }
  html += '.';
  if (info.fileName) {
    html += '<br>File: <b>' + recoveryEscapeHtml(info.fileName) + '</b>';
  }
  html += '<br>Disarankan mulai sekitar baris <b>' + start + '</b> setelah Home dan Set Zero ulang.';
  return html;
}

// The automatic notifications (banner, app-start modal) are INFORMATION ONLY. They
// appear on their own, at a moment the user did not choose, so they must not be
// able to start anything: the way on is the ribbon "Start from Line" button (or the
// editor's right-click), which the user presses deliberately. Closing a
// notification never deletes the saved data.
var RECOVERY_NOTICE_HINT = 'Untuk melanjutkan: tombol Start from Line di ribbon. Menutup ini tidak menghapus data. / To resume: use the ribbon Start from Line button. Closing this keeps the data.';

// Is there a program in the editor to start from?
function recoveryEditorHasProgram() {
  return typeof editor !== 'undefined' && recoveryProgramText().trim().length > 0;
}

// The line the user is at in the editor: the cursor line once they clicked into
// the text, otherwise the top visible line (they only scrolled); 1 when neither is known.
function recoveryEditorLine() {
  try {
    var row = editor.getSelectionRange().start.row; // 0-based
    if (row > 0) return row + 1;
    if (typeof editor.getFirstVisibleRow === 'function') {
      var top = editor.getFirstVisibleRow();
      if (top > 0) return top + 1;
    }
  } catch (e) {}
  return 1;
}

// Only when NO program is loaded at all. savedName: the file of a saved job, if there is one.
function showRecoveryNoFile(savedName) {
  Metro.dialog.create({
    title: "<i class='fas fa-fw fa-route'></i> Buka file G-code dulu" +
      "<div class='recovery-title-en'>Open a G-code file first</div>",
    content: '<p>Belum ada file G-code di editor. Buka file G-code dulu, lalu klik Start from Line lagi.</p>' +
      (savedName ? '<p class="text-small">Ada data job tersimpan untuk file: <b>' + recoveryEscapeHtml(savedName) + '</b>.</p>' : ''),
    clsDialog: 'dark',
    actions: [{
      caption: "Tutup / Close",
      cls: "js-dialog-close",
      onclick: function() {}
    }]
  });
}

// Ribbon button / File menu: ask the server for a saved job; with one, recover it,
// without one (or when the server does not answer) start from any line.
function recoverCrashedJob() {
  if (typeof socket === 'undefined' || !socket) {
    recoverJob(null);
    return;
  }
  var answered = false;
  // If the server can't answer (disconnected) don't leave the user with a dead button.
  var fallback = setTimeout(function() {
    if (!answered) {
      answered = true;
      recoverJob(null);
    }
  }, 2000);
  socket.emit('getRecoveryInfo', function(info) {
    if (answered) return;
    answered = true;
    clearTimeout(fallback);
    recoverJob(info);
  });
}

// Scroll the editor to a line. It NEVER changes the visible tab or takes keyboard focus:
// the user may be watching the 3D View (see recoveryShow3DView).
function recoveryShowLine(line) {
  editor.gotoLine(Math.min(line, editor.session.getLength()));
}

// Does the saved job belong to the file that is loaded? (a record without a name always does)
function recoveryRecordMatchesFile(info) {
  return !info.fileName || (typeof loadedFileName !== 'undefined' && loadedFileName === info.fileName);
}

// Open the "Lanjutkan dari Baris" dialog for a job that stopped at line X.
function recoveryStartAt(stoppedLine) {
  showStartFromLine(stoppedLine, 'recovery');
}

// The ribbon button. info: the saved job, or nothing. The dialog ALWAYS opens when a
// program is loaded; the record only decides the pre-fill.
function recoverJob(info) {
  var usable = !!info && Number.isInteger(info.resumeLine) && info.resumeLine >= 1;
  if (!recoveryEditorHasProgram()) {
    showRecoveryNoFile(usable ? info.fileName : '');
    return;
  }
  if (usable && recoveryRecordMatchesFile(info)) {
    recoveryStartAt(info.resumeLine); // pre-filled from the saved job
    return;
  }
  // no saved job, or one that belongs to another file: the user chooses the line
  showStartFromLine(1, 'manual');
}

// Offered by the server when a client connects and an unfinished job is on
// record. One dialog at a time - a machine reconnect or a reload can deliver
// the same offer again while it is still on screen.
var recoveryOfferOpen = false;

function showRecoveryOffer(info) {
  if (recoveryOfferOpen) return;
  if (!info || !Number.isInteger(info.resumeLine) || info.resumeLine < 1) return;

  // The splash screen (z-index 2000) covers the page for the first ~2s; don't
  // create a modal underneath it. Poll until it is gone.
  var tries = 0;
  (function whenReady() {
    if ($('#splash').is(':visible') && tries++ < 40) {
      setTimeout(whenReady, 300);
      return;
    }
    if (recoveryOfferOpen) return;
    recoveryOfferOpen = true;
    recoveryMarkOffered(info); // the auto-offer on reconnect must not repeat this one

    // Information only: no button starts anything, and closing keeps the saved data.
    Metro.dialog.create({
      title: "<i class='fas fa-fw fa-route'></i> Job belum selesai ditemukan" +
        "<div class='recovery-title-en'>Unfinished job found</div>",
      content: '<div class="remark warning">' + recoveryOfferInfoHtml(info) + '</div>' +
        '<p class="text-small">' + RECOVERY_NOTICE_HINT + '</p>',
      clsDialog: 'dark',
      closeButton: true,
      onClose: function() {
        recoveryOfferOpen = false;
      },
      actions: [{
        caption: "Tutup / Close",
        cls: "js-dialog-close",
        onclick: function() {}
      }]
    });
  })();
}

// ---- Offer on controller (re)connect --------------------------------------
// The modal above is for "the app was just opened" (no machine attached yet).
// After a USB drop the app stays open and the controller often keeps draining
// its planner, so the user may still need Stop/jog: here the offer is a
// NON-blocking banner, never a modal. Rules:
//   - only for interrupted / running / completing records. A "stopped" record is
//     kept for tool changes and is recovered manually from the ribbon button;
//   - each record (keyed by savedAt) is offered at most once per app session,
//     counting the modal above, so Connect clicks never repeat it.
var RECOVERY_AUTO_OFFER_STATES = ['interrupted', 'running', 'completing'];
var recoveryOfferedKeys = {};

function recoveryOfferKey(info) {
  return info.savedAt > 0 ? String(info.savedAt) : info.state + ':' + info.resumeLine;
}

function recoveryMarkOffered(info) {
  if (info) recoveryOfferedKeys[recoveryOfferKey(info)] = true;
}

function shouldAutoOfferRecovery(info) {
  if (!info || !Number.isInteger(info.resumeLine) || info.resumeLine < 1) return false;
  if (RECOVERY_AUTO_OFFER_STATES.indexOf(info.state) === -1) return false;
  return !recoveryOfferedKeys[recoveryOfferKey(info)];
}

// Called from showGrbl(true) when a controller has just identified itself.
function offerRecoveryOnReconnect() {
  if (typeof isJogWidget !== 'undefined' && isJogWidget) return;
  if (typeof socket === 'undefined' || !socket) return;
  socket.emit('getRecoveryInfo', function(info) {
    if (!shouldAutoOfferRecovery(info)) return;
    // stay out from under the splash screen (z-index 2000)
    var tries = 0;
    (function whenReady() {
      if ($('#splash').is(':visible') && tries++ < 40) {
        setTimeout(whenReady, 300);
        return;
      }
      if (!shouldAutoOfferRecovery(info)) return; // the modal got there first
      recoveryMarkOffered(info);
      showRecoveryBanner(info);
    })();
  });
}

function dismissRecoveryBanner() {
  $('#recoveryBanner').remove();
}

function showRecoveryBanner(info) {
  dismissRecoveryBanner();
  // Look (solid dark card, orange accent, shadow) lives in css/main.css
  // (.recovery-banner); only the positioning is inline. INFORMATION ONLY: the
  // corner (x) just closes it - the saved data is kept.
  var banner = $('<div id="recoveryBanner" class="recovery-banner" role="alert" ' +
    'style="position: fixed; left: 12px; bottom: 12px; z-index: 1500; max-width: 460px;">' +
    '<button type="button" id="recoveryBannerClose" class="recovery-banner-close" ' +
    'title="Tutup / Close" aria-label="Tutup / Close">&times;</button>' +
    '<div><b><i class="fas fa-fw fa-route"></i> Job belum selesai ditemukan</b></div>' +
    '<div class="recovery-banner-en">Unfinished job found</div>' +
    '<div class="text-small mt-2">' + recoveryOfferInfoHtml(info) + '</div>' +
    '<div class="recovery-banner-en mt-2">' + RECOVERY_NOTICE_HINT + '</div>' +
    '</div>');
  banner.appendTo('body');
  $('#recoveryBannerClose').on('click', dismissRecoveryBanner);
}

// ===========================================================================
// "Lanjutkan dari Baris" / "Start From Line"
// ===========================================================================
// The final button of this dialog STARTS THE MACHINE, as one job: Z up, spindle,
// rapid to where the start line begins, plunge, then the file from the start line
// on. There is no second click (no separate Run): everything is validated first -
// the button is disabled until it all passes and it is re-checked at the click -
// the dialog shows exactly what will run, and the 3D View is brought up so the
// motion can be watched and stopped.
// Opened by "Recover Job" (banner / modal / ribbon) and by the editor's
// right-click "Recover job from Line". It deliberately does NOT rebuild the
// G-code in the editor - the program is never rewritten. It
//   1. suggests a start line a few lines before where the job stopped, editable;
//   2. raises Z with one rapid, to (highest Z in the file + a "Safe Height"), and
//   3. arms the NEXT Run to send the file from the chosen line. A slice of a
//      program cannot start on its own - the controller rejects a first line
//      that is an arc, or a cut without a feed rate (error:22 / error:33), and a
//      spindle command that sits after the first move is missed - so the armed
//      payload is: the file's own opening lines, then the state the file had
//      reached at the start line (spindle, feed, motion mode), a rapid to where
//      the start line begins (at the safe Z) and down to the last Z, and then the
//      lines from the start line on. Everything is read from what the file itself
//      says before that line; nothing is guessed, and what will be sent is shown
//      in the dialog first.
// Run otherwise always sends the whole editor, so scrolling alone would still
// start at line 1. The armed Run is single-use, is shown on the Run button, and is
// cancelled by loading another file, touching the editor or opening the dialog again.
var RECOVERY_DEFAULT_SAFE_Z = 10; // mm above the highest point of the file
var RECOVERY_MAX_SAFE_Z = 500;
var recoveryStartLocked = false;

// The text Run would send: the global gcode (very large files) or the editor.
function recoveryProgramText() {
  return (typeof gcode === 'string' && gcode) ? gcode : editor.getValue();
}

// The code part of a G-code line: (...) comments can sit anywhere, ; ends the line.
function recoveryCodeOf(line) {
  return line.replace(/\([^)]*\)/g, ' ').split(';')[0].toUpperCase();
}

// What in the file matters for this dialog: its highest Z (the raise clears it),
// whether it is in inches, whether it is incremental (G91, cannot be resumed
// mid-way - every move is relative to a position we do not have).
function recoveryFileFacts(lines) {
  var maxZ = null;
  var hasG20 = false;
  var hasG21 = false;
  var relative = false;
  for (var i = 0; i < lines.length; i++) {
    var code = recoveryCodeOf(lines[i]);
    if (!code.trim()) continue;
    var re = /Z\s*(-?\d*\.?\d+)/g;
    var m;
    while ((m = re.exec(code)) !== null) {
      var z = parseFloat(m[1]);
      if (isFinite(z) && (maxZ === null || z > maxZ)) maxZ = z;
    }
    if (/G0*20(?!\d)/.test(code)) hasG20 = true;
    if (/G0*21(?!\d)/.test(code)) hasG21 = true;
    if (/G0*91(?![\d.])/.test(code)) relative = true;
  }
  return {
    maxZ: maxZ,
    inch: hasG20 && !hasG21,
    relative: relative
  };
}

// The file's opening lines: everything before the first line that moves an axis
// (or does anything that must not be replayed: a motion mode, homing, probing,
// changing offsets, a tool change, a stop or end of program, a $ command).
// Blank and comment-only lines belong to it. Position is never computed.
var RECOVERY_UNSAFE_HEADER_RE = /G0*[0-3](?!\d)|G(?:10|28|30|38|53|92)(?!\d)|M0*(?:0|1|2|6|30)(?!\d)|^\$/;

function recoveryHeaderLength(lines) {
  for (var i = 0; i < lines.length; i++) {
    var code = recoveryCodeOf(lines[i]).trim();
    if (!code) continue;
    if (/[XYZA]\s*-?[\d.]/.test(code) || RECOVERY_UNSAFE_HEADER_RE.test(code)) return i;
  }
  return lines.length;
}

// What the program had set up by the time it reaches startLine: the last position,
// feed rates, motion mode and spindle command in the lines BEFORE it (absolute
// mode - incremental G91 files are refused). Lines that use machine coordinates
// or change offsets (G53, G28, G30, G92, G10) say nothing about the work position
// and are skipped for it.
function recoveryModalState(lines, startLine) {
  var st = { x: null, y: null, a: null, z: null, f: null, minF: null, mode: null, spindleM: null, spindleS: null, dwell: null };
  var end = Math.min(startLine - 1, lines.length);
  var spindleAt = -1;
  var m;
  for (var i = 0; i < end; i++) {
    var code = recoveryCodeOf(lines[i]);
    if (!code.trim()) continue;
    if (!/G(?:53|28|30|92|10)(?!\d)/.test(code)) {
      var re;
      re = /X\s*(-?\d*\.?\d+)/g;
      while ((m = re.exec(code)) !== null) st.x = m[1];
      re = /Y\s*(-?\d*\.?\d+)/g;
      while ((m = re.exec(code)) !== null) st.y = m[1];
      re = /A\s*(-?\d*\.?\d+)/g;
      while ((m = re.exec(code)) !== null) st.a = m[1];
      re = /Z\s*(-?\d*\.?\d+)/g;
      while ((m = re.exec(code)) !== null) st.z = m[1];
    }
    var fre = /F\s*(\d*\.?\d+)/g;
    while ((m = fre.exec(code)) !== null) {
      st.f = m[1];
      var fv = parseFloat(m[1]);
      if (fv > 0 && (st.minF === null || fv < parseFloat(st.minF))) st.minF = m[1];
    }
    var gre = /G0*([0-3])(?!\d)/g;
    while ((m = gre.exec(code)) !== null) st.mode = parseInt(m[1], 10);
    var sre = /S\s*(\d*\.?\d+)/g;
    while ((m = sre.exec(code)) !== null) st.spindleS = m[1];
    var mre = /M0*([345])(?!\d)/g;
    while ((m = mre.exec(code)) !== null) {
      st.spindleM = parseInt(m[1], 10);
      spindleAt = i;
    }
  }
  // a dwell right after the last spindle start is the spin-up wait: keep it
  if (spindleAt >= 0 && spindleAt + 1 < end && (st.spindleM === 3 || st.spindleM === 4)) {
    var next = recoveryCodeOf(lines[spindleAt + 1]).trim();
    if (/^G0*4(?!\d)/.test(next)) st.dwell = next;
  }
  return st;
}

// The lines that bring the controller to the state the program had at startLine,
// sent between the opening lines and the start line. safeMm is the safe height
// in millimetres (the same one the dialog raises Z to); facts says whether the file is in inches.
// Returns { lines, prefix, error, summary }: prefix = { index, word } asks for the motion
// word of an arc mode to be put in front of the first move line of the slice (a lone
// "G2"/"G3" is not a valid line); error explains why the start line cannot be resumed.
function recoveryEntryPlan(lines, startLine, safeMm, facts) {
  var st = recoveryModalState(lines, startLine);
  var out = [];
  var summary = { spindle: '', safeZ: '', xy: '', plunge: '', feed: '', mode: '' };
  var error = '';

  // Z up FIRST - even if the user moved Z after the dialog raised it - and only then
  // the spindle starts, so it never spins up low in the material
  var safe = facts && facts.inch ? Math.round(safeMm / 25.4 * 10000) / 10000 : safeMm;
  summary.safeZ = 'G0 Z' + safe;
  out.push(summary.safeZ);

  if (st.spindleM === 3 || st.spindleM === 4) {
    summary.spindle = 'M' + st.spindleM + (st.spindleS !== null ? ' S' + st.spindleS : '');
    out.push(summary.spindle);
    if (st.dwell) out.push(st.dwell);
  } else if (st.spindleM === 5) {
    summary.spindle = 'M5';
    out.push('M5');
  }

  var xy = [];
  if (st.x !== null) xy.push('X' + st.x);
  if (st.y !== null) xy.push('Y' + st.y);
  if (st.a !== null) xy.push('A' + st.a);
  if (xy.length) {
    summary.xy = 'G0 ' + xy.join(' ');
    out.push(summary.xy);
  }

  if (st.z !== null) {
    if (st.minF === null) {
      error = 'Tidak ada kata F (feed rate) di file sebelum baris ini, jadi Z tidak bisa diturunkan dengan aman. Pilih baris yang lebih akhir.';
    } else {
      // the slowest feed the file uses before this line: the plunge feed, not the cutting feed
      summary.plunge = 'G1 Z' + st.z + ' F' + st.minF;
      out.push(summary.plunge);
    }
  }
  if (st.f !== null) {
    summary.feed = 'F' + st.f;
    out.push(summary.feed);
  }

  // the first move of the slice: does it say which motion it is?
  var prefix = null;
  for (var i = startLine - 1; i < lines.length; i++) {
    var code = recoveryCodeOf(lines[i]).trim();
    if (!code || !/[XYZA]\s*-?[\d.]/.test(code)) continue;
    var hasMotion = /G0*[0-3](?!\d)/.test(code);
    var hasFeed = /F\s*\d*\.?\d+/.test(code);
    var effective = hasMotion ? parseInt(code.match(/G0*([0-3])(?!\d)/)[1], 10) : st.mode;
    if (!hasMotion && st.mode !== null) {
      if (st.mode <= 1) {
        summary.mode = 'G' + st.mode;
        out.push(summary.mode); // a lone G0 / G1 sets the mode without moving
      } else {
        summary.mode = 'G' + st.mode;
        prefix = { index: i, word: 'G' + st.mode };
      }
    }
    if (effective !== null && effective >= 1 && !hasFeed && st.f === null && !error) {
      error = 'Tidak ada kata F (feed rate) di file sebelum baris ini, sedangkan baris ini memotong. Pilih baris yang lebih akhir.';
    }
    break;
  }
  return { lines: out, prefix: prefix, error: error, summary: summary };
}

// The text the armed Run sends, and the lineOffset that keeps the server's
// "Recover Job" record in ORIGINAL file line numbers: a payload line p past the
// inserted lines is file line p + lineOffset (clamped at 0; the few lines the
// clamp could misplace are the inserted ones, which come before the start line).
function recoveryRunPayload(sourceText, startLine, safeMm, facts, preMove) {
  var lines = sourceText.split('\n');
  // the Z raise (mm, absolute) is the very first line of the job, so the whole
  // sequence is ONE job with ONE recovery record
  var pre = preMove ? [preMove] : [];
  var headerLen = recoveryHeaderLength(lines);
  if (startLine <= headerLen + 1) {
    // everything before the start line is opening lines: sending the file from its
    // first line is exactly "start here", and keeps the units / mode / offset lines.
    // (The raise in front shifts the recorded lines by one - a line LATE, harmless
    // here because nothing has been cut yet and the dialog rewinds 10 anyway.)
    return { text: pre.concat(lines).join('\n'), lineOffset: 0, headerLines: 0, entryLines: 0, preLines: pre.length, entry: null };
  }
  facts = facts || recoveryFileFacts(lines);
  var entry = recoveryEntryPlan(lines, startLine, safeMm, facts);
  var slice = lines.slice(startLine - 1);
  if (entry.prefix) {
    var at = entry.prefix.index - (startLine - 1);
    slice[at] = entry.prefix.word + ' ' + slice[at];
  }
  return {
    text: pre.concat(lines.slice(0, headerLen), entry.lines, slice).join('\n'),
    lineOffset: Math.max(0, startLine - pre.length - headerLen - entry.lines.length - 1),
    headerLines: headerLen,
    entryLines: entry.lines.length,
    preLines: pre.length,
    entry: entry
  };
}

var RECOVERY_PREMOVE_RE = /^G21 G90 G0 Z-?\d+(\.\d+)?$/;

// Validate the dialog and work out the Z raise. connectionStatus: 1-2 = connected and idle.
function recoveryPlanStart(facts, totalLines, startRaw, safeRaw, connectionStatus, lines) {
  var errors = [];
  var startText = String(startRaw === undefined || startRaw === null ? '' : startRaw).trim();
  var safeText = String(safeRaw === undefined || safeRaw === null ? '' : safeRaw).trim();
  var start = /^\d{1,9}$/.test(startText) ? parseInt(startText, 10) : NaN;
  var safe = /^\d{1,4}(\.\d{1,3})?$/.test(safeText) ? parseFloat(safeText) : NaN;
  if (!(start >= 1 && start <= totalLines)) {
    errors.push('Nomor baris harus bilangan bulat antara 1 dan ' + totalLines + '.');
  }
  if (!(safe >= 0 && safe <= RECOVERY_MAX_SAFE_Z)) {
    errors.push('Safe Height harus angka antara 0 dan ' + RECOVERY_MAX_SAFE_Z + ' mm.');
  }
  if (connectionStatus !== 1 && connectionStatus !== 2) {
    errors.push('Mesin belum terhubung atau belum siap (harus diam/idle). Hubungkan mesin dulu.');
  }
  if (facts.relative) {
    errors.push('File ini memakai mode inkremental (G91): tidak bisa dilanjutkan dari tengah.');
  }
  var preMove = '';
  var targetZ = NaN;
  if (safe >= 0 && safe <= RECOVERY_MAX_SAFE_Z) {
    var top = facts.maxZ === null ? 0 : facts.maxZ;
    var topMm = facts.inch ? top * 25.4 : top; // the raise is always sent in millimetres (G21)
    targetZ = Math.round((topMm + safe) * 1000) / 1000;
    preMove = 'G21 G90 G0 Z' + targetZ;
    if (!RECOVERY_PREMOVE_RE.test(preMove)) {
      errors.push('Tinggi aman tidak bisa dihitung dari file ini.');
      preMove = '';
    }
  }
  // what the Run will send before the start line - and whether the start line can be resumed at all
  var entry = null;
  if (lines && start >= 1 && start <= totalLines && preMove) {
    entry = recoveryEntryPlan(lines, start, targetZ, facts);
    if (entry.error) errors.push(entry.error);
  }
  return {
    ok: errors.length === 0,
    errors: errors,
    start: start,
    safe: safe,
    targetZ: targetZ,
    preMove: preMove,
    entry: entry
  };
}

function recoveryConnectionStatus() {
  return (typeof laststatus !== 'undefined' && laststatus && laststatus.comms) ? laststatus.comms.connectionStatus : undefined;
}

// ---- the dialog ------------------------------------------------------------
function recoveryStartDialogHtml(stoppedLine, source, total, facts, suggested) {
  var html = '<p>Melanjutkan pekerjaan setelah listrik mati, koneksi putus, atau gangguan lain.</p>';
  if (source === 'recovery') {
    html += '<div class="remark info">Pekerjaan Anda (total <b>' + total + '</b> baris) terhenti sekitar baris <b>' + stoppedLine + '</b>.</div>';
  } else if (source === 'manual') {
    html += '<div class="remark info">File ini punya <b>' + total + '</b> baris. Anda bebas mulai dari baris mana pun.</div>';
  } else {
    html += '<div class="remark info">Anda memilih baris <b>' + stoppedLine + '</b> (total <b>' + total + '</b> baris).</div>';
  }
  if (source !== 'manual' && stoppedLine > total) {
    html += '<div class="recovery-start-error">Baris ' + stoppedLine + ' melebihi panjang file yang dimuat (' + total + ' baris) - kemungkinan ini file yang salah.</div>';
  }
  if (source !== 'manual') {
    html += '<p>Disarankan mulai sekitar baris <b>' + suggested + '</b> untuk hasil lebih aman.</p>';
  }
  html += '<div id="recoveryStartForm">' +
    '<input id="recoveryStartLine" data-prepend="Mulai dari baris:" type="number" min="1" max="' + total + '" step="1" data-role="input" data-clear-button="false" value="' + suggested + '" data-editable="true"></input>' +
    '<input id="recoverySafeZ" data-prepend="Safe Height (Z), mm:" type="number" min="0" max="' + RECOVERY_MAX_SAFE_Z + '" step="1" data-role="input" data-clear-button="false" value="' + RECOVERY_DEFAULT_SAFE_Z + '" data-editable="true"></input>' +
    '</div>' +
    '<div class="text-small">Safe Height = tinggi (mm) di atas titik tertinggi file' +
    (facts.maxZ === null ? '' : ' (Z' + facts.maxZ + (facts.inch ? ' inci' : '') + ')') +
    ', untuk satu gerakan naik sebelum mulai.</div>' +
    '<div id="recoveryStartMessages"></div>' +
    '<div class="recovery-start-warn" role="alert"><b>Mesin akan LANGSUNG bergerak begitu tombol di bawah diklik:</b> Z naik, spindle menyala, ' +
    'gerak cepat ke titik awal, turun, lalu memotong dari baris yang dipilih. Pantau di 3D View dan siap menekan Stop.</div>' +
    '<div class="recovery-start-note"><b>Pastikan mesin sudah di-Home dan Set Zero ulang sebelum melanjutkan.</b></div>';
  return html;
}

function recoveryStartMessagesHtml(plan) {
  var html = '';
  plan.errors.forEach(function(e) {
    html += '<div class="recovery-start-error">' + recoveryEscapeHtml(e) + '</div>';
  });
  if (plan.ok) {
    if (plan.entry) {
      // one dense line, always visible: the whole entry sequence, then the start line
      var e = plan.entry.summary;
      var steps = [recoveryEscapeHtml(e.safeZ.replace('G0 ', ''))];
      if (e.spindle) steps.push(recoveryEscapeHtml(e.spindle));
      if (e.xy) steps.push(recoveryEscapeHtml(e.xy.replace('G0 ', '')));
      if (e.plunge) steps.push(recoveryEscapeHtml(e.plunge.replace('G1 ', '').replace(' F', ' (F')) + ')');
      if (e.feed) steps.push(recoveryEscapeHtml(e.feed));
      html += '<div class="text-small">Urutan (mm): <b>' + steps.join('</b> &rarr; <b>') + '</b> &rarr; baris <b>' + plan.start + '</b></div>';
    } else {
      html += '<div class="text-small">Z akan naik ke <b>Z' + plan.targetZ + '</b> (mm, koordinat kerja), lalu pekerjaan berjalan dari baris <b>' + plan.start + '</b>.</div>';
    }
  }
  return html;
}

function showStartFromLine(stoppedLine, source) {
  stoppedLine = parseInt(stoppedLine, 10);
  if (!(stoppedLine >= 1)) stoppedLine = 1;
  var programText = recoveryProgramText();
  var lines = programText.split('\n');
  var total = lines.length;
  var facts = recoveryFileFacts(lines);
  // what the dialog scanned: the button re-checks that this is still what would be sent
  var session = {
    facts: facts,
    total: total,
    lines: lines,
    text: programText,
    fileName: typeof loadedFileName !== 'undefined' ? loadedFileName : ''
  };
  // pre-fill: from a saved job or a chosen line it is the recommendation (line - 10); with
  // no saved job it is simply the line the user is at in the editor (no step back)
  var suggested = source === 'manual' ? Math.min(recoveryEditorLine(), total) : Math.min(recoverySuggestedLine(stoppedLine), total);

  recoveryShowLine(suggested);
  Metro.dialog.create({
    title: "<i class='fas fa-fw fa-route'></i> Lanjutkan dari Baris" +
      "<div class='recovery-title-en'>Start From Line</div>",
    content: recoveryStartDialogHtml(stoppedLine, source, total, facts, suggested),
    clsContent: 'recovery-start-content',
    clsDialog: 'dark',
    closeButton: true,
    actions: [{
      caption: "Mulai dari Baris Ini / Start from Line",
      cls: "js-dialog-close alert recovery-start-button",
      onclick: function() {
        recoveryStartRun(session);
      }
    }]
  });
  recoveryInitStartForm(session);
}

// Live validation: the button stays disabled until the numbers are valid AND the
// machine is connected and idle; the messages follow the machine status.
function recoveryInitStartForm(session) {
  var facts = session.facts;
  var total = session.total;
  var lines = session.lines;
  var cache = { key: null, plan: null };
  var refresh = function() {
    // the scan of the lines before the start line is only redone when the numbers change
    var start = $('#recoveryStartLine').val();
    var safe = $('#recoverySafeZ').val();
    var key = start + '|' + safe + '|' + recoveryConnectionStatus();
    var plan = cache.key === key ? cache.plan : recoveryPlanStart(facts, total, start, safe, recoveryConnectionStatus(), lines);
    cache = { key: key, plan: plan };
    $('#recoveryStartMessages').html(recoveryStartMessagesHtml(plan));
    $('.recovery-start-button').prop('disabled', !plan.ok);
  };
  $('#recoveryStartLine').on('input', refresh);
  $('#recoverySafeZ').on('input', refresh);
  refresh();
  var timer = setInterval(function() {
    if (!$('#recoveryStartForm').length) {
      clearInterval(timer); // dialog closed
      return;
    }
    refresh();
  }, 500);
}

// The 3D View, so the first moves can be watched and Stop pressed at once. If it is
// already showing nothing changes; if the user is on another tab (the right-click
// starts from the GCODE Editor) the view goes TO the 3D View - never away from it.
// Without WebGL there is no 3D View and the tab is left alone.
function recoveryShow3DView() {
  if (typeof webgl !== 'undefined' && !webgl) return;
  if (!$('#gcodeviewertab').is(':visible')) {
    $('#controlTab').click(); // the 3D View lives inside Machine Control
  }
  if (!$('#gcodeviewertab').closest('li').hasClass('active')) {
    $('#gcodeviewertab').click();
  }
}

// Send the job the way the Run button does (same endpoint, the real file name and,
// new, the line offset as separate form fields appended before the file).
function recoverySendJob(payload, startLine, fileName) {
  var formData = new FormData();
  var blob = new Blob([payload.text], {
    type: 'text/plain'
  });
  var fileOfBlob = new File([blob], 'upload.gcode');
  formData.append("fileName", fileName || "");
  formData.append("lineOffset", String(payload.lineOffset));
  formData.append("file", fileOfBlob);
  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/runjob', true);
  xhr.send(formData);
  if (typeof printLog === 'function') {
    printLog('<span class="fg-red">[ GCODE Parser ]</span><span class="fg-darkGray"> GCODE from line ' + startLine + ' sent to backend </span>');
  }
  lastJobStartTime = new Date().getTime();
}

// "Mulai dari Baris Ini": the final action. Everything is checked again NOW - the
// numbers, the machine state, that the start line can be resumed - and that the
// program is still the one the dialog scanned; only then is the whole sequence
// sent, as one job. Nothing is sent when anything fails.
function recoveryStartRun(session) {
  var plan = recoveryPlanStart(session.facts, session.total, $('#recoveryStartLine').val(), $('#recoverySafeZ').val(), recoveryConnectionStatus(), session.lines);
  if (!plan.ok) {
    if (typeof printLog === 'function') {
      printLog('<span class="fg-red">[ Recover ]</span><span class="fg-darkGray"> Not started: ' + recoveryEscapeHtml(plan.errors.join(' ')) + ' </span>');
    }
    return;
  }
  var sameProgram = recoveryProgramText() === session.text && (typeof loadedFileName === 'undefined' || loadedFileName === session.fileName);
  if (!sameProgram) {
    if (typeof printLog === 'function') {
      printLog('<span class="fg-red">[ Recover ]</span><span class="fg-darkGray"> Not started: the program changed since this dialog was opened. Nothing was sent. </span>');
    }
    return;
  }
  if (recoveryStartLocked) {
    return; // a double click must not send the job twice
  }
  recoveryStartLocked = true;
  setTimeout(function() {
    recoveryStartLocked = false;
  }, 3000);
  var payload = recoveryRunPayload(session.text, plan.start, plan.targetZ, session.facts, plan.preMove);
  recoverySendJob(payload, plan.start, session.fileName);
  recoveryShowLine(plan.start);
  recoveryShow3DView();
}

// Right-click "Recover job from Line" in the GCODE Editor.
function startFromHere(lineNumber) {
  showStartFromLine(lineNumber, 'menu');
}
