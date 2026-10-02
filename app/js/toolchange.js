var sectionNum = 0;
var toolchanges = [];

// P10 Tahap 1b-i/1b-ii: the client's chosen tool-change mode for M6 handling
// (separate from the firmware-native ATC/$341 toggle above it in the UI).
// 'pause' is the safe default for a fresh install or an unrecognised saved
// value - same "repair on read" pattern as restoreUnitsMode() in
// app/js/jog.js. 'fixedToolSensor' is UI-only as of this commit (Tahap 1b-ii
// Commit 1) - the server does not yet implement it (Commit 4 does) and
// safely falls back to 'pause' itself in the meantime, same as any other
// value it does not recognise.
var TOOLCHANGE_MODES = ['pause', 'ignore', 'fixedToolSensor'];
var toolChangeMode = 'pause';

function setToolChangeMode(mode) {
  toolChangeMode = TOOLCHANGE_MODES.indexOf(mode) !== -1 ? mode : 'pause';
  try {
    localStorage.setItem('toolChangeMode', toolChangeMode);
  } catch (e) {}
}

function restoreToolChangeMode() {
  var saved = null;
  try {
    saved = localStorage.getItem('toolChangeMode');
  } catch (e) {}
  setToolChangeMode(saved); // also (re)writes the saved value, repairing an unrecognised one
  $('#toolChangeMode').val(toolChangeMode);
}

// --------------------------------------------------------------------------
// Tahap 1b-ii: Fixed Tool Sensor settings (sensor location + first-tool
// behaviour). Entirely client-side storage so far - nothing here is read by
// the server yet (that starts at Commit 2/4). $20 (soft limits) is validated
// here, client-side, against the live grblParams the app already parses
// from "$$" (app/js/grbl-settings.js) - the server stays stateless about
// individual $ values, consistent with the rest of this app's architecture.
// --------------------------------------------------------------------------

var TOOLSENSOR_FIRST_BEHAVIOURS = ['always-wizard', 'always-probe', 'prompt'];
var TOOLSENSOR_FIRST_BEHAVIOUR_DEFAULT = 'always-wizard';

function isSoftLimitsEnabledForToolSensor() {
  return typeof grblParams !== 'undefined' && grblParams['$20'] == 1;
}

// null if nothing saved, or the saved value is malformed.
function getToolSensorLocation() {
  var raw = null;
  try {
    raw = localStorage.getItem('toolSensorLocation');
  } catch (e) {
    return null;
  }
  if (!raw) return null;
  var loc;
  try {
    loc = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!loc || typeof loc.x !== 'number' || typeof loc.y !== 'number' || typeof loc.z !== 'number' ||
    !isFinite(loc.x) || !isFinite(loc.y) || !isFinite(loc.z)) {
    return null;
  }
  return { x: loc.x, y: loc.y, z: loc.z };
}

function setToolSensorLocation(loc) {
  try {
    localStorage.setItem('toolSensorLocation', JSON.stringify({ x: loc.x, y: loc.y, z: loc.z }));
  } catch (e) {}
}

function getToolSensorFirstBehaviour() {
  var saved = null;
  try {
    saved = localStorage.getItem('toolSensorFirstBehaviour');
  } catch (e) {}
  return TOOLSENSOR_FIRST_BEHAVIOURS.indexOf(saved) !== -1 ? saved : TOOLSENSOR_FIRST_BEHAVIOUR_DEFAULT;
}

function setToolSensorFirstBehaviour(value) {
  var v = TOOLSENSOR_FIRST_BEHAVIOURS.indexOf(value) !== -1 ? value : TOOLSENSOR_FIRST_BEHAVIOUR_DEFAULT;
  try {
    localStorage.setItem('toolSensorFirstBehaviour', v);
  } catch (e) {}
  return v;
}

// Reads the CURRENT machine-coordinate position (work position + work
// offset, same formula the DRO tooltips already use - see #xPos's title
// attribute in app/js/websocket.js) and saves it as the sensor location.
// Refuses (returns null, saves nothing) if Soft Limits is off - this is the
// enforced prerequisite, not just a note in a tooltip.
//
// Reads `laststatus` - NOT `status`: the live status object only exists as
// the parameter of socket.on('status', function(status) {...}) in
// websocket.js; laststatus = status is what that handler assigns it to for
// everything else in the app to read afterwards (see e.g. test/helpers/
// recovery-env.js's ctx.laststatus).
function captureToolSensorLocation() {
  if (!isSoftLimitsEnabledForToolSensor()) return null;
  if (typeof laststatus === 'undefined' || !laststatus || !laststatus.machine || !laststatus.machine.position) return null;
  var p = laststatus.machine.position;
  var loc = {
    x: parseFloat((p.work.x + p.offset.x).toFixed(3)),
    y: parseFloat((p.work.y + p.offset.y).toFixed(3)),
    z: parseFloat((p.work.z + p.offset.z).toFixed(3)),
  };
  setToolSensorLocation(loc);
  return loc;
}

