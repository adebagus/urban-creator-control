// Toolbar with USB port/connect/disconnect
// Is the CONTROLLER itself still moving a program, whatever the server thinks? The server's
// connectionStatus is an assumption (it becomes 2 "Connected" the moment its own queue is
// dumped), runStatus is what the controller reports in its status reports: "Run", "Hold:0" /
// "Hold:1". While that is so the jog buttons stay disabled and Stop stays enabled; they
// follow the controller's own "Idle", not the server's guess.
//
// "Jog" is deliberately NOT in this list: a continuous jog is ended by the mouse-up
// on the very button that is held. Disabling that button while the controller reports
// "Jog" would swallow the mouse-up (Chromium delivers no mouse events to a disabled
// button), and the jog would run on instead of stopping.
var CONTROLLER_BUSY_RE = /^(Run|Hold)(:|$)/;

function controllerIsBusy(status) {
  return !!(status && status.comms && typeof status.comms.runStatus === 'string' && CONTROLLER_BUSY_RE.test(status.comms.runStatus));
}

function setConnectBar(val, status) {
  if (val == 0) { // Not Connected Yet
    // Status Badge
    $('#connectStatus').html("Port: Not Connected");
    // Connect/Disconnect Button
    $("#disconnectBtn").hide();
    $("#flashBtn").hide();
    $('#portUSB').parent().show();
    $("#connectBtn").show();
    $("#scanBtn").show();
    $("#driverBtn").show();
    if ($('#portUSB').val() != "") {
      $("#connectBtn").attr('disabled', false);
    } else {
      $("#connectBtn").attr('disabled', true);
    }
    $('#portUSB').parent(".select").addClass('success')
    $('#portUSB').parent(".select").removeClass('alert')
    $('.macrobtn').removeClass('disabled')
    $('.grblCalibrationMenu').addClass("disabled")
    // Set Port Dropdown to Current Value
    // Not applicable to Status 0 as its set by populatePortsMenu();

  } else if (val == 1 || val == 2) { // Connected, but not Playing yet
    // Status Badge
    $('#connectStatus').html("Port: Connected");
    // Connect/Disconnect Button
    $("#connectBtn").hide();
    $("#scanBtn").hide();
    $("#driverBtn").hide();
    $('#portUSB').parent().hide();
    $("#connectBtn").attr('disabled', false);
    $("#disconnectBtn").show();
    $("#flashBtn").hide();

    // Port Dropdown
    //$('#portUSB').parent(".select").addClass('disabled')
    $('#portUSB').parent(".select").removeClass('success')
    $('#portUSB').parent(".select").addClass('alert')
    // Set Port Dropdown to Current Value
    $("#portUSB").val(status.comms.interfaces.activePort);
    $('.macrobtn').removeClass('disabled')
    $('.grblCalibrationMenu').removeClass("disabled")

  } else if (val == 3) { // Busy Streaming GCODE
    // Status Badge
    $('#connectStatus').html("Port: Connected");
    // Connect/Disconnect Button
    $("#connectBtn").hide();
    $("#scanBtn").hide();
    $("#driverBtn").hide();
    $('#portUSB').parent().hide();
    $("#connectBtn").attr('disabled', false);
    $("#disconnectBtn").show();
    $("#flashBtn").hide();
    // Port Dropdown
    //$('#portUSB').parent(".select").addClass('disabled')
    $('#portUSB').parent(".select").removeClass('success')
    $('#portUSB').parent(".select").addClass('alert')
    // Set Port Dropdown to Current Value
    $("#portUSB").val(status.comms.interfaces.activePort);
    $('.macrobtn').addClass('disabled')
    $('.grblCalibrationMenu').addClass("disabled")

  } else if (val == 4) { // Paused
    // Status Badge
    $('#connectStatus').html("Port: Connected");
    // Connect/Disconnect Button
    $("#connectBtn").hide();
    $("#scanBtn").hide();
    $("#driverBtn").hide();
    $('#portUSB').parent().hide();
    $("#connectBtn").attr('disabled', false);
    $("#disconnectBtn").show();
    $("#flashBtn").hide();
    // Port Dropdown
    //$('#portUSB').parent(".select").addClass('disabled')
    $('#portUSB').parent(".select").removeClass('success')
    $('#portUSB').parent(".select").addClass('alert')
    // Set Port Dropdown to Current Value
    $("#portUSB").val(status.comms.interfaces.activePort);
    $('.macrobtn').removeClass('disabled')
    $('.grblCalibrationMenu').addClass("disabled")

  } else if (val == 5) { // Alarm State
    // Status Badge
    $('#connectStatus').html("Port: Connected");
    // Connect/Disconnect Button
    $("#connectBtn").hide();
    $("#scanBtn").hide();
    $("#driverBtn").hide();
    $('#portUSB').parent().hide();
    $("#connectBtn").attr('disabled', false);
    $("#disconnectBtn").show();
    $("#flashBtn").hide();
    // Port Dropdown
    //$('#portUSB').parent(".select").addClass('disabled')
    $('#portUSB').parent(".select").removeClass('success')
    $('#portUSB').parent(".select").addClass('alert')
    // Set Port Dropdown to Current Value
    $("#portUSB").val(status.comms.interfaces.activePort);
    $('.macrobtn').removeClass('disabled')
    $('.grblCalibrationMenu').addClass("disabled")
  } else if (val == 6) { // Firmware Upgrade State
    // Status Badge
    $('#connectStatus').html("Port: Flashing");
    // Connect/Disconnect Button
    $("#connectBtn").hide();
    $("#scanBtn").hide();
    $("#driverBtn").hide();
    $('#portUSB').parent().hide();
    $("#connectBtn").attr('disabled', false);
    $("#disconnectBtn").hide();
    $("#flashBtn").show();
    // Port Dropdown
    //$('#portUSB').parent(".select").addClass('disabled')
    $('#portUSB').parent(".select").removeClass('success')
    $('#portUSB').parent(".select").addClass('alert')
    // Set Port Dropdown to Current Value
    $("#portUSB").val(status.comms.interfaces.activePort);
    $('.macrobtn').removeClass('disabled')
    $('.grblCalibrationMenu').addClass("disabled")
  }
}

