var lastSelectedMachine = '';
var allowGrblSettingsViewScroll = true;

function fixGrblHALSettings(j, type) {
  if (laststatus.machine.firmware.platform == "grblHAL") { //  Workaround for HAL profiles required changes, without creating entirely new profiles for GrblHAL
    if (j == "10") {
      // Status Report Format
      $("#val-" + j + "-input").val(511)
    }
    if (j == "5") {
      // Fix NC vs NO switches
      $("#val-" + j + "-input").val(7)
    }
    if (j == "6") {
      // Fix Probe Inversion
      $("#val-" + j + "-input").val(1)
      if (type == "leadmachine1010plasma") {
        $("#val-" + j + "-input").val(0)
      }
    }

    if (j == "4") {
      // Fix Enable Invert
      $("#val-" + j + "-input").val(0)
    }

    if (j == "40") {
      // Fix Soft Limits for grblHAL https://openbuilds.com/threads/openbuilds-control-software.13121/page-81#post-137277
      $("#val-" + j + "-input").val(1)
    }

    if (j == "376") {
      // Set $376=1: in Grbl Settings as per grblHAL/ESP32#76 (comment)
      // $376 - Settings_Axis_Rotational
      // Designate ABC axes as rotational by \ref axismask. This will disable scaling (to mm) in inches mode.
      // Set steps/mm for the axes to the value that represent the desired movement per unit.
      // For the controller the distance is unitless and and can be in degrees, radians, rotations, ...
      $("#val-" + j + "-input").val(1)
    }

  }
}

function selectMachine(type) {
  // P6: replaced the entire OpenBuilds machine-preset system (Sphinx, Workbee,
  // Acro, C-Beam, LEAD, MiniMill - each silently writing ~30 settings such as
  // steps/mm, max rate, acceleration and travel limits) with exactly two
  // profiles, Router and Laser. Deliberately minimal and auditable: only
  // $32 and $44 are ever touched. No other setting is ever written here -
  // hard limits ($21) and homing ($22) are independent toggles handled by
  // toggleHardLimits()/toggleHoming() in grbl-settings.js, not by this
  // function.
  //
  // P8 bug fix: Router used to be a no-op, on the assumption that $32/$44
  // were already at their firmware defaults. That assumption breaks the
  // moment a user selects Laser first - Router's no-op then can't undo
  // Laser's $32=1/$44=0, so the firmware stays stuck in Laser mode even
  // though the UI shows Router selected. Router now explicitly writes back
  // to the confirmed real GRBL Mythos UC-100 defaults ($32=0, $44=4, from
  // $I query) instead of assuming nothing needs to change.
  if (type == "laser") {
    $("#val-32-input").val(1); // Laser mode ON ($32)
    $("#val-44-input").val(0); // Disable homing cycle 1 - see P6 notes: this
    // assumes the connected firmware's own default already has X+Y (mask 3)
    // in $45. Verify $45 on your actual UC-100/UC-200 board before relying
    // on this to keep Z out of the homing cycle.
  } else {
    $("#val-32-input").val(0); // Laser mode OFF ($32) - confirmed UC-100 default
    $("#val-44-input").val(4); // Homing cycle 1 = Z only - confirmed UC-100 default
  }

  checkifchanged();
  setMachineButton(type);
  lastSelectedMachine = type;
  sendGcode('$I=' + lastSelectedMachine);
}

function setMachineButton(type) {
  var isLaser = (type == "laser");
  $('#simpleprofile_laser').prop('checked', isLaser);
  $('#simpleprofile_router').prop('checked', !isLaser);
  // Keep the "jump to Grbl Settings" shortcut on the 3D view overlay; the
  // old per-machine-brand image it used to show no longer applies.
  $('#overlayimg').html(`<span onclick="$('#grblTab').click()" style="position: absolute; top: 3px; right:3px; z-index: 1;" class="fas fa-cogs machineicon" style="text-shadow: 2px 2px 4px #cccccc;"></span>`)
};

