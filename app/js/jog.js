var allowContinuousJog = false;
var continuousJogRunning = false;
var jogdistXYZ = 10;
var jogdistA = 10;
var safeToUpdateSliders = true;
var jogRateX = 4000
var jogRateY = 4000
var jogRateZ = 2000
var jogRateA = 2000

// P7: single row of 5 mutually-exclusive choices (0.1/1/10/100/CONT) replacing
// the old separate Incremental/Continuous toggle + 4 distance buttons.
// jogDistanceButtonValues maps each button's id to the value selectJogDistance()
// expects - kept id-based (no HTML data-attributes) to match this file's
// existing convention of hooking behaviour off element ids.
var jogDistanceButtonValues = {
  'dist01': '0.1',
  'dist1': '1',
  'dist10': '10',
  'dist100': '100',
  'distCONT': 'CONT'
};

function highlightJogDistanceButton(id) {
  // P8: one unified "selected" style (solid bright green, .jogmode-active
  // in app/css/main.css) across all 5 mutually-exclusive choices - the
  // 4 fixed distances AND CONTINUOUS JOG - instead of the old
  // border-only orange highlight. Deliberately a class of its own, NOT
  // .toggle-btn-on (ATC/Router/Laser's solid-orange active state) - this
  // group's color language is intentionally different and shouldn't drag
  // those other toggles' color along if either one changes later.
  $('.distbtn').removeClass('bd-orange jogmode-active');
  $('.jogdistXYZ, #distCONTlabel').removeClass('fg-orange').addClass('fg-gray');
  $('#' + id).addClass('jogmode-active');
  // .fg-gray must come off the now-selected label too: #distCONTlabel.fg-gray
  // is an ID selector in app/css/main.css (darkens the unselected text), and
  // an ID selector beats .jogmode-active .fa-layers-text's two classes no
  // matter which has !important - leaving fg-gray on would keep CONTINUOUS
  // JOG's text dark gray instead of white even while jogmode-active is solid
  // green (the 4 distance labels don't hit this since .jogdistXYZ.fg-gray is
  // class-only, same specificity, and simply loses to the later rule).
  $('#' + id + 'label').removeClass('fg-gray');
}

// Maps the CURRENT jogdistXYZ number (mm or inch) back to the button id that
// represents it, so callers that only know "go back to incremental" (not
// which specific distance) can re-highlight the right button.
function jogDistanceButtonIdFor(jogdist) {
  var v = parseFloat(jogdist);
  if (v == 0.1 || v == 0.0254) return 'dist01';
  if (v == 1 || v == 0.254) return 'dist1';
  if (v == 10 || v == 2.54) return 'dist10';
  if (v == 100 || v == 25.4) return 'dist100';
  return 'dist10'; // fallback - matches the static HTML's default-highlighted button
}

// value: '0.1' | '1' | '10' | '100' (always expressed as if unit=="mm") | 'CONT'
function selectJogDistance(value) {
  if (value == 'CONT') {
    localStorage.setItem('continuousJog', true);
    allowContinuousJog = true;
    highlightJogDistanceButton('distCONT');
    return;
  }
  localStorage.setItem('continuousJog', false);
  allowContinuousJog = false;
  var mmToInch = {
    '0.1': 0.0254,
    '1': 0.254,
    '10': 2.54,
    '100': 25.4
  };
  jogdistXYZ = (unit == "in") ? mmToInch[value] : parseFloat(value);
  highlightJogDistanceButton(jogDistanceButtonIdFor(value));
}

// Switch to Incremental without changing which distance was last selected -
// used where the caller only knows "leave continuous mode" (keyboard step
// keys, the probe wizard's post-probe restore), not a specific distance.
function setIncrementalMode() {
  localStorage.setItem('continuousJog', false);
  allowContinuousJog = false;
  highlightJogDistanceButton(jogDistanceButtonIdFor(jogdistXYZ));
}

function setContinuousMode() {
  selectJogDistance('CONT');
}

function jogOverride(newVal) {
  if (grblParams.hasOwnProperty('$110')) {
    jogRateX = (grblParams['$110'] * (newVal / 100)).toFixed(0);
    jogRateY = (grblParams['$111'] * (newVal / 100)).toFixed(0);
    jogRateZ = (grblParams['$112'] * (newVal / 100)).toFixed(0);

    $('#jro').data('slider').val(newVal)
  }
  if (grblParams.hasOwnProperty('$113')) {
    jogRateA = (grblParams['$113'] * (newVal / 100)).toFixed(0);
  }
  localStorage.setItem('jogOverride', newVal);
}

function setADist(newADist) {
  $("#distAAxislabel").html("A: " + newADist + " deg")
  jogdistA = newADist;
}