function toolSensorLocationText(loc) {
  return loc ? ('X' + loc.x + ' Y' + loc.y + ' Z' + loc.z) : 'Belum diatur / Not set';
}

function showToolSensorSettings() {
  var loc = getToolSensorLocation();
  var behaviour = getToolSensorFirstBehaviour();
  var softLimitsOn = isSoftLimitsEnabledForToolSensor();
  var captureTitle = softLimitsOn ?
    'Jog ke posisi sensor fisik dulu, lalu klik' :
    'Aktifkan Soft Limits ($20) dulu di Grbl Settings untuk pakai Fixed Tool Sensor';

  Metro.dialog.create({
    clsDialog: 'dark',
    title: "<i class='fas fa-ruler-vertical'></i> Fixed Tool Sensor Settings",
    content:
      '<div>Lokasi sensor (koordinat mesin): <b id="toolSensorLocationText">' + toolSensorLocationText(loc) + '</b></div>' +
      '<button class="button mt-2" id="captureToolSensorBtn"' + (softLimitsOn ? '' : ' disabled') +
      ' title="' + captureTitle + '">Jadikan Posisi Saat Ini sebagai Lokasi Sensor</button>' +
      (softLimitsOn ? '' : '<div class="fg-red mt-2">Aktifkan Soft Limits ($20) dulu di Grbl Settings untuk pakai Fixed Tool Sensor.</div>') +
      '<div class="mt-4"><label>Perilaku tool pertama dalam job:</label><br>' +
      '<select data-role="select" data-filter="false" id="toolSensorFirstBehaviourSelect">' +
      '<option value="always-wizard"' + (behaviour === 'always-wizard' ? ' selected' : '') + '>Selalu jalankan wizard penuh</option>' +
      '<option value="always-probe"' + (behaviour === 'always-probe' ? ' selected' : '') + '>Selalu probe panjang saja</option>' +
      '<option value="prompt"' + (behaviour === 'prompt' ? ' selected' : '') + '>Tanya setiap kali</option>' +
      '</select></div>',
    actions: [{ caption: 'Tutup / Close', cls: 'js-dialog-close' }],
  });

  $('#captureToolSensorBtn').on('click', function() {
    var newLoc = captureToolSensorLocation();
    if (newLoc) {
      $('#toolSensorLocationText').html(toolSensorLocationText(newLoc));
    }
  });
  $('#toolSensorFirstBehaviourSelect').on('change', function() {
    setToolSensorFirstBehaviour(this.value);
  });
}

// Skeleton script to replace the Visualiser cone with an STL of an endmill
function replaceConeWith(toolid) {
  if (toolid = "635mmendmill") {
    workspace.remove(cone);
    var loader = new THREE.STLLoader();
    loader.load("./img/tools/endmill635.stl", function(geometry) {

      const material = new THREE.MeshPhongMaterial({
        color: 0xaaaaaa,
        specular: 0x111111,
        shininess: 200
      })
      cone = new THREE.Mesh(geometry, material)
      // geometry.center()
      cone.overdraw = true;
      //cone.rotation.x = -90 * Math.PI / 180;
      cone.position.x = 0;
      cone.position.y = 0;
      cone.position.z = 0;
      cone.material.opacity = 0.6;
      cone.material.transparent = true;
      cone.castShadow = false;
      cone.visible = false;
      cone.name = "Simulation Marker"
      workspace.add(cone)
    })
  }
}

// Skeleton code to spin endmill if spindle is on
function toolAnimate() {
  // if (laststatus !== undefined) {
  //   if (laststatus.machine.modals.spindlestate == "M3") {
  //     cone.rotation.z += -3.5;
  //   } else if (laststatus.machine.modals.spindlestate == "M4") {
  //     cone.rotation.z += 3.5;
  //   }
  // }
}

