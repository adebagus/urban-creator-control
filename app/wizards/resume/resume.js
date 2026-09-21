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

function recoveryDescribe(info) {
  var when = info.savedAt > 0 ? new Date(info.savedAt).toLocaleString() : 'unknown time';
  var what;
  if (info.state == 'stopped') {
    what = 'The job was stopped';
  } else if (info.state == 'interrupted') {
    what = 'The job was interrupted (connection lost, alarm, or the application was closed)';
  } else {
    // "running"/"completing" still on disk at startup: the previous run died
    what = 'The application closed or the connection was lost while the job was still running';
  }
  var html = recoveryEscapeHtml(what) + ' - last saved ' + recoveryEscapeHtml(when) + '.';
  if (info.fileName) {
    html += '<br>File: <b>' + recoveryEscapeHtml(info.fileName) + '</b>';
  }
  html += '<br>Resume line saved: <b>' + parseInt(info.resumeLine, 10) + '</b>';
  if (info.totalLines > 0) {
    html += ' of ' + parseInt(info.totalLines, 10);
  }
  return html;
}

// Ask the server for the current recovery data, then open the wizard.
function recoverCrashedJob() {
  if (typeof socket === 'undefined' || !socket) {
    openRecoverDialog(null);
    return;
  }
  var answered = false;
  // If the server can't answer (disconnected) don't leave the user with a dead
  // button - fall back to the plain manual dialog, starting at line 1.
  var fallback = setTimeout(function() {
    if (!answered) {
      answered = true;
      openRecoverDialog(null);
    }
  }, 2000);
  socket.emit('getRecoveryInfo', function(info) {
    if (answered) return;
    answered = true;
    clearTimeout(fallback);
    openRecoverDialog(info);
  });
}

function openRecoverDialog(info) {
  var lineNumber = 1;
  var infoBlock = '';

  if (info && Number.isInteger(info.resumeLine) && info.resumeLine >= 1) {
    lineNumber = info.resumeLine;
    var warnings = '';

    // Wrong file? Compare by name first (the server now records it), then by
    // length as before.
    if (info.fileName && typeof loadedFileName !== 'undefined' && loadedFileName && loadedFileName != info.fileName) {
      warnings += '<br><span class="fg-red">The loaded file is <b>' + recoveryEscapeHtml(loadedFileName) +
        '</b>, not <b>' + recoveryEscapeHtml(info.fileName) + '</b> - open the original file before recovering.</span>';
    }
    if (lineNumber > editor.session.getLength()) {
      warnings += '<br><span class="fg-red">The saved line is beyond the end of the loaded GCODE - this is probably the wrong file. Starting from line 1 instead.</span>';
      lineNumber = 1;
    }
    // "ok" from the controller means a line was accepted into its planner, not
    // that it finished moving. Say so, rather than let the number look exact.
    if (info.plannerBlocks > 0) {
      warnings += '<br><span class="text-small">The controller can hold up to ' + parseInt(info.plannerBlocks, 10) +
        ' already-acknowledged moves in its planner. If the machine was reset or lost power, some of those never ran - consider starting a few lines earlier.</span>';
    }
    infoBlock = '<div class="remark info">' + recoveryDescribe(info) + warnings + '</div><hr>';
  }

  var resumeTemplate = `
  <form>
    Enter the starting line to recover the job from:
    <br>
    <span class="text-small">(Make sure you opened the GCODE first)</span>
    <hr>
    ` + infoBlock + `
    <input id="selectedLineNumber" data-prepend="<i class='fas fa-list-ol'></i> Start from line: " type="number" data-role="input"  data-clear-button="false" value="` + parseInt(lineNumber, 10) + `" data-editable="true"></input>
    <hr>
    <input type="checkbox" data-role="checkbox" data-caption="Use Work Coordinates for Z-Safe Move:" data-caption-position="left" id="recoveryUseWpos">
  </form>
  <div class="remark success">
  Tip: You can pick the line from the GCODE Editor tab using the right-click context menu too</span>
  </div>
  <hr>
  <div class="remark warning">
    NOTE: Use this tool at your own risk. Recovering GCODE is a risky operation. You are also responsible for ensuring that work origin is correctly set.  Use at your own risk.
  </div>
  `
  var actions = [{
      caption: "Proceed to next step",
      cls: "js-dialog-close alert",
      onclick: function() {
        startFromHere($("#selectedLineNumber").val());
      }
    },
    {
      caption: "Cancel",
      cls: "js-dialog-close",
      onclick: function() {}
    }
  ];
  if (info) {
    // Explicitly forget the saved job (e.g. it was abandoned on purpose).
    actions.splice(1, 0, {
      caption: "Discard saved job",
      cls: "js-dialog-close",
      onclick: function() {
        socket.emit('discardRecovery');
      }
    });
  }

  Metro.dialog.create({
    title: "<i class='fas fa-fw fa-route'></i> Recover Job From Line Number",
    content: resumeTemplate,
    //toTop: true,
    //width: '75%',
    clsDialog: 'dark',
    actions: actions
  });
};

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

    var noFile = (typeof editor === 'undefined') || editor.session.getLength() < 2;
    var body = '<div class="remark warning">' + recoveryDescribe(info) + '</div>' +
      (noFile ? '<p>Open the GCODE file first, then choose <b>Recover job</b>.</p>' : '') +
      '<p class="text-small">Choose <b>Recover job</b> to review the recovery steps, <b>Discard</b> to forget this job permanently, or <b>Later</b> to decide next time.</p>';

    Metro.dialog.create({
      title: "<i class='fas fa-fw fa-route'></i> Unfinished job found",
      content: body,
      clsDialog: 'dark',
      onClose: function() {
        recoveryOfferOpen = false;
      },
      actions: [{
          caption: "Recover job",
          cls: "js-dialog-close alert",
          onclick: function() {
            recoverCrashedJob();
          }
        },
        {
          caption: "Discard",
          cls: "js-dialog-close",
          onclick: function() {
            socket.emit('discardRecovery');
          }
        },
        {
          caption: "Later",
          cls: "js-dialog-close",
          onclick: function() {}
        }
      ]
    });
  })();
}