// Startup units. Only an explicit, saved "in" gives inch-mode; a saved "mm", nothing saved (a fresh
// install, a new profile, a phone browser that never chose) and anything unrecognised all give mm-mode -
// the default. (This used to default to inches.) It is a display preference only; firmware $13 is not
// involved (CONTROL needs $13=0 and handles inches itself).
function restoreUnitsMode() {
  var saved = null;
  try {
    saved = localStorage.getItem('unitsMode');
  } catch (e) {}
  if (saved == "in") {
    inMode();
    $('#inMode').click()
  } else {
    mmMode(); // also (re)writes the saved value, so an unrecognised one is repaired
    $('#mmMode').click()
  }
}

function mmMode() {
  unit = "mm";
  localStorage.setItem('unitsMode', unit);
  $('#dist01label').html('0.1mm')
  $('#dist1label').html('1mm')
  $('#dist10label').html('10mm')
  $('#dist100label').html('100mm')
  if (jogdistXYZ == 0.0254) {
    jogdistXYZ = 0.1
  }
  if (jogdistXYZ == 0.254) {
    jogdistXYZ = 1
  }
  if (jogdistXYZ == 2.54) {
    jogdistXYZ = 10
  }
  if (jogdistXYZ == 25.4) {
    jogdistXYZ = 100
  }
  if (typeof object !== 'undefined') {
    if (object.userData.inch) {
      if (typeof redrawGrid === "function") { // Check if function exists, because in Mobile view it does not
        redrawGrid(object.userData.bbbox2.min.x * 25.4, object.userData.bbbox2.max.x * 25.4, object.userData.bbbox2.min.y * 25.4, object.userData.bbbox2.max.y * 25.4, false);
      }
    } else {
      if (typeof redrawGrid === "function") { // Check if function exists, because in Mobile view it does not
        redrawGrid(object.userData.bbbox2.min.x, object.userData.bbbox2.max.x, object.userData.bbbox2.min.y, object.userData.bbbox2.max.y, false);
      }
    }
  } else {
    if (typeof redrawGrid === "function") { // Check if function exists, because in Mobile view it does not
      redrawGrid(xmin, xmax, ymin, ymax, false);
    }
  }
}

function inMode() {
  unit = "in";
  localStorage.setItem('unitsMode', unit);
  $('#dist01label').html('0.001"')
  $('#dist1label').html('0.01"')
  $('#dist10label').html('0.1"')
  $('#dist100label').html('1"')
  if (jogdistXYZ == 0.1) {
    jogdistXYZ = 0.0254
  }
  if (jogdistXYZ == 1) {
    jogdistXYZ = 0.254
  }
  if (jogdistXYZ == 10) {
    jogdistXYZ = 2.54
  }
  if (jogdistXYZ == 100) {
    jogdistXYZ = 25.4
  }

  if (typeof object !== 'undefined') {
    if (object.userData.inch) {
      if (typeof redrawGrid === "function") { // Check if function exists, because in Mobile view it does not
        redrawGrid(object.userData.bbbox2.min.x, object.userData.bbbox2.max.x, object.userData.bbbox2.min.y, object.userData.bbbox2.max.y, true);
      }
    } else {
      if (typeof redrawGrid === "function") { // Check if function exists, because in Mobile view it does not
        redrawGrid(object.userData.bbbox2.min.x / 25.4, object.userData.bbbox2.max.x / 25.4, object.userData.bbbox2.min.y / 25.4, object.userData.bbbox2.max.y / 25.4, true);
      }
    }
  } else {
    if (typeof redrawGrid === "function") { // Check if function exists, because in Mobile view it does not
      redrawGrid(xmin / 25.4, xmax / 25.4, ymin / 25.4, ymax / 25.4, true);
    }
  }

}

function cancelJog() {
  socket.emit('stop', {
    stop: false,
    jog: true,
    abort: false
  })
  continuousJogRunning = false;
}


$(document).ready(function() {

  // P7: restore last-used mode (Incremental at its last distance, or
  // Continuous) - if nothing was ever saved, leave the static HTML default
  // (10mm, already marked bd-orange in the markup) alone.
  if (localStorage.getItem('continuousJog')) {
    if (JSON.parse(localStorage.getItem('continuousJog')) == true) {
      setContinuousMode();
    } else {
      setIncrementalMode();
    }
  }

  $('#dist01, #dist1, #dist10, #dist100, #distCONT').on('click', function(ev) {
    selectJogDistance(jogDistanceButtonValues[this.id]);
    document.activeElement.blur();
  });

  restoreUnitsMode();
  restoreToolChangeMode();

  $(document).mousedown(function(e) {
    safeToUpdateSliders = false;
  }).mouseup(function(e) {
    safeToUpdateSliders = true;
    // Added to cancel Jog moves even when user moved the mouse off the button before releasing
    if (allowContinuousJog) {
      if (continuousJogRunning) {
        cancelJog()
      }
    }
  }).mouseleave(function(e) {
    safeToUpdateSliders = true;
  });

  $("#xPosDro").click(function() {
    $("#xPos").hide()
    $("#xPosDro").addClass("drop-shadow");
    if (unit == "mm") {
      $("#xPosInput").show().focus().val(laststatus.machine.position.work.x)
    } else if (unit == "in") {
      $("#xPosInput").show().focus().val((laststatus.machine.position.work.x / 25.4).toFixed(3))
    }
    document.getElementById("xPosInput").select();
  });

  $("#xPosInput").blur(function() {
    $("#xPosDro").removeClass("drop-shadow");
    $("#xPos").show()
    $("#xPosInput").hide()
  });

  $('#xPosInput').on('keypress', function(e) {
    console.log(e)
    if (e.key === "Enter" || e.key === "NumpadEnter") {
      //Disable textbox to prevent multiple submit
      $(this).attr("disabled", "disabled");
      $("#xPos").show()
      $("#xPosInput").hide()
      //Enable the textbox again if needed.
      $(this).removeAttr("disabled");
      if (unit == "mm") {
        if (e.shiftKey) {
          sendGcode("G21\nG10 P0 L20 X" + $("#xPosInput").val());
        } else {
          sendGcode("$J=G90 G21 X" + $("#xPosInput").val() + " F" + jogRateX);
        }

      } else if (unit == "in") {
        if (e.shiftKey) {
          sendGcode("G21\nG10 P0 L20 X" + ($("#xPosInput").val() * 25.4));
        } else {
          sendGcode("$J=G90 G20 X" + $("#xPosInput").val() + " F" + jogRateX);
        }
      }
    }
  });

  $("#yPosDro").click(function() {
    $("#yPos").hide()
    $("#yPosDro").addClass("drop-shadow");
    if (unit == "mm") {
      $("#yPosInput").show().focus().val(laststatus.machine.position.work.y)
    } else if (unit == "in") {
      $("#yPosInput").show().focus().val((laststatus.machine.position.work.y / 25.4).toFixed(3))
    }
    document.getElementById("yPosInput").select();
  });

  $("#yPosInput").blur(function() {
    $("#yPos").show()
    $("#yPosDro").removeClass("drop-shadow");
    $("#yPosInput").hide()
  });

  $('#yPosInput').on('keypress', function(e) {
    if (e.which === 13) {
      //Disable textbox to prevent multiple submit
      $(this).attr("disabled", "disabled");
      $("#yPos").show()
      $("#yPosInput").hide()
      //Enable the textbox again if needed.
      $(this).removeAttr("disabled");
      if (unit == "mm") {
        if (e.shiftKey) {
          sendGcode("G21\nG10 P0 L20 Y" + $("#yPosInput").val());
        } else {
          sendGcode("$J=G90 G21 Y" + $("#yPosInput").val() + " F" + jogRateY);
        }
      } else if (unit == "in") {
        if (e.shiftKey) {
          sendGcode("G21\nG10 P0 L20 Y" + ($("#yPosInput").val() * 25.4));
        } else {
          sendGcode("$J=G90 G20 Y" + $("#yPosInput").val() + " F" + jogRateY);
        }
      }
    }
  });

  $("#zPosDro").click(function() {
    $("#zPos").hide()
    $("#zPosDro").addClass("drop-shadow");
    if (unit == "mm") {
      $("#zPosInput").show().focus().val(laststatus.machine.position.work.z)
    } else if (unit == "in") {
      $("#zPosInput").show().focus().val((laststatus.machine.position.work.z / 25.4).toFixed(3))
    }
    document.getElementById("zPosInput").select();
  });

  $("#zPosInput").blur(function() {
    $("#zPos").show()
    $("#zPosDro").removeClass("drop-shadow");
    $("#zPosInput").hide()
  });

  $('#zPosInput').on('keypress', function(e) {
    if (e.which === 13) {
      //Disable textbox to prevent multiple submit
      $(this).attr("disabled", "disabled");
      $("#zPos").show()
      $("#zPosInput").hide()
      //Enable the textbox again if needed.
      $(this).removeAttr("disabled");
      if (unit == "mm") {
        if (e.shiftKey) {
          sendGcode("G21\nG10 P0 L20 Z" + $("#zPosInput").val());
        } else {
          sendGcode("$J=G90 G21 Z" + $("#zPosInput").val() + " F" + jogRateZ);
        }
      } else if (unit == "in") {
        if (e.shiftKey) {
          sendGcode("G21\nG10 P0 L20 Z" + ($("#zPosInput").val() * 25.4));
        } else {
          sendGcode("$J=G90 G20 Z" + $("#zPosInput").val() + " F" + jogRateZ);
        }
      }
    }
  });


  // A Axis DRO entry
  $("#aPosDro").click(function() {
    $("#aPos").hide()
    $("#aPosDro").addClass("drop-shadow");
    $("#aPosInput").show().focus().val(laststatus.machine.position.work.a)
    document.getElementById("aPosInput").select();
  });

  $("#aPosInput").blur(function() {
    $("#aPos").show()
    $("#aPosDro").removeClass("drop-shadow");
    $("#aPosInput").hide()
  });

  $('#aPosInput').on('keypress', function(e) {
    if (e.which === 13) {
      //Disable textbox to prevent multiple submit
      $(this).attr("disabled", "disabled");
      $("#aPos").show()
      $("#aPosInput").hide()
      //Enable the textbox again if needed.
      $(this).removeAttr("disabled");

      if (e.shiftKey) {
        sendGcode("G21\nG10 P0 L20 A" + $("#aPosInput").val());
      } else {
        sendGcode("$J=G90 G21 A" + $("#aPosInput").val() + " F" + jogRateA);
      }

    }
  });

  // End A-Axis DRO Entry


  $('#gotozeroWPos').on('click', function(ev) {
    sendGcode('G21 G90');
    sendGcode('G0 Z5');
    sendGcode('G0 X0 Y0');
    sendGcode('G0 Z0');
  });

  $('#gotoXzeroMpos').on('click', function(ev) {
    if (grblParams['$22'] == 1) {
      sendGcode('G53 G0 X-' + grblParams["$27"]);
    } else {
      sendGcode('G53 G0 X0');
    }
  });

  $('#gotoYzeroMpos').on('click', function(ev) {
    if (grblParams['$22'] == 1) {
      sendGcode('G53 G0 Y-' + grblParams["$27"]);
    } else {
      sendGcode('G53 G0 Y0');
    }
  });

  $('#gotoZzeroMpos').on('click', function(ev) {
    if (grblParams['$22'] == 1) {
      sendGcode('G53 G0 Z-' + grblParams["$27"]);
    } else {
      sendGcode('G53 G0 Z0');
    }
  });

  $('#gotozeroZmPosXYwPos').on('click', function(ev) {
    if (grblParams['$22'] == 1) {
      sendGcode('G53 G0 Z-' + grblParams["$27"]);
    } else {
      sendGcode('G53 G0 Z0');
    }
    sendGcode('G0 X0 Y0');
    sendGcode('G0 Z0');
  });

  $('#gotozeroMPos').on('click', function(ev) {
    if (grblParams['$22'] == 1) {
      sendGcode('G53 G0 Z-' + grblParams["$27"]);
      sendGcode('G53 G0 X-' + grblParams["$27"] + ' Y-' + grblParams["$27"]);
    } else {
      sendGcode('G53 G0 Z0');
      sendGcode('G53 G0 X0 Y0');
    }
  });




  $('.xM').on('touchstart mousedown', function(ev) {
    //console.log(ev)
    if (ev.which > 1) {
      return
    }
    ev.preventDefault();
    var hasSoftLimits = false;
    if (Object.keys(grblParams).length > 0) {
      if (parseInt(grblParams.$20) == 1) {
        hasSoftLimits = true;
      }
    }
    if (allowContinuousJog) { // startJog();
      if (!waitingForStatus && laststatus.comms.runStatus == "Idle" || laststatus.comms.runStatus == "Door:0") {
        var direction = "X-";
        var distance = 1000;

        if (hasSoftLimits) {
          // Soft Limits is enabled so lets calculate maximum move distance
          var mindistance = parseInt(grblParams.$130)
          var maxdistance = 0; // Grbl all negative coordinates
          // Negative move:
          distance = (mindistance + (parseFloat(laststatus.machine.position.offset.x) + parseFloat(laststatus.machine.position.work.x))) - 1
          distance = distance.toFixed(3);
          if (distance < 1) {
            toastJogWillHit("X-");
          }
        }

        if (distance >= 1) {
          socket.emit('runCommand', "$J=G91 G21 " + direction + distance + " F" + jogRateX + "\n");
          continuousJogRunning = true;
          waitingForStatus = true;
          $('.xM').click();
        }
      } else {
        toastJogNotIdle();
      }
    } else {
      jog('X', '-' + jogdistXYZ, jogRateX);
    }
    $('#runNewProbeBtn').addClass("disabled")
    $('#confirmNewProbeBtn').removeClass("disabled")
  });
  $('.xM').on('touchend mouseup', function(ev) {
    ev.preventDefault();
    if (allowContinuousJog) {
      cancelJog()
    }
  });

  $('.xP').on('touchstart mousedown', function(ev) {
    // console.log("xp down")
    if (ev.which > 1) {
      return
    }
    ev.preventDefault();
    var hasSoftLimits = false;
    if (Object.keys(grblParams).length > 0) {
      if (parseInt(grblParams.$20) == 1) {
        hasSoftLimits = true;
      }
    }
    if (allowContinuousJog) { // startJog();
      if (!waitingForStatus && laststatus.comms.runStatus == "Idle" || laststatus.comms.runStatus == "Door:0") {
        var direction = "X";
        var distance = 1000;
        if (hasSoftLimits) {
          // Soft Limits is enabled so lets calculate maximum move distance
          var mindistance = parseInt(grblParams.$130)
          var maxdistance = 0; // Grbl all negative coordinates
          // Positive move:
          distance = (maxdistance - (parseFloat(laststatus.machine.position.offset.x) + parseFloat(laststatus.machine.position.work.x))) - 1
          distance = distance.toFixed(3);
          if (distance < 1) {
            toastJogWillHit("X+");
          }
        }
        if (distance >= 1) {
          socket.emit('runCommand', "$J=G91 G21 " + direction + distance + " F" + jogRateX + "\n");
          continuousJogRunning = true;
          waitingForStatus = true;
          $('.xP').click();
        }
      } else {
        toastJogNotIdle();
      }
    } else {
      jog('X', jogdistXYZ, jogRateX);
    }
    $('#runNewProbeBtn').addClass("disabled")
    $('#confirmNewProbeBtn').removeClass("disabled")
  });
  $('.xP').on('touchend mouseup', function(ev) {
    // console.log("xp up")
    ev.preventDefault();
    if (allowContinuousJog) {
      cancelJog()
    }
  });

  $('.yM').on('touchstart mousedown', function(ev) {
    if (ev.which > 1) { // Ignore middle and right click
      return
    }
    ev.preventDefault();
    var hasSoftLimits = false;
    if (Object.keys(grblParams).length > 0) {
      if (parseInt(grblParams.$20) == 1) {
        hasSoftLimits = true;
      }
    }
    if (allowContinuousJog) { // startJog();
      if (!waitingForStatus && laststatus.comms.runStatus == "Idle" || laststatus.comms.runStatus == "Door:0") {
        var direction = "Y-";
        var distance = 1000;

        if (hasSoftLimits) {
          // Soft Limits is enabled so lets calculate maximum move distance
          var mindistance = parseInt(grblParams.$131)
          var maxdistance = 0; // Grbl all negative coordinates
          // Negative move:
          distance = (mindistance + (parseFloat(laststatus.machine.position.offset.y) + parseFloat(laststatus.machine.position.work.y))) - 1
          distance = distance.toFixed(3);
          if (distance < 1) {
            toastJogWillHit("Y-");
          }
        }

        if (distance >= 1) {
          socket.emit('runCommand', "$J=G91 G21 " + direction + distance + " F" + jogRateY + "\n");
          continuousJogRunning = true;
          waitingForStatus = true;
          $('.yM').click();
        }
      } else {
        toastJogNotIdle();
      }
    } else {
      jog('Y', '-' + jogdistXYZ, jogRateY);
    }
    $('#runNewProbeBtn').addClass("disabled")
    $('#confirmNewProbeBtn').removeClass("disabled")
  });
  $('.yM').on('touchend mouseup', function(ev) {
    ev.preventDefault();
    if (allowContinuousJog) {
      cancelJog()
    }
  });

  $('.yP').on('touchstart mousedown', function(ev) {
    if (ev.which > 1) { // Ignore middle and right click
      return
    }
    ev.preventDefault();
    var hasSoftLimits = false;
    if (Object.keys(grblParams).length > 0) {
      if (parseInt(grblParams.$20) == 1) {
        hasSoftLimits = true;
      }
    }
    if (allowContinuousJog) { // startJog();
      if (!waitingForStatus && laststatus.comms.runStatus == "Idle" || laststatus.comms.runStatus == "Door:0") {
        var direction = "Y";
        var distance = 1000;

        if (hasSoftLimits) {
          // Soft Limits is enabled so lets calculate maximum move distance
          var mindistance = parseInt(grblParams.$131)
          var maxdistance = 0; // Grbl all negative coordinates
          // Positive move:
          distance = (maxdistance - (parseFloat(laststatus.machine.position.offset.y) + parseFloat(laststatus.machine.position.work.y))) - 1
          distance = distance.toFixed(3);
          if (distance < 1) {
            toastJogWillHit("Y+");
          }
        }

        if (distance >= 1) {
          socket.emit('runCommand', "$J=G91 G21 " + direction + distance + " F" + jogRateY + "\n");
          continuousJogRunning = true;
          waitingForStatus = true;
          $('#yP').click();
        }
      } else {
        toastJogNotIdle();
      }
    } else {
      jog('Y', jogdistXYZ, jogRateY);
    }
    $('#runNewProbeBtn').addClass("disabled")
    $('#confirmNewProbeBtn').removeClass("disabled")
  });
  $('.yP').on('touchend mouseup', function(ev) {
    ev.preventDefault();
    if (allowContinuousJog) {
      cancelJog()
    }
  });

  $('.zM').on('touchstart mousedown', function(ev) {
    if (ev.which > 1) { // Ignore middle and right click
      return
    }
    ev.preventDefault();
    var hasSoftLimits = false;
    if (Object.keys(grblParams).length > 0) {
      if (parseInt(grblParams.$20) == 1) {
        hasSoftLimits = true;
      }
    }
    if (allowContinuousJog) { // startJog();
      if (!waitingForStatus && laststatus.comms.runStatus == "Idle" || laststatus.comms.runStatus == "Door:0") {
        var direction = "Z-";
        var distance = 1000;

        if (hasSoftLimits) {
          // Soft Limits is enabled so lets calculate maximum move distance
          var mindistance = parseInt(grblParams.$132)
          var maxdistance = 0; // Grbl all negative coordinates
          // Negative move:
          distance = (mindistance + (parseFloat(laststatus.machine.position.offset.z) + parseFloat(laststatus.machine.position.work.z))) - 1
          distance = distance.toFixed(3);
          if (distance < 1) {
            toastJogWillHit("Z-");
          }
        }

        if (distance >= 1) {
          socket.emit('runCommand', "$J=G91 G21 " + direction + distance + " F" + jogRateZ + "\n");
          continuousJogRunning = true;
          waitingForStatus = true;
          $('.zM').click();
        }
      } else {
        toastJogNotIdle();
      }
    } else {
      jog('Z', '-' + jogdistXYZ, jogRateZ);
    }
    $('#runNewProbeBtn').addClass("disabled")
    $('#confirmNewProbeBtn').removeClass("disabled")
  });
  $('.zM').on('touchend mouseup', function(ev) {
    ev.preventDefault();
    if (allowContinuousJog) {
      cancelJog()
    }
  });

  $('.zP').on('touchstart mousedown', function(ev) {
    if (ev.which > 1) { // Ignore middle and right click
      return
    }
    ev.preventDefault();
    var hasSoftLimits = false;
    if (Object.keys(grblParams).length > 0) {
      if (parseInt(grblParams.$20) == 1) {
        hasSoftLimits = true;
      }
    }
    if (allowContinuousJog) { // startJog();
      if (!waitingForStatus && laststatus.comms.runStatus == "Idle" || laststatus.comms.runStatus == "Door:0") {
        var direction = "Z";
        var distance = 1000;

        if (hasSoftLimits) {
          // Soft Limits is enabled so lets calculate maximum move distance
          var mindistance = parseInt(grblParams.$132)
          var maxdistance = 0; // Grbl all negative coordinates
          // Positive move:
          distance = (maxdistance - (parseFloat(laststatus.machine.position.offset.z) + parseFloat(laststatus.machine.position.work.z))) - 1
          distance = distance.toFixed(3);
          if (distance < 1) {
            toastJogWillHit("Z+");
          }
        }

        if (distance >= 1) {
          socket.emit('runCommand', "$J=G91 G21 " + direction + distance + " F" + jogRateZ + "\n");
          continuousJogRunning = true;
          waitingForStatus = true;
          $('.zP').click();
        }
      } else {
        toastJogNotIdle();
      }
    } else {
      jog('Z', jogdistXYZ, jogRateZ);
    }
    $('#runNewProbeBtn').addClass("disabled")
    $('#confirmNewProbeBtn').removeClass("disabled")
  });
  $('.zP').on('touchend mouseup', function(ev) {
    ev.preventDefault();
    if (allowContinuousJog) {
      cancelJog()
    }
  });

  // P7: 4 diagonal (X+Y combined) jog buttons, same mousedown/mouseup pattern
  // as the single-axis buttons above, using the existing jogXY()/'jogXY'
  // socket event (index.js already builds "$J=G91G21X<x> Y<y> F<feed>" from
  // it - it just had no button wired up to it before now).
  bindDiagonalJog('.xPyP', 1, 1); // NE: X+, Y+
  bindDiagonalJog('.xMyP', -1, 1); // NW: X-, Y+
  bindDiagonalJog('.xPyM', 1, -1); // SE: X+, Y-
  bindDiagonalJog('.xMyM', -1, -1); // SW: X-, Y-

  $('.aM').on('touchstart mousedown', function(ev) {
    if (ev.which > 1) { // Ignore middle and right click
      return
    }
    ev.preventDefault();
    var hasSoftLimits = false;
    if (Object.keys(grblParams).length > 0) {
      if (parseInt(grblParams.$20) == 1) {
        hasSoftLimits = true;
      }
    }
    if (allowContinuousJog) { // startJog();
      if (!waitingForStatus && laststatus.comms.runStatus == "Idle" || laststatus.comms.runStatus == "Door:0") {
        var direction = "A-";
        var distance = 1000;

        if (hasSoftLimits) {
          // Soft Limits is enabled so lets calculate maximum move distance
          var mindistance = parseInt(grblParams.$133)
          var maxdistance = 0; // Grbl all negative coordinates
          // Negative move:
          distance = (mindistance + (parseFloat(laststatus.machine.position.offset.a) + parseFloat(laststatus.machine.position.work.a))) - 1
          distance = distance.toFixed(3);
          if (distance < 1) {
            toastJogWillHit("A-");
          }
        }

        if (distance >= 1) {
          socket.emit('runCommand', "$J=G91 G21 " + direction + distance + " F" + jogRateA + "\n");
          continuousJogRunning = true;
          waitingForStatus = true;
          $('.aM').click();
        }
      } else {
        toastJogNotIdle();
      }
    } else {
      jog('A', '-' + jogdistA, jogRateA);
    }
    $('#runNewProbeBtn').addClass("disabled")
    $('#confirmNewProbeBtn').removeClass("disabled")
  });
  $('.aM').on('touchend mouseup', function(ev) {
    ev.preventDefault();
    if (allowContinuousJog) {
      cancelJog()
    }
  });

  $('.aP').on('touchstart mousedown', function(ev) {
    if (ev.which > 1) { // Ignore middle and right click
      return
    }
    ev.preventDefault();
    var hasSoftLimits = false;
    if (Object.keys(grblParams).length > 0) {
      if (parseInt(grblParams.$20) == 1) {
        hasSoftLimits = true;
      }
    }
    if (allowContinuousJog) { // startJog();
      if (!waitingForStatus && laststatus.comms.runStatus == "Idle" || laststatus.comms.runStatus == "Door:0") {
        var direction = "A";
        var distance = 1000;

        if (hasSoftLimits) {
          // Soft Limits is enabled so lets calculate maximum move distance
          var mindistance = parseInt(grblParams.$133)
          var maxdistance = 0; // Grbl all negative coordinates
          // Positive move:
          distance = (maxdistance - (parseFloat(laststatus.machine.position.offset.a) + parseFloat(laststatus.machine.position.work.a))) - 1
          distance = distance.toFixed(3);
          if (distance < 1) {
            toastJogWillHit("A+");
          }
        }

        if (distance >= 1) {
          socket.emit('runCommand', "$J=G91 G21 " + direction + distance + " F" + jogRateA + "\n");
          continuousJogRunning = true;
          waitingForStatus = true;
          $('.aP').click();
        }
      } else {
        toastJogNotIdle();
      }
    } else {
      jog('A', jogdistA, jogRateA);
    }
    $('#runNewProbeBtn').addClass("disabled")
    $('#confirmNewProbeBtn').removeClass("disabled")
  });
  $('.aP').on('touchend mouseup', function(ev) {
    ev.preventDefault();
    if (allowContinuousJog) {
      cancelJog()
    }
  });


  $('#homeBtn').on('click', function(ev) {
    home();
  })

  // P7: Stop Jog button, center of the 3x3 diagonal grid - cancels the
  // current jog move (GRBL/grblHAL real-time jog-cancel, 0x85, via the
  // existing cancelJog()) without a full E-Stop/reset. Works regardless of
  // Incremental/Continuous mode.
  $('#stopJog').on('click', function(ev) {
    cancelJog();
  })

  $('#chkSize').on('click', function() {
    var bbox2 = new THREE.Box3().setFromObject(object);
    console.log('bbox for Draw Bounding Box: ' + object + ' Min X: ', (bbox2.min.x), '  Max X:', (bbox2.max.x), 'Min Y: ', (bbox2.min.y), '  Max Y:', (bbox2.max.y));
    var feedrate = 5000
    if (laststatus.machine.firmware.type === 'grbl') {
      var moves = `
        $J=G90G21X` + (bbox2.min.x).toFixed(3) + ` Y` + (bbox2.min.y).toFixed(3) + ` F` + feedrate + `\n
        $J=G90G21X` + (bbox2.max.x).toFixed(3) + ` Y` + (bbox2.min.y).toFixed(3) + ` F` + feedrate + `\n
        $J=G90G21X` + (bbox2.max.x).toFixed(3) + ` Y` + (bbox2.max.y).toFixed(3) + ` F` + feedrate + `\n
        $J=G90G21X` + (bbox2.min.x).toFixed(3) + ` Y` + (bbox2.max.y).toFixed(3) + ` F` + feedrate + `\n
        $J=G90G21X` + (bbox2.min.x).toFixed(3) + ` Y` + (bbox2.min.y).toFixed(3) + ` F` + feedrate + `\n
        `;
    } else {
      var moves = `
       G90\n
       G0 X` + (bbox2.min.x).toFixed(3) + ` Y` + (bbox2.min.y).toFixed(3) + ` F` + feedrate + `\n
       G0 X` + (bbox2.max.x).toFixed(3) + ` Y` + (bbox2.min.y).toFixed(3) + ` F` + feedrate + `\n
       G0 X` + (bbox2.max.x).toFixed(3) + ` Y` + (bbox2.max.y).toFixed(3) + ` F` + feedrate + `\n
       G0 X` + (bbox2.min.x).toFixed(3) + ` Y` + (bbox2.max.y).toFixed(3) + ` F` + feedrate + `\n
       G0 X` + (bbox2.min.x).toFixed(3) + ` Y` + (bbox2.min.y).toFixed(3) + ` F` + feedrate + `\n
       G90\n`;
    }
    socket.emit('runJob', {
      data: moves,
      isJob: false,
      fileName: ""
    });
  });

});