// Toolbar with play/pause/stop
function setControlBar(val, status) {
  if (val == 0) { // Not Connected Yet
    if (toolchanges && toolchanges.length) {
      $('#runToolsBtn').hide().attr('disabled', true);
      $('#runBtn').hide().attr('disabled', true);
    } else {
      $('#runToolsBtn').hide().attr('disabled', true);
      $('#runBtn').hide().attr('disabled', true);
    }
    $('#grblProbeMenu').hide().attr('disabled', true);
    $('#chkSize').hide().attr('disabled', true);
    $('#resumeBtn').hide().attr('disabled', true);
    $('#pauseBtn').hide().attr('disabled', true);
    $('#stopBtn').hide().attr('disabled', true);
    $('#toolBtn').hide().attr('disabled', true);
    $('#toolBtn2').hide().attr('disabled', true);

    if (grblParams['$22'] == 1) {
      $('#homeBtn').hide().attr('disabled', true);
    } else {
      $('#homeBtn').hide().attr('disabled', true);
    }

    $('.estop').hide()
    $('#controlBtnGrp').hide();
    $("#grblSettings").hide(); // Hide Grbl Settings if it was Open
    $('#grblconfig').empty();
  } else if (val == 1 || val == 2) { // Connected, but not Playing yet
    $('#grblProbeMenu').show().attr('disabled', false);
    if (typeof ace !== 'undefined') {
      if (toolchanges.length) {
        if (status.machine.inputs.includes('D')) {
          $('#runToolsBtn').show().attr('disabled', true);
          $('#runBtn').hide().attr('disabled', true);
        } else {
          $('#runToolsBtn').show().attr('disabled', editor.session.getLength() < 2);
          $('#runBtn').hide().attr('disabled', editor.session.getLength() < 2);
        }
        if (webgl) {
          $('#chkSize').show().attr('disabled', editor.session.getLength() < 2);
        } else {
          $('#chkSize').show().attr('disabled', true);
        }

      } else {
        $('#runToolsBtn').hide().attr('disabled', editor.session.getLength() < 2);
        if (status.machine.inputs.includes('D')) {
          $('#runBtn').show().attr('disabled', true);
        } else {
          $('#runBtn').show().attr('disabled', editor.session.getLength() < 2);
        }

        if (webgl) {
          $('#chkSize').show().attr('disabled', editor.session.getLength() < 2);
        } else {
          $('#chkSize').show().attr('disabled', true);
        }
      }
    } else {
      if (status.machine.inputs.includes('D')) {
        $('#runBtn').show().attr('disabled', true);
      } else {
        $('#runBtn').show().attr('disabled', false);
      }
      $('#runToolsBtn').hide().attr('disabled', false);
    }
    $('#resumeBtn').hide().attr('disabled', true);
    $('#pauseBtn').hide().attr('disabled', true);
    // Stop stays usable while the controller still reports Run/Hold, even though the server
    // already says "Connected" (e.g. its queue was dumped but the machine is still moving)
    $('#stopBtn').show().attr('disabled', !controllerIsBusy(status));
    $('#toolBtn').show().attr('disabled', false);
    $('#toolBtn2').show().attr('disabled', false);
    if (grblParams['$22'] == 1) {
      $('#homeBtn').show().attr('disabled', false);
    } else {
      $('#homeBtn').show().attr('disabled', true);
    }
    $('.estop').show()
    $('#controlBtnGrp').show();
  } else if (val == 3) { // Busy Streaming GCODE
    $('#grblProbeMenu').show().attr('disabled', true);

    if (toolchanges.length) {
      $('#runToolsBtn').hide().attr('disabled', true);
      $('#runBtn').hide().attr('disabled', true);
    } else {
      $('#runToolsBtn').hide().attr('disabled', true);
      $('#runBtn').hide().attr('disabled', true);
    }
    $('#chkSize').show().attr('disabled', true);
    $('#resumeBtn').hide().attr('disabled', true);
    // P10: while the tool-change wizard is waiting, the controller is already
    // confirmed idle (nothing is moving) and pause() itself refuses to act -
    // disable the button so it does not look like it should do something.
    $('#pauseBtn').show().attr('disabled', !!(status.comms && status.comms.awaitingToolChange));
    $('#stopBtn').show().attr('disabled', false);
    $('#toolBtn').show().attr('disabled', false);
    $('#toolBtn2').show().attr('disabled', false);
    if (grblParams['$22'] == 1) {
      $('#homeBtn').show().attr('disabled', true);
    } else {
      $('#homeBtn').show().attr('disabled', true);
    }
    $('.estop').show()
    $('#controlBtnGrp').show();
  } else if (val == 4) { // Paused
    $('#grblProbeMenu').show().attr('disabled', true);

    if (toolchanges.length) {
      $('#runToolsBtn').hide().attr('disabled', true);
      $('#runBtn').hide().attr('disabled', true);
    } else {
      $('#runToolsBtn').hide().attr('disabled', true);
      $('#runBtn').hide().attr('disabled', true);
    }
    $('#chkSize').show().attr('disabled', true);
    if (status.machine.inputs.includes('D')) {
      $('#resumeBtn').hide().attr('disabled', true);
      $('#pauseBtn').show().attr('disabled', true);
    } else {
      $('#resumeBtn').show().attr('disabled', false);
      $('#pauseBtn').hide().attr('disabled', true);
    }

    $('#stopBtn').show().attr('disabled', false);
    $('#toolBtn').show().attr('disabled', false);
    $('#toolBtn2').show().attr('disabled', false);
    if (grblParams['$22'] == 1) {
      $('#homeBtn').show().attr('disabled', true);
    } else {
      $('#homeBtn').show().attr('disabled', true);
    }
    $('.estop').show()
    $('#controlBtnGrp').show();
  } else if (val == 5) { // Alarm State
    $('#grblProbeMenu').show().attr('disabled', true);

    if (toolchanges.length) {
      $('#runToolsBtn').show().attr('disabled', true);
      $('#runBtn').hide().attr('disabled', true);
    } else {
      $('#runToolsBtn').hide().attr('disabled', true);
      $('#runBtn').show().attr('disabled', true);
    }
    // $('#runBtn').show().attr('disabled', true);
    $('#chkSize').show().attr('disabled', true);
    $('#resumeBtn').hide().attr('disabled', true);
    $('#pauseBtn').hide().attr('disabled', true);
    $('#stopBtn').show().attr('disabled', true);
    $('#toolBtn').show().attr('disabled', true);
    $('#toolBtn2').show().attr('disabled', true);
    if (grblParams['$22'] == 1) {
      $('#homeBtn').show().attr('disabled', false);
    } else {
      $('#homeBtn').show().attr('disabled', true);
    }
    $('.estop').show()
    $('#controlBtnGrp').show();
  } else if (val == 6) { // Firmware Upgrade State
    $('#grblProbeMenu').show().attr('disabled', true);

    if (toolchanges.length) {
      $('#runToolsBtn').hide().attr('disabled', true);
      $('#runBtn').hide().attr('disabled', true);
    } else {
      $('#runToolsBtn').hide().attr('disabled', true);
      $('#runBtn').hide().attr('disabled', true);
    }
    $('#chkSize').show().attr('disabled', true);
    $('#resumeBtn').hide().attr('disabled', true);
    $('#pauseBtn').hide().attr('disabled', true);
    $('#stopBtn').hide().attr('disabled', true);
    $('#toolBtn').hide().attr('disabled', true);
    $('#toolBtn2').hide().attr('disabled', true);
    if (grblParams['$22'] == 1) {
      $('#homeBtn').hide().attr('disabled', true);
    } else {
      $('#homeBtn').show().attr('disabled', true);
    }
    $('.estop').hide()
    $('#controlBtnGrp').hide();
  }
}