function populateToolChanges(gcode) {

  // toolChanges
  toolchanges = setupToolChanges(gcode);

  if (toolchanges.length) {
    $('#runBtn').hide()
    $('#runToolsBtn').show()
    $('#toolChangesMenu').empty();
    var dropdownTemplate = ``;
    if (toolchanges[0].lineNum > 0) {
      dropdownTemplate += `<li onclick="runGcodeAllTools()"><a href="#" onclick=""><i class="fas fa-play"></i> Run Complete Job</a></li>`
      dropdownTemplate += `<li class="divider"></li>`
      dropdownTemplate += `<li onclick="runGcodeSection(` + 0 + `,` + toolchanges[0].lineNum + `)"><a href="#" onclick=""><i class="fas fa-play"></i> Run Header (lines 1-` + toolchanges[0].lineNum + `)</a></li>`

    }
    for (i = 0; i < toolchanges.length; i++) {
      var endline = false;
      if (toolchanges[i + 1]) {
        endline = toolchanges[i + 1].lineNum
      }
      dropdownTemplate += `<li onclick="runGcodeSection(` + toolchanges[i].lineNum + `,` + endline + `)">`
      dropdownTemplate += `<a href="#" onclick=""><i class="fas fa-play"></i> Run Tool `
      if (toolchanges[i].toolNum) {
        dropdownTemplate += toolchanges[i].toolNum + ` `
      }
      dropdownTemplate += ` from line ` + (toolchanges[i].lineNum + 1) + ` `
      if (toolchanges[i].toolComment) {
        dropdownTemplate += `/ Tool Details: ` + toolchanges[i].toolComment + ` `
      }
      if (toolchanges[i].sectionComment) {
        dropdownTemplate += `/ Section ` + toolchanges[i].sectionComment + ` `
      }
      dropdownTemplate += `</a></li>`
    }
    $('#toolChangesMenu').html(dropdownTemplate)
  } else {
    $('#runBtn').show()
    $('#runToolsBtn').hide()
  }
}

function runGcodeAllTools() {

  var gcode = editor.getValue()
  gcodeLines = gcode.split("\n")

  var multiToolJob = [];

  // Header
  if (toolchanges[0].lineNum > 0) {
    var headergcode = gcodeLines.slice(0, toolchanges[0].lineNum).join("\n").replace(/M6|M06|M006/i, "");
    var section = {
      gcode: headergcode,
      toolNum: false,
      toolComment: false,
      sectionComment: sectionComment,
      startLine: 0,
      endLine: toolchanges[0].lineNum,
      completed: false
    }
    multiToolJob.push(section)
  }

  // Toolchanges
  for (i = 0; i < toolchanges.length; i++) {
    var startLine = toolchanges[i].lineNum + 1
    if (toolchanges[i + 1]) {
      var endLine = toolchanges[i + 1].lineNum
    } else {
      endLine = false;
    }
    if (toolchanges[i].toolNum) {
      var toolNum = toolchanges[i].toolNum
    }
    if (toolchanges[i].toolComment) {
      var toolComment = toolchanges[i].toolComment
    }
    if (toolchanges[i].sectionComment) {
      var sectionComment = toolchanges[i].sectionComment
    }
    if (endLine) {
      var newgcode = gcodeLines.slice(startLine, endLine).join("\n").replace(/M6|M06|M006/i, "");
    } else {
      var newgcode = gcodeLines.slice(startLine).join("\n").replace(/M6|M06|M006/i, "");
    }
    var section = {
      gcode: newgcode,
      toolNum: toolNum,
      toolComment: toolComment,
      sectionComment: sectionComment,
      startLine: startLine,
      endLine: endLine,
      completed: false
    }
    multiToolJob.push(section)
  }
  // Now run this array one by one
  console.log(JSON.stringify(multiToolJob))
}

// endline can be Blank
function runGcodeSection(startline, endline) {
  var gcode = editor.getValue()
  gcodeLines = gcode.split("\n")
  if (endline) {
    var newgcode = gcodeLines.slice(startline, endline)
  } else {
    var newgcode = gcodeLines.slice(startline)
  }

  var newGcodeString = newgcode.join("\n").replace(/M6|M06|M006/i, "");

  console.log(newGcodeString)
  socket.emit('runJob', {
    data: newGcodeString,
    isJob: true,
    fileName: loadedFileName,
    // P9: this sends a SLICE of the editor. Line 1 of the slice is editor line
    // startline+1 - tell the server so the line it records for "Recover Job"
    // is an editor line, not a slice-relative one.
    lineOffset: startline || 0
  });
}