// P7: step the Incremental distance up/down (keyboard step+/step- shortcuts).
// Always forces Incremental mode - if CONT was active, jogdistXYZ still
// holds whatever numeric distance was last selected (selectJogDistance('CONT')
// never touches it), so stepping from CONT resumes from that value.
function changeStepSize(dir) {
  $('.distbtn').blur();
  var steps = ['0.1', '1', '10', '100'];
  var currentId = jogDistanceButtonIdFor(jogdistXYZ);
  var idx = ['dist01', 'dist1', 'dist10', 'dist100'].indexOf(currentId);
  if (idx == -1) idx = 2; // shouldn't happen - fall back to 10mm
  idx = Math.min(steps.length - 1, Math.max(0, idx + dir));
  selectJogDistance(steps[idx]);
}

function jog(dir, dist, feed = null) {
  if (feed) {
    socket.emit('jog', dir + ',' + dist + ',' + feed);
  } else {
    socket.emit('jog', dir + ',' + dist);
  }
}

function jogXY(xincrement, yincrement, feed = null) {
  var data = {
    x: xincrement,
    y: yincrement,
    feed: feed
  }
  socket.emit('jogXY', data);
}

// P7: continuous-jog distance for one axis and direction, mirroring the
// per-axis soft-limit clamping already used individually by the .xM/.xP/
// .yM/.yP/.zM/.zP handlers above (same formula, just parametrized so the
// 4 diagonal buttons don't need to duplicate it twice each). Returns a
// positive magnitude; callers combine it with their own sign. A value below
// 1 means "would immediately hit the soft limit", matching the existing
// `if (distance < 1)` guard used everywhere else in this file.
function calcContinuousJogDistance(axisLetter, sign) {
  var hasSoftLimits = false;
  if (Object.keys(grblParams).length > 0) {
    if (parseInt(grblParams.$20) == 1) {
      hasSoftLimits = true;
    }
  }
  if (!hasSoftLimits) {
    return 1000;
  }
  var maxTravelKey = {
    X: '$130',
    Y: '$131',
    Z: '$132'
  }[axisLetter];
  var posKey = {
    X: 'x',
    Y: 'y',
    Z: 'z'
  }[axisLetter];
  var maxTravel = parseInt(grblParams[maxTravelKey]);
  var currentPos = parseFloat(laststatus.machine.position.offset[posKey]) + parseFloat(laststatus.machine.position.work[posKey]);
  if (sign > 0) {
    return (0 - currentPos - 1);
  } else {
    return (maxTravel + currentPos - 1);
  }
}