function setJogPanel(val, status) {
  if (val == 0) { // Not Connected Yet
    // Show panel and resize editor
    // $("#jogcontrols").slideUp(20);
    // $('#console').scrollTop($("#console")[0].scrollHeight - $("#console").height());
    if (editor) {
      editor.resize()
    }
    $('.jogbtn').attr('disabled', true);
    $('#xPos').html('0.00');
    $('#yPos').html('0.00');
    $('#zPos').html('0.00');

  } else if (val == 1 || val == 2) { // Connected, but not Playing yet
    // Show panel and resize editor
    // $('#console').scrollTop($("#console")[0].scrollHeight - $("#console").height());
    if (editor) {
      editor.resize()
    }
    // active only once the controller itself reports it is not running/holding a program
    $('.jogbtn').attr('disabled', controllerIsBusy(status));

  } else if (val == 3) { // Busy Streaming GCODE
    // Show panel and resize editor
    if (editor) {
      editor.resize()
    }
    // $("#jogcontrols").slideDown(20);
    $('.jogbtn').attr('disabled', true);

  } else if (val == 4) { // Paused
    // Show panel and resize editor
    if (editor) {
      editor.resize()
    }
    $('.jogbtn').attr('disabled', true);

  } else if (val == 5) { // Alarm State
    // Show panel and resize editor
    // $('#console').scrollTop($("#console")[0].scrollHeight - $("#console").height());
    if (editor) {
      editor.resize()
    }
    $('.jogbtn').attr('disabled', true);

  } else if (val == 6) { // Firmware Upgrade State
    // Show panel and resize editor
    // $("#jogcontrols").slideUp(20);
    // $('#console').scrollTop($("#console")[0].scrollHeight - $("#console").height());
    if (editor) {
      editor.resize()
    }
    $('.jogbtn').attr('disabled', true);
    $('#xPos').html('0.00');
    $('#yPos').html('0.00');
    $('#zPos').html('0.00');

  }
}

function setConsole(val, status) {
  if (val == 0) { // Not Connected Yet
    if (!$('#command').attr('disabled')) {
      $('#command').attr('disabled', true);
    }
    $("#sendCommand").prop('disabled', true);
  } else if (val == 0 || val == 2) { // Connected, but not Playing yet
    $("#command").attr('disabled', false);
    $("#sendCommand").prop('disabled', false);
  } else if (val == 3) { // Busy Streaming GCODE
    if (!$('#command').attr('disabled')) {
      $('#command').attr('disabled', true);
    }
    $("#sendCommand").prop('disabled', true);
  } else if (val == 4) { // Paused
    if (!$('#command').attr('disabled')) {
      $('#command').attr('disabled', true);
    }
    $("#sendCommand").prop('disabled', false);
  } else if (val == 5) { // Alarm State
    $("#command").attr('disabled', false);
    $("#sendCommand").prop('disabled', false);
  } else if (val == 6) { // Firmware Upgrade State
    if (!$('#command').attr('disabled')) {
      $('#command').attr('disabled', true);
    }
    $("#sendCommand").prop('disabled', true);
  }
}