function setupToolChanges(gcode) {
  // scan gcode for tool change info
  var fileLines = gcode
  fileLines = fileLines.split("\n")
  // console.log("about to look for tool changes in gcode editor:", fileLines.length, "\n\n\n");

  var toolComments = {};
  var toolChanges = {};
  var toolChangesKeys = [];

  for (var i = 0; i < fileLines.length; i++) {
    var line = fileLines[i];

    // see if we have line where comment starts with
    // look for something like:
    // (T1 D=3.175 CR=0. - ZMIN=-4.2 - FLAT END MILL)
    // ;T1 1/4 inch flat bottom endmill
    // T0 ; 1/4 inch flat bottom endmill
    if (line.match(/\(T(\d+)\s+(.*)\)/i) || line.match(/\;T(\d+)\s+(.*)\)/i) || line.match(/\T(\d+)/i)) {
      var toolNum = parseInt(RegExp.$1);
      if (toolComments[toolNum] && !toolComments[toolNum].toolComment) {
        // var toolComment = "T" + toolNum + " " + RegExp.$2;
      } else if (toolComments[toolNum] && toolComments[toolNum].toolComment) {
        var toolComment = toolComments[toolNum].toolComment + " " + RegExp.$2;
      } else {
        var toolComment = "T" + toolNum + " " + RegExp.$2;
      }
      // var toolComment = "T" + toolNum + " " + RegExp.$2;
      console.log("found tool comment. lineNum:", i, "toolNum:", toolNum, "comment:", toolComment, "line:", line);
      toolComments[toolNum] = {
        lineNum: i + 1,
        toolNum: toolNum,
        toolComment: toolComment,
      }
    }

    // look for M6 line
    if (line.match(/M6|M06|M006/i)) {
      var toolNum;
      if (line.match(/T(\d+)/i)) {
        toolNum = parseInt(RegExp.$1);
      }
      toolChanges[(i + 1)] = {
        lineNum: i + 1,
        toolNum: toolNum,
      };
      toolChangesKeys.push(i + 1);
      // console.log("found tool change. lineNum:", i, "line:", line);
    }
  }

  // console.log("this.toolComments:", toolComments);
  // console.log("this.toolChanges:", toolChanges);

  // now look for a comment up to 10 lines above the M6 tool change line to see if any comments are there
  var keys = toolChangesKeys; //Object.keys(this.toolChanges).sort();
  // console.log("looking for comments above m6 to get a label for this tool change. keys:", keys);
  for (var i = 0; i < keys.length; i++) {
    var toolChangeLineNum = keys[i];
    var lookBackToLineNum = toolChangeLineNum - 10;
    if (lookBackToLineNum < 1) lookBackToLineNum = 1; // first line

    // now look backwards until we've seen just 1 comment
    for (var lineNum = toolChangeLineNum; lineNum >= lookBackToLineNum; lineNum--) {
      var line = fileLines[lineNum - 1]; // index of array is 1 less than lineNum
      // console.log("looking at lineNum:", lineNum, "line:", line);
      // see if comment
      if (line.match(/\((.*?)\)/) || line.match(/;(.*)/)) {
        var comment = RegExp.$1;
        // console.log("found comment:", comment);

        // stick comment into toolChanges
        toolChanges[toolChangeLineNum].sectionComment = comment;

        // break since we found one
        break;
      }
    }
  }

  // console.log("after adding section comments. this.toolChanges:", toolChanges);
  // console.log("after adding section comments. this.toolComments:", toolComments);
  // console.log("after adding section comments. this.toolChangesKeys:", toolChangesKeys);

  var toolChangesArray = []

  for (var i = 0; i < keys.length; i++) {

    var toolChange = toolChanges[keys[i]];
    console.log(toolChange)
    var tool = toolComments[toolChange.toolNum];
    var newToolChange = {
      lineNum: false,
      toolNum: false,
      toolComment: false,
      sectionComment: false
    }

    newToolChange.toolNum = toolChange.toolNum
    newToolChange.lineNum = toolChange.lineNum

    if ('sectionComment' in toolChange) {
      newToolChange.sectionComment = toolChange.sectionComment
    }

    if (tool != null) {
      newToolChange.toolComment = tool.toolComment
    }

    toolChangesArray.push(newToolChange)
  }

  return toolChangesArray;

}