// P7: binds mousedown/mouseup for one diagonal jog button, following the
// exact same Continuous-vs-Incremental branching as the single-axis
// handlers above, just moving X and Y together in one $J= command via
// jogXY()/'jogXY' instead of one axis via jog()/'jog'.
function bindDiagonalJog(selector, xSign, ySign) {
  $(selector).on('touchstart mousedown', function(ev) {
    if (ev.which > 1) {
      return
    }
    ev.preventDefault();
    if (allowContinuousJog) {
      if (!waitingForStatus && laststatus.comms.runStatus == "Idle" || laststatus.comms.runStatus == "Door:0") {
        var xDist = calcContinuousJogDistance('X', xSign);
        var yDist = calcContinuousJogDistance('Y', ySign);
        if (xDist < 1 || yDist < 1) {
          toastJogWillHit((xSign > 0 ? "X+" : "X-") + "/" + (ySign > 0 ? "Y+" : "Y-"));
        } else {
          var feed = Math.min(jogRateX, jogRateY);
          socket.emit('jogXY', {
            x: (xSign * xDist).toFixed(3),
            y: (ySign * yDist).toFixed(3),
            feed: feed
          });
          continuousJogRunning = true;
          waitingForStatus = true;
          $(selector).click();
        }
      } else {
        toastJogNotIdle();
      }
    } else {
      jogXY(xSign * jogdistXYZ, ySign * jogdistXYZ, Math.min(jogRateX, jogRateY));
    }
    $('#runNewProbeBtn').addClass("disabled")
    $('#confirmNewProbeBtn').removeClass("disabled")
  });
  $(selector).on('touchend mouseup', function(ev) {
    ev.preventDefault();
    if (allowContinuousJog) {
      cancelJog()
    }
  });
}

function home() {
  if (laststatus != undefined && laststatus.machine.firmware.type == 'grbl') {
    sendGcode('$H')
  } else if (laststatus != undefined && laststatus.machine.firmware.type == 'smoothie') {
    sendGcode('G28')
  }
}

function toastJogWillHit(axis) {
  printLog("<span class='fg-red'>[ jog ] </span><span class='fg-red'>Unable to jog toward " + axis + ", will hit soft-limit</span>")
  var toast = Metro.toast.create;
  toast("Unable to jog toward " + axis + ", will hit soft-limit", null, 1000, "bg-darkRed fg-white")
}

function toastJogNotIdle(axis) {
  printLog("<span class='fg-red'>[ jog ] </span><span class='fg-red'>Please wait for machine to be Idle, before jogging</span>")
  var toast = Metro.toast.create;
  toast("Please wait for machine to be Idle, before jogging. Try again once it is Idle", null, 1000, "bg-darkRed fg-white")
}