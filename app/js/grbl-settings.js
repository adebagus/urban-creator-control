$(document).ready(function() {
  var backupFileOpen = document.getElementById('grblBackupFile');
  if (backupFileOpen) {
    backupFileOpen.addEventListener('change', readGrblBackupFile, false);
  }
});

function readGrblBackupFile(evt) {
  var files = evt.target.files || evt.dataTransfer.files;
  loadGrblBackupFile(files[0]);
  document.getElementById('grblBackupFile').value = '';

}

function loadGrblBackupFile(f) {
  if (f) {
    // Filereader
    var r = new FileReader();
    // if (f.name.match(/.gcode$/i)) {
    r.readAsText(f);
    r.onload = function(event) {
      //var grblsettingsfile = this.result
      //console.log(this.result)
      var data = this.result.split("\n");
      for (i = 0; i < data.length; i++) {
        if (data[i].indexOf("$I=") == 0) {
          setMachineButton(data[i].split('=')[1])
        } else {
          var key = data[i].split('=')[0];
          var param = data[i].split('=')[1]
          $("#val-" + key.substring(1) + "-input").val(parseFloat(param))
          fixGrblHALSettings(key.substring(1)); // Fix GrblHAL Defaults
        }
      };

      checkifchanged();
      syncHardLimitAndHomingCheckboxes(); // reflect the restored $21/$22, don't overwrite them
      displayDirInvert();
      $("#grblSettingsAdvTab").click();
    }
  }
}

function populateRestoreMenu() {
  // Retrieve backups from localStorage
  const backups = JSON.parse(localStorage.getItem('grblParamsBackups')) || [];

  // Get the dropdown menu element
  const backupMenu = document.getElementById('restoreBackupMenu');

  // Clear existing menu items (in case you're calling this multiple times)
  backupMenu.innerHTML = '';

  // Loop through each backup and create a list item for it
  backups.forEach((backup, index) => {
    const backupItem = document.createElement('li');

    // Format the timestamp (you can format it as needed)
    const formattedTimestamp = new Date(backup.timestamp).toLocaleString(); // Adjust formatting as needed

    // Create the list item HTML content
    backupItem.innerHTML = `
      <a href="#" onclick="restoreAutoBackup(${index})">
        <i class="fas fa-clock fa-fw"></i>
        Restore AutoBackup: ${formattedTimestamp} (${backup.note || 'No note'})
      </a>
    `;

    // Append the list item to the dropdown menu
    backupMenu.appendChild(backupItem);
  });
}

function restoreAutoBackup(index) {
  const backups = JSON.parse(localStorage.getItem('grblParamsBackups')) || [];
  const selectedBackup = backups[index];

  // You can now access selectedBackup.grblParams and apply it as needed
  console.log('Restoring backup:', selectedBackup);
  // Call your function to restore the backup here, e.g., update grblParams
  // Example: grblParams = selectedBackup.grblParams;

  // Retrieve grblParams from the backup
  const grblParamsBackup = selectedBackup.grblParams;

  // Iterate through the keys in the grblParams object and apply them using jQuery
  for (const key in grblParamsBackup) {
    if (grblParamsBackup.hasOwnProperty(key)) {
      const paramValue = grblParamsBackup[key];
      const parsedValue = parseFloat(paramValue);

      // Check if the parsed value is a valid number
      if (!isNaN(parsedValue)) {
        // Update the input field based on the parameter using jQuery
        const inputElement = $("#val-" + key.substring(1) + "-input");

        if (inputElement.length) {
          inputElement.val(parsedValue); // Apply the value to the input field
        }
      } else {
        console.warn(`Invalid value for ${key}: ${paramValue}`);
      }

      // Optionally, fix or apply any GrblHAL-specific settings
      fixGrblHALSettings(key.substring(1)); // Adjust as needed

      // Optionally, other functions you might call for updating the machine state
      // Example: checkifchanged(); enableLimits(); displayDirInvert();
    }
  }
  // Call any post-restoration functions you need (e.g., re-enable limits, etc.)
  checkifchanged();
  syncHardLimitAndHomingCheckboxes(); // reflect the restored $21/$22, don't overwrite them
  displayDirInvert();
  $("#grblSettingsAdvTab").click();
}


function backupGrblSettings() {
  autoBackup("Manual Backup")
  var grblBackup = ""
  for (key in grblParams) {
    var key2 = key.split('=')[0].substr(1);

    if (grblSettingsTemplate2[key2] !== undefined) {
      var descr = grblSettingsTemplate2[key2].title
    } else {
      var descr = "unknown"
    }
    grblBackup += key + "=" + grblParams[key] + "  ;  " + descr + "\n"
  }
  if (laststatus.machine.name.length > 0) {
    grblBackup += "$I=" + laststatus.machine.name
  }
  var blob = new Blob([grblBackup], {
    type: "plain/text"
  });
  var date = new Date();
  if (laststatus.machine.name.length > 0) {
    invokeSaveAsDialog(blob, 'grbl-settings-backup-' + laststatus.machine.name + "-" + date.yyyymmdd() + '.txt');
  } else {
    invokeSaveAsDialog(blob, 'grbl-settings-backup-' + date.yyyymmdd() + '.txt');
  }
}

function grblSettings(data) {
  // console.log(data)
  var template = ``
  grblconfig = data.split('\n')
  for (i = 0; i < grblconfig.length; i++) {
    var key = grblconfig[i].split('=')[0];
    var param = grblconfig[i].split(/[= ;(]/)[1]
    grblParams[key] = param
  }
  // $('#grblconfig').show();
  // grblPopulate();
  // $('#grblSaveBtn').removeAttr('disabled');
  // $('#grblFirmwareBtn').removeAttr('disabled');
  $('#grblSettings').show()

  if (laststatus.machine.firmware.platform == "grblHAL") {
    $("#grbl-settings-tab-title").html('grblHAL');
  } else {
    $("#grbl-settings-tab-title").html('Grbl');
  }



  if (grblParams['$22'] > 0) {
    $('#gotozeroMPos').removeClass('disabled')
    $('#homeBtn').attr('disabled', false)
    $('#gotoXzeroMpos').removeClass('disabled')
    $('#gotoYzeroMpos').removeClass('disabled')
    $('#gotoZzeroMpos').removeClass('disabled')
    $('.PullOffMPos').html("-" + grblParams['$27'])
  } else {
    $('#gotozeroMPos').addClass('disabled')
    $('#homeBtn').attr('disabled', true)
    $('#gotoXzeroMpos').addClass('disabled')
    $('#gotoYzeroMpos').addClass('disabled')
    $('#gotoZzeroMpos').addClass('disabled')
  }

  if (grblParams['$32'] == 1) {
    $('#enLaser').removeClass('alert').addClass('success').html('ON')
  } else {
    $('#enLaser').removeClass('success').addClass('alert').html('OFF')
  }

  // grblHAL - enable Servo Buttons if Spindle PWM == 50hz
  if (grblParams['$33'] == 50) {
    $('#enServo').removeClass('alert').addClass('success').html('ON')
    $(".servo-active").show()
  } else {
    $('#enServo').removeClass('success').addClass('alert').html('OFF')
    $(".servo-active").hide()
  }


  updateToolOnSValues();

  if (localStorage.getItem('jogOverride')) {
    jogOverride(localStorage.getItem('jogOverride'))
  } else {
    jogOverride(100);
  }
}

function showBasicSettings() {
  $("#grbl-settings-basic").show();
  $("#grbl-settings-advanced").hide();
}

function showAdvSettings() {
  $("#grbl-settings-basic").hide();
  $("#grbl-settings-advanced").show();
}

function grblPopulate() {
  if (!isJogWidget) {
    $('#grblconfig').show();
    $('#grblconfig').empty();
    var template = `
    <form id="grblSettingsTable">

    <ul data-role="tabs" data-expand="true" class="mb-2">
      <li id="grblSettingsBasicTab" onclick="showBasicSettings()"><a href="#"><small><i class="fas fa-fw fa-cog mr-1 fg-darkGreen"></i>Basic Settings</a></small></li>
      <li id="grblSettingsAdvTab" onclick="showAdvSettings()"><a href="#"><small><i class="fas fa-fw fa-cogs mr-1 fg-darkRed"></i>Advanced Settings</a></small></li>
    </ul>


    <div id="grbl-settings-basic">
        <ul class="step-list mb-3">
          <li>
            <h6>Select your Profile<br><small>Router leaves everything as-is. Laser turns on Laser mode ($32) and stops the Z axis from homing ($44) - nothing else is touched.</small></h6>
            <ul class="image-checkbox-ul">
              <li>
                <input type="radio" name="simpleprofile" id="simpleprofile_router" value="router" onclick="selectMachine('router');">
                <label for="simpleprofile_router"><img src="./img/toolhead/router11.png" /></label>
                <div class="image-checkbox-text">Router</div>
              </li>
              <li>
                <input type="radio" name="simpleprofile" id="simpleprofile_laser" value="laser" onclick="selectMachine('laser');">
                <label for="simpleprofile_laser"><img src="./img/toolhead/laser.png" /></label>
                <div class="image-checkbox-text">Laser</div>
              </li>
            </ul>
          </li>
          <li>
            <h6>Hard Limits &amp; Homing<br><small>Applies no matter which profile above is selected.</small></h6>
            <ul class="image-checkbox-ul">
              <li>
                <input type="checkbox" name="hardlimits" id="hardlimitsenabled" value="hardlimits">
                <label for="hardlimitsenabled"><i class="fas fa-shield-alt"></i></label>
                <div class="image-checkbox-text">Hard Limits ($21)</div>
              </li>
              <li>
                <input type="checkbox" name="homing" id="homingenabled" value="homing">
                <label for="homingenabled"><i class="fas fa-home"></i></label>
                <div class="image-checkbox-text">Homing ($22)</div>
              </li>
            </ul>
          </li>

          <li>
            <h6>Finished<br><small>Remember to "Save to Firmware" and Reset when Prompted. <br>If you have any custom requirements,
                please customise the settings in the Advanced Settings section above</small></h6>
          </li>


        </ul>
    </div>
    <div id="grbl-settings-advanced" style="display: none; overflow-y: scroll; max-height: calc(100vh - 300px);">
        <div id="grblSettingsTableView">
          <table data-role="table"
            data-table-search-title="Search for Parameters by Name or $-Key"
            data-search-fields="Key, Parameter"
            data-on-draw="setup_settings_table"
            data-on-table-create="setup_settings_table"
            data-cell-wrapper="false"
            class="table compact striped row-hover row-border"
            data-show-rows-steps="false" data-rows="200"
            data-show-pagination="false" data-show-table-info="true"
            data-show-search="true">
            <thead>
              <tr>
                <th style="text-align: left;">Key</th>
                <th style="text-align: left;">Parameter</th>
                <th style="width: 250px; min-width: 240px !important;">Value</th>
                <th style="width: 110px; min-width: 110px !important;">Utility</th>
              </tr>
            </thead>
            <tbody>`

    for (key in grblParams) {
      var key2 = key.split('=')[0].substr(1);
      //console.log(key2)
      if (grblSettingsTemplate2[key2] !== undefined) {
        //template += grblSettingsTemplate2[key2].template;
        template += `<tr id="grblSettingsRow` + key2 + `"
                title="` + grblSettingsTemplate2[key2].description + `">
                <td>` + grblSettingsTemplate2[key2].key + `</td>
                <td>` + grblSettingsTemplate2[key2].title + `</td>
                <td>` + grblSettingsTemplate2[key2].template + `</td>
                <td>` + grblSettingsTemplate2[key2].utils + `</td>
              </tr>`
      } else {
        template += `
              <tr>
                <td>` + key + `</td>
                <td><span class="tally alert">` + key + `</span></td>
                <td><input data-role="input" data-clear-button="false"
                    data-append="?" type="text"
                    value="` + grblParams[key] + `"
                    id="val-` + key2 + `-input"></td>
                <td></td>
              </tr>
              `
      }
    }

    template += `</tbody>
          </table>
        </div> <!-- End of grblSettingsTableView -->
        </div>
      </div>
    </nav>
  </form>
      `
    $('#grblconfig').append(template)

    $('#grblSettingsTable').on('keyup paste click change', 'input, select', function() {
      checkifchanged()
    });

    // Event Handlers for Switch Checkboxes
    setTimeout(function() {
      setup_settings_table();
    }, 100)



    $('#grblSettingsBadge').hide();

    // P6: Hard Limits ($21) and Homing ($22) are independent toggles now,
    // no longer coupled together under one "limits installed" checkbox.
    syncHardLimitAndHomingCheckboxes();
    if (grblParams['$22'] > 0) {
      $('#gotozeroMPos').removeClass('disabled')
      $('#homeBtn').attr('disabled', false)
    } else {
      $('#gotozeroMPos').addClass('disabled')
      $('#homeBtn').attr('disabled', true)
    }

    // P6: best-effort sync of the Router/Laser radio from the firmware's
    // current $32 - this is a display-only guess (laser mode ON implies the
    // Laser profile), it never writes anything back to the firmware itself.
    $('#simpleprofile_laser').prop('checked', parseFloat(grblParams['$32']) == 1);
    $('#simpleprofile_router').prop('checked', parseFloat(grblParams['$32']) != 1);

    setTimeout(function() {
      setMachineButton(laststatus.machine.name)
    }, 500)

    populateRestoreMenu();
  }

}

// function checkifchanged() {
//   var hasChanged = false;
//   for (var key in grblParams) {
//     if (grblParams.hasOwnProperty(key)) {
//       var j = key.substring(1)
//       var newVal = $("#val-" + j + "-input").val();
//
//       if (newVal !== undefined) {
//         // Only send values that changed
//         if (newVal != grblParams[key]) {
//           hasChanged = true;
//           console.log("changed: " + key)
//           console.log("old: " + grblParams[key])
//           console.log("new: " + newVal)
//           if (!$("#val-" + j + "-input").parent().is('td')) {
//             $("#val-" + j + "-input").parent().addClass('alert')
//           } else if ($("#val-" + j + "-input").is('select')) {
//             $("#val-" + j + "-input").addClass('alert')
//           } else if (j == 3) { // axes
//             $('#xdirinvert').parent().children('.check').addClass('bd-red')
//             $('#ydirinvert').parent().children('.check').addClass('bd-red')
//             $('#zdirinvert').parent().children('.check').addClass('bd-red')
//           }
//         } else {
//           if (!$("#val-" + j + "-input").parent().is('td')) {
//             $("#val-" + j + "-input").parent().removeClass('alert')
//           } else if ($("#val-" + j + "-input").is('select')) {
//             $("#val-" + j + "-input").removeClass('alert')
//           } else if (j == 3) {
//             $('#xdirinvert').parent().children('.check').removeClass('bd-red')
//             $('#ydirinvert').parent().children('.check').removeClass('bd-red')
//             $('#zdirinvert').parent().children('.check').removeClass('bd-red')
//           }
//         }
//       }
//     }
//   }
//   if (hasChanged) {
//     $('#grblSettingsBadge').fadeIn('slow');
//     $('#saveBtn').attr('disabled', false).removeClass('disabled');
//     $('#saveBtnIcon').removeClass('fg-gray').addClass('fg-grayBlue');
//   } else {
//     $('#grblSettingsBadge').fadeOut('slow');
//     $('#saveBtn').attr('disabled', true).addClass('disabled');
//     $('#saveBtnIcon').removeClass('fg-grayBlue').addClass('fg-gray');
//   }
// }

function checkifchanged() {
  var hasChanged = false;

  for (var key in grblParams) {
    if (grblParams.hasOwnProperty(key)) {
      var j = key.substring(1);
      var newVal = $("#val-" + j + "-input").val();

      if (newVal !== undefined) {
        // Determine if the value should be compared as text or number
        var oldVal = grblParams[key];
        var compareAsNumber = !isNaN(parseFloat(oldVal)) && !isNaN(parseFloat(newVal));

        // Perform appropriate comparison
        if ((compareAsNumber && parseFloat(newVal) !== parseFloat(oldVal)) ||
          (!compareAsNumber && newVal !== oldVal)) {
          hasChanged = true;

          // console.log("changed: " + key);
          // console.log("old: " + oldVal);
          // console.log("new: " + newVal);

          if (!$("#val-" + j + "-input").parent().is('td')) {
            $("#val-" + j + "-input").parent().addClass('alert');
          } else if ($("#val-" + j + "-input").is('select')) {
            $("#val-" + j + "-input").addClass('alert');
          } else if (j == 3) { // axes
            $('#xdirinvert').parent().children('.check').addClass('bd-red');
            $('#ydirinvert').parent().children('.check').addClass('bd-red');
            $('#zdirinvert').parent().children('.check').addClass('bd-red');
          }
        } else {
          if (!$("#val-" + j + "-input").parent().is('td')) {
            $("#val-" + j + "-input").parent().removeClass('alert');
          } else if ($("#val-" + j + "-input").is('select')) {
            $("#val-" + j + "-input").removeClass('alert');
          } else if (j == 3) {
            $('#xdirinvert').parent().children('.check').removeClass('bd-red');
            $('#ydirinvert').parent().children('.check').removeClass('bd-red');
            $('#zdirinvert').parent().children('.check').removeClass('bd-red');
          }
        }
      }
    }
  }

  if (hasChanged) {
    $('#grblSettingsBadge').fadeIn('slow');
    $('#saveBtn').attr('disabled', false).removeClass('disabled');
    $('#saveBtnIcon').removeClass('fg-gray').addClass('fg-grayBlue');
  } else {
    $('#grblSettingsBadge').fadeOut('slow');
    $('#saveBtn').attr('disabled', true).addClass('disabled');
    $('#saveBtnIcon').removeClass('fg-grayBlue').addClass('fg-gray');
  }
}


function autoBackup(note) {

  const timestamp = new Date().toISOString(); // Generate current timestamp
  const currentParams = {
    machinetype: laststatus.machine.name,
    note: note,
    timestamp: timestamp,
    grblParams: {
      ...grblParams // Spread Operator copy
    }
  }; // Add timestamp to the current parameters

  // Retrieve existing backups from localStorage or initialize an empty array
  let backups = JSON.parse(localStorage.getItem('grblParamsBackups')) || [];

  // Add the current backup to the beginning of the array
  backups.unshift(currentParams);

  // Trim backups to keep only the last 20
  if (backups.length > 20) {
    backups = backups.slice(0, 20);
  }

  // Save the updated backups array back to localStorage
  localStorage.setItem('grblParamsBackups', JSON.stringify(backups));

  // Optionally, add your existing save functionality here
  console.log('Settings saved and backup created.');
}

function grblSaveSettings() {
  autoBackup("Updated Grbl Settings")
  var toSaveCommands = [];
  var saveProgressBar = $("#grblSaveProgress").data("progress");
  for (var key in grblParams) {
    if (grblParams.hasOwnProperty(key)) {
      var j = key.substring(1)
      var newVal = $("#val-" + j + "-input").val();
      // Only send values that changed
      if (newVal !== undefined) {
        if (parseFloat(newVal) != parseFloat(grblParams[key]) && newVal != grblParams[key]) {
          // console.log(key + ' was ' + grblParams[key] + ' but now, its ' + newVal);
          toSaveCommands.push(key + '=' + newVal);
        }
      }
    }
  }
  if (toSaveCommands.length > 0) {
    //console.log("commands", toSaveCommands)
    let counter = 0;
    // Blank the dialog
    if (saveProgressBar) {
      saveProgressBar.val(0);
    }
    $("#grblNewParam").html("")
    $("#grblNewParamVal").html("")
    // Open Dialog savingGrblSettingsProgress
    Metro.dialog.open('#savingGrblSettingsProgress')
    const i = setInterval(function() {
      //console.log(counter, toSaveCommands[counter]);
      var newParam = toSaveCommands[counter].split("=")[0];
      var newParamKey = newParam.substr(1);
      if (grblSettingsTemplate2[newParamKey] !== undefined) {
        var newParamName = grblSettingsTemplate2[newParamKey].title
      } else {
        var newParamName = "unknown"
      }
      var newParamVal = toSaveCommands[counter].split("=")[1];
      $("#grblNewParam").html("<code>" + newParam + " : " + newParamName + "</code>")
      $("#grblNewParamVal").html("<code>" + newParamVal + "</code>")

      if (saveProgressBar) {
        saveProgressBar.val(counter / toSaveCommands.length * 100);
      }
      //
      sendGcode(toSaveCommands[counter] + "\n");;
      counter++;
      if (counter === toSaveCommands.length) {
        // Finished running
        clearInterval(i);
        grblParams = {};
        toSaveCommands = [];
        askToResetOnGrblSettingsChange();
      }
    }, 400); // send another command every 400ms
  }

}

function askToResetOnGrblSettingsChange() {
  setTimeout(function() {
    Metro.dialog.close('#savingGrblSettingsProgress')
    Metro.dialog.create({
      title: "Configuration Updated. Reset Grbl?",
      content: "<div>Some changes in the Grbl Configuration only take effect after a restart/reset of the controller. Would you like to Reset the controller now?</div>",
      clsDialog: 'dark',
      actions: [{
          caption: "Yes",
          cls: "js-dialog-close success",
          onclick: function() {
            setTimeout(function() {
              sendGcode(String.fromCharCode(0x18));
              setTimeout(function() {
                refreshGrblSettings()
              }, 1000); // refresh grbl settings
            }, 800); // reset
          }
        },
        {
          caption: "Later",
          cls: "js-dialog-close",
          onclick: function() {
            console.log("Do nothing")
            refreshGrblSettings();
          }
        }
      ]
    });
    $('#grblSettingsBadge').hide();
  }, 1000); // Just to show settings was written
}

function refreshGrblSettings() {
  $('#saveBtn').attr('disabled', true).addClass('disabled');
  $('#saveBtnIcon').removeClass('fg-grayBlue').addClass('fg-gray');
  grblParams = {};
  $('#grblconfig').empty();
  $('#grblconfig').append("<center>Please Wait... </center><br><center>Requesting updated parameters from the controller firmware...</center>");
  setTimeout(function() {
    sendGcode('$$');
    sendGcode('$I');
    setTimeout(function() {
      grblPopulate();
    }, 500);
  }, 200);

}

// Calc Grbl 1.1 Invert Masks
// Call: calcDecFromMask(true, false, false)
// Return: 1
function calcDecFromMask(x, y, z) {
  var string = "0000000" + (z ? "1" : "0") + (y ? "1" : "0") + (x ? "1" : "0");
  // console.log(string)
  return parseInt(string, 2);
}

// Calc Grbl 1.1 Invert Masks
// Call: calcMaskFromDec("4")
// Returns: {x: false, y: false, z: true}
function calcMaskFromDec(dec) {
  var num = parseInt(dec)
  num = num.toString(2)
  num = ("000" + num).substr(-3, 3)
  // console.log(num)
  var invertmask = {
    x: (num.charAt(2) == 0 ? false : true),
    y: (num.charAt(1) == 0 ? false : true),
    z: (num.charAt(0) == 0 ? false : true)
  }
  return invertmask
}

function changeProbeDirInvert() {
  var xticked = $('#xHomeDir').is(':checked');
  var yticked = $('#yHomeDir').is(':checked');
  var zticked = $('#zHomeDir').is(':checked');
  var value = calcDecFromMask(!xticked, !yticked, !zticked)
  console.log("Homing Dir $23=" + value)
  $("#val-23-input").val(value).trigger("change");
  checkifchanged();
}

function displayProbeDirInvert() {
  var dir = calcMaskFromDec($("#val-23-input").val())
  $('#xHomeDir:checkbox').prop('checked', !dir.x);
  $('#yHomeDir:checkbox').prop('checked', !dir.y);
  $('#zHomeDir:checkbox').prop('checked', !dir.z);
  checkifchanged();
}

function changeDirInvert() {
  var xticked = $('#xdirinvert').is(':checked');
  var yticked = $('#ydirinvert').is(':checked');
  var zticked = $('#zdirinvert').is(':checked');
  var value = calcDecFromMask(xticked, yticked, zticked)
  $("#val-3-input").val(value).trigger("change");
  checkifchanged();
}

function displayDirInvert() {
  var dir = calcMaskFromDec($("#val-3-input").val())
  $('#xdirinvert:checkbox').prop('checked', dir.x);
  $('#ydirinvert:checkbox').prop('checked', dir.y);
  $('#zdirinvert:checkbox').prop('checked', dir.z);
  checkifchanged();
}

function clearSettings() {
  Metro.dialog.create({
    title: "Are you sure?",
    content: "<div>Resetting the Grbl Settings will restore all the settings to factory defaults, but will keep other EEPROM settings intact. Would you like to continue?</div>",
    clsDialog: 'dark',
    actions: [{
        caption: "Yes",
        cls: "js-dialog-close success",
        onclick: function() {
          sendGcode('$RST=$');
          refreshGrblSettings()
        }
      },
      {
        caption: "Cancel",
        cls: "js-dialog-close",
        onclick: function() {
          refreshGrblSettings();
        }
      }
    ]
  });
}

function clearWCO() {
  Metro.dialog.create({
    title: "Are you sure?",
    content: "<div>Resetting the Work Coordinate Systems will erase all the coordinate system offsets currently stored in the EEPROM on the controller. Would you like to continue?</div>",
    clsDialog: 'dark',
    actions: [{
        caption: "Yes",
        cls: "js-dialog-close success",
        onclick: function() {
          sendGcode('$RST=#');
          refreshGrblSettings()
        }
      },
      {
        caption: "Cancel",
        cls: "js-dialog-close",
        onclick: function() {
          refreshGrblSettings();
        }
      }
    ]
  });
}

function clearEEPROM() {
  Metro.dialog.create({
    title: "Are you sure?",
    content: "<div>Resetting the EEPROM will erase all the Grbl Firmware settings from your controller, effectively resetting it back to factory defaults. Would you like to continue?</div>",
    clsDialog: 'dark',
    actions: [{
        caption: "Yes",
        cls: "js-dialog-close success",
        onclick: function() {
          sendGcode('$RST=*');
          refreshGrblSettings()
        }
      },
      {
        caption: "Cancel",
        cls: "js-dialog-close",
        onclick: function() {
          refreshGrblSettings();
        }
      }
    ]
  });
}

function updateToolOnSValues() {
  $(".ToolOnS1").html((parseInt(grblParams.$30) * 0.01).toFixed(0))
  $(".ToolOnS5").html((parseInt(grblParams.$30) * 0.05).toFixed(0))
  $(".ToolOnS10").html((parseInt(grblParams.$30) * 0.1).toFixed(0))
  $(".ToolOnS25").html((parseInt(grblParams.$30) * 0.25).toFixed(0))
  $(".ToolOnS50").html((parseInt(grblParams.$30) * 0.5).toFixed(0))
  $(".ToolOnS75").html((parseInt(grblParams.$30) * 0.75).toFixed(0))
  $(".ToolOnS100").html(parseInt(grblParams.$30).toFixed(0))
}

function setup_settings_table() {

  for (key in grblParams) {
    var key2 = key.split('=')[0].substr(1);
    $("#val-" + key2 + "-input").val(grblParams[key])
  }

  setTimeout(function() {
    $("#val-32-input").val(parseInt(grblParams['$32'])).trigger("change");
    $("#val-20-input").val(parseInt(grblParams['$20'])).trigger("change");
    $("#val-21-input").val(parseInt(grblParams['$21'])).trigger("change");
    $("#val-22-input").val(parseInt(grblParams['$22'])).trigger("change");
    $("#val-23-input").val(parseInt(grblParams['$23'])).trigger("change");
    $("#val-5-input").val(parseInt(grblParams['$5'])).trigger("change");
    $("#val-6-input").val(parseInt(grblParams['$6'])).trigger("change");
    $("#val-2-input").val(parseInt(grblParams['$2'])).trigger("change");
    $("#val-3-input").val(parseInt(grblParams['$3'])).trigger("change");
    $("#val-4-input").val(parseInt(grblParams['$4'])).trigger("change");
    $("#val-13-input").val(parseInt(grblParams['$13'])).trigger("change");
  }, 100);;

  $('#hardlimitsenabled:checkbox').change(function() {
    toggleHardLimits();
  });
  $('#homingenabled:checkbox').change(function() {
    toggleHoming();
  });

  $('#xdirinvert:checkbox').change(function() {
    changeDirInvert();
  });
  $('#ydirinvert:checkbox').change(function() {
    changeDirInvert();
  });
  $('#zdirinvert:checkbox').change(function() {
    changeDirInvert();
  });

  $('#xHomeDir:checkbox').change(function() {
    changeProbeDirInvert();
  });
  $('#yHomeDir:checkbox').change(function() {
    changeProbeDirInvert();
  });
  $('#zHomeDir:checkbox').change(function() {
    changeProbeDirInvert();
  });

  // populare Direction Invert Checkboxes
  displayDirInvert()
  displayProbeDirInvert()

  console.log("Updated")
}

// P6: Hard Limits ($21) and Homing ($22) used to be forced together as one
// "limits installed" checkbox (enableLimits()). They're now two independent
// toggles, each touching only its own setting - nothing else.
function toggleHardLimits() {
  var enabled = $('#hardlimitsenabled').is(':checked');
  $("#val-21-input").val(enabled ? 1 : 0);
  allowGrblSettingsViewScroll = false;
  setTimeout(function() {
    allowGrblSettingsViewScroll = true;
  }, 500);
  checkifchanged();
}

function toggleHoming() {
  var enabled = $('#homingenabled').is(':checked');
  $("#val-22-input").val(enabled ? 1 : 0);
  allowGrblSettingsViewScroll = false;
  setTimeout(function() {
    allowGrblSettingsViewScroll = true;
  }, 500);
  checkifchanged();
}

// Syncs the two checkboxes above FROM the current form values - used after
// loading a settings backup (where $21/$22 came from the backup file itself
// and must not be overwritten by re-deriving them from checkbox state).
function syncHardLimitAndHomingCheckboxes() {
  $('#hardlimitsenabled:checkbox').prop('checked', parseFloat($("#val-21-input").val()) == 1);
  $('#homingenabled:checkbox').prop('checked', parseFloat($("#val-22-input").val()) > 0);
}