function startFromHere(lineNumber) {
  console.log(lineNumber)
  var lineX = "";
  var lineY = "";
  var lineZ = "";
  var lineA = "";
  var lineZm = "";
  var lineF = "";
  var lineFmin = 0;
  var lineFmax = 0;
  var line = '';
  var spindle = null;


  var foundZUp = false;
  var foundZUpLine = 0;


  for (var i = 1; i < lineNumber; i++) {
    currentLine = editor.session.getLine(i);
    if (currentLine.length > 0) {
      currentLine = currentLine.split(/[;(]/); // Remove everything after ; or ( = comment
      line = currentLine[0]
      line = line.toUpperCase();

      var Xindex = line.indexOf("X")
      var Yindex = line.indexOf("Y")
      var Zindex = line.indexOf("Z")
      var Aindex = line.indexOf("A")
      var Zmindex = line.indexOf("Z-")
      var Findex = line.indexOf("F")

      if (Zindex >= 0 && !foundZUp) {
        if ($('#recoveryUseWpos').prop('checked')) {
          lineZ = line.slice(Zindex + 1)
          lineZ = "G0 Z" + parseFloat(lineZ)
          foundZUp = true
          foundZUpLine = i + 1;
        } else {
          lineZ = "G53 G0 Z-10"
          foundZUp = true // But not used
          foundZUpLine = i + 1;
        }

      }

      if (Xindex >= 0) {
        lineX = line.slice(Xindex + 1)
        lineX = "X" + parseFloat(lineX)
      }
      if (Yindex >= 0) {
        lineY = line.slice(Yindex + 1)
        lineY = "Y" + parseFloat(lineY)
      }
      if (Zmindex >= 0) {
        lineZm = line.slice(Zmindex + 1)
        lineZm = "Z" + parseFloat(lineZm)
      }
      if (Aindex >= 0) {
        lineA = line.slice(Aindex + 1)
        lineA = "A" + parseFloat(lineA)
      }
      if (Findex >= 0) {
        lineF = line.slice(Findex + 1)
        lineF = parseFloat(lineF)

        if (lineF > 0 && lineF >= lineFmin) {
          lineFmin = 'F' + lineF
        } else {
          lineFmax = 'F' + lineF
        }
      }
    }
  }

  var GcodeLineXYA = "G0" + lineX + lineY + lineA + lineFmax
  var GcodeLineZDown = "G1" + lineZm + lineFmin

  var resumeFileTemplate = `
    <form>
      <div>
        The Recovery strategy will modify the currently loaded GCODE accordingly:
        <hr>
          <ul>
            <li>Keep the first <span class="tally dark" id="resumeZUpLine"></span> lines of the file as header</li>
            <li>Raise Z with the GCODE: <span class="tally dark" id="resumeZUp"></span></li>
            <li><span id="spindleMsg" class="fg-darkRed">Spindle ON command not found! <span class="tally alert">Please start spindle before running job</span> </span></li>
            <li>Move to entry position with GCODE: <span class="tally dark" id="resumeXYA"></span></li>
            <li>Move to cutting height with GCODE: <span class="tally dark" id="resumeZm"></span></li>
            <li>Run GCODE starting at line <span class="tally dark" id="resumeLastLine"></span> and continue with the job</li>
          </ul>
        Review the recovery strategy and click 'Proceed' to update the loaded gcode to reflect the changes, and update the 3D view.
      </div>
    </form>
    <div class="remark warning">
      NOTE: Use this tool at your own risk. Recovering GCODE is a risky operation. You are also responsible for ensuring that work origin is correctly set</span>.  Use at your own risk.
    </div>
    `
  // Search backwards from start line to find last instance of spindle cmd
  for (var i = lineNumber - 1; i >= 0; i--) {
    currentLine = editor.session.getLine(i);
    if (currentLine.length > 0) {
      currentLine = currentLine.split(/[;(]/); // Remove everything after ; or ( = comment
      line = currentLine[0]
      line = line.toUpperCase();

      if (line.indexOf('M3') != -1 || line.indexOf('M4') != -1) {
        foundSpindle = true;
        spindle = line;
        // Search forward one line for pause cmd
        if (editor.session.getLine(i + 1).toUpperCase().indexOf('G4') != -1) {
          console.log('pause line? ' + editor.session.getLine(i + 1))
          spindle += '\n' + editor.session.getLine(i + 1).toUpperCase();
        }
        break;
      }
    }
  }

  Metro.dialog.create({
    title: "<i class='fas fa-fw fa-route'></i> Recover Job From Line Number",
    content: resumeFileTemplate,
    toTop: true,
    width: '75%',
    clsDialog: 'dark',
    actions: [{
        caption: "Proceed to next step",
        cls: "js-dialog-close alert",
        onclick: function() {
          redoJob();
        }
      },
      {
        caption: "Cancel",
        cls: "js-dialog-close",
        onclick: function() {}
      }
    ]
  });

  $('#resumeZUpLine').html(foundZUpLine);
  $('#resumeZUp').html(lineZ);
  $('#resumeLastLine').html(lineNumber);
  $('#resumeXYA').html(GcodeLineXYA);
  $('#resumeZm').html(GcodeLineZDown);

  if (spindle) {
    $('#spindleMsg').html("Turn spindle ON: <span class='tally dark' id='resumeSpindle'>" + spindle + "</span> ");
    $('#resumeSpindle').html(spindle);
  }

  //Metro.dialog.open("#ResumeFileDialog");
}

function redoJob() {
  var line = "";
  gcode = "; Recovered GCODE Use at your OWN RISK\n";

  var startLineNumber = $('#resumeZUpLine').html();
  var XYAGcode = $('#resumeXYA').html();
  var ZGcode = $('#resumeZm').html();
  var resumeLineNumber = $('#resumeLastLine').html();
  var resumeLastNumber = editor.session.getLength();
  if ($('#resumeSpindle').html() != undefined) {
    var spindleGcode = $('#resumeSpindle').html();
  } else {
    var spindleGcode = '';
  }



  for (var i = 0; i < startLineNumber; i++) {
    line = editor.session.getLine(i);
    gcode += line + '\n'
  }

  if (spindleGcode != '') {
    gcode += spindleGcode + '\n';
  }

  gcode += XYAGcode + '\n';
  gcode += ZGcode + '\n';

  for (var i = resumeLineNumber - 1; i < resumeLastNumber; i++) {
    line = editor.session.getLine(i);
    gcode += line + '\n'
  }

  editor.session.setValue("");
  editor.session.setValue(gcode);
  $('#controlTab').click();
  parseGcodeInWebWorker(gcode);
}