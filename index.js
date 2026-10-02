process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';

// Urban Creator CONTROL (DEV) display name for tray/window/notification text.
// Must stay a literal string, NOT require('./package').build.productName -
// electron-builder strips the "build" block out of package.json when it
// packages app.asar (verified against dist/win-unpacked's actual built
// app.asar), so that would throw at runtime in the packaged app. Declared
// here, before any other code, since it's used as early as the first
// debug_log() call below.
const APP_DISPLAY_NAME = "Urban Creator CONTROL"

process.on('uncaughtException', function(err) {
  //showErrorDialog(err, attempts = 2) // make two attempts to show an uncaughtException in a dialog
  if (DEBUG) {
    debug_log(err)
  } else {
    console.log(err);
  }
  // Record serial port state at crash time - this handler doesn't exit the
  // process (pre-existing behavior, unchanged here), but knowing whether a
  // port was open when an uncaught exception hit is the key diagnostic for
  // tracking down a "stuck COM port" report after the fact.
  try {
    var portInfo = 'no port opened yet';
    if (typeof port !== 'undefined' && port) {
      portInfo = (port.path || port.remoteAddress || 'unknown') + ', isOpen=' + !!port.isOpen;
    }
    serialLog('error', 'uncaughtException: ' + (err && err.stack ? err.stack : err) + ' | serial port state: ' + portInfo);
  } catch (e) {}
})

function showErrorDialog(err, attempts) {
  console.error('Attempting to show an error dialog.')
  if (!attempts) return;
  try {
    let options = {
      type: 'error',
      buttons: ['OK'],
      title: 'Error',
      message: `An error occured.`,
      detail: `${err.message}\r\r\rIf you feel this shouldn't be happening, please report it at:\r\rhttps://github.com/adebagus/urban-creator-control/issues`,
    };
    let window = BrowserWindow.getFocusedWindow()
    dialog.showMessageBoxSync(window, options)
  } catch (e) {
    console.error(`An error occurred trying show an error, ho-boy. ${e}. We'll try again ${attempts} more time(s).`)
    setTimeout(() => {
      showErrorDialog(err, --attempts)
    }, millisecondDelay = 2000);
  }
}

// To see console.log output run with `DEBUGCONTROL=true electron .` or set environment variable for DEBUGCONTROL=true
// debug_log debug overhead
DEBUG = false;
if (process.env.DEBUGCONTROL) {
  DEBUG = true;
  console.log("Console Debugging Enabled")
}

function debug_log() {
  if (DEBUG) {
    console.log.apply(this, arguments);
  }
} // end Debug Logger

debug_log("Starting " + APP_DISPLAY_NAME + " v" + require('./package').version)

var config = {};
// P3: Urban Creator CONTROL (DEV) uses its own port range so it can run
// alongside the original OpenBuilds CONTROL (which uses 3000/3020/3200/3220
// + 3001 for TLS) without either one failing to bind or silently stealing
// the other's port. Override with WEB_PORT/WEB_PORT_SSL env vars if needed.
config.webPorts = [4000, 4020, 4200, 4220]
config.webPortIdx = 0;
config.nextWebPort = function() {
  config.webPort = config.webPorts[config.webPortIdx]
  config.webPortIdx++
  if (config.webPortIdx == config.webPorts.length) {
    throw new Error(`No ports were available to start the http server.\r\rWe tried ports ${config.webPorts.join(",")}.`);
  }
  return config.webPort;
}
config.webPort = process.env.WEB_PORT || config.nextWebPort();
config.webPortSsl = process.env.WEB_PORT_SSL || 4001;
config.posDecimals = process.env.DRO_DECIMALS || 3;
config.grblWaitTime = 0.5;

// P3/P9: origin allowlist, used by BOTH the Express HTTP API (below) and the
// Socket.IO handshake (see allowRequest on the io server).
//
// P9 correction: the original P3 note here claimed Socket.IO didn't need this
// because "Socket.IO's own same-origin default already prevents an unrelated
// website's JS from using it cross-origin". That was wrong. Socket.IO's CORS
// handling only covers the HTTP long-polling transport; a WebSocket handshake
// is not subject to the browser's same-origin policy at all (no preflight, no
// CORS), and engine.io performs no origin check of its own unless the server
// supplies allowRequest. Any site the user happened to have open could
// therefore open ws://localhost:<port>/socket.io/ and emit serialInject /
// runCommand / flashGrblHal etc. - full control of the machine. What actually
// protects the socket now is the allowRequest hook wired up below, reusing
// this same list so HTTP and WebSocket can never drift apart.
//
// This MUST be computed fresh on every call, not captured into a static
// array once at module load: config.webPort/webPortSsl are only a first
// guess at this point in the file - if that port is already taken,
// httpServerError() below calls config.nextWebPort() and mutates
// config.webPort asynchronously, well after this point in the script has
// already run. A static array here would keep pointing at the abandoned
// first-guess port forever, rejecting every legitimate request from the
// renderer once it's actually running on the fallback port.
function getAllowedOrigins() {
  var origins = [
    'http://localhost:' + config.webPort,
    'http://127.0.0.1:' + config.webPort,
    'https://localhost:' + config.webPortSsl,
    'https://127.0.0.1:' + config.webPortSsl
  ];

  // P9: the LAN "Jog from Phone" page is served by this very server, and the
  // QR code in the Jog Widget dialog encodes http://<this host's LAN IP>:
  // <webPort>/jog (see jogWidget() in app/js/widget.js), so the phone's
  // browser sends exactly that as its Origin. Enumerate every non-internal
  // IPv4 address this host actually has, rather than only ip.address()'s
  // single primary guess - a machine with both Wi-Fi and Ethernet would
  // otherwise reject the phone whenever it reached the server over the other
  // interface. This stays a tight allowlist: only addresses belonging to this
  // machine, on the port this server is actually listening on.
  // (require here, not at module scope: index.js already has a `const os` far
  // below, and a second top-level declaration would be a redeclaration error.)
  try {
    var ifaces = require('os').networkInterfaces();
    Object.keys(ifaces).forEach(function(ifname) {
      (ifaces[ifname] || []).forEach(function(iface) {
        if (iface.internal) return;
        if (iface.family !== 'IPv4' && iface.family !== 4) return;
        origins.push('http://' + iface.address + ':' + config.webPort);
        origins.push('https://' + iface.address + ':' + config.webPortSsl);
      });
    });
  } catch (e) {
    // Interface enumeration failing must not take the allowlist with it -
    // localhost entries above still let the desktop renderer work.
  }

  return origins;
}

var express = require("express");
var app = express();
var http = require("http").Server(app);
var https = require('https');

//var ioServer = require('socket.io');
const {
  Server: ioServer
} = require('socket.io');

// P9: every socket event this server exposes can move the machine
// (serialInject writes straight to the port, runCommand streams gcode,
// flashGrblHal reflashes the controller, writeInterfaceUsbDrive writes files,
// quit kills the app mid-job). Until now the handshake was completely
// unauthenticated and unvalidated. allowRequest is engine.io's only hook that
// runs for BOTH transports - polling AND the WebSocket upgrade - so this is
// the one place an origin check actually covers cross-site WebSocket
// hijacking. Serving the client library (/socket.io/socket.io.js) happens in
// socket.io's own request handler before this hook, so the jog page can still
// load its script and then connect.
//
// P9 correction: the initial version of this also rejected requests with NO
// Origin header at all, on the assumption that "browsers always send Origin
// on a WebSocket handshake" - true, but irrelevant, because socket.io's
// client doesn't start with a WebSocket. It first does a plain
// `GET /socket.io/?EIO=4&transport=polling` handshake, and browsers omit the
// Origin header on a same-origin GET. Both the Electron renderer
// (http://localhost:<port> talking to itself) and the LAN "Jog from Phone"
// page (http://<lan-ip>:<port> talking to itself) are same-origin to this
// server, so BOTH were being rejected at the very first handshake - the
// entire app went permanently NOCOMM. Confirmed via serial.log: 50 straight
// "no Origin header" rejections from 127.0.0.1, zero "disallowed origin"
// ones. Fixed by allowing the no-Origin case - a cross-site page cannot
// forge this, since a cross-origin request (the actual attack this guards
// against) always carries a real Origin header the browser sets itself, so
// the reject-on-mismatch branch below still closes that hole.
var io = new ioServer({
  allowRequest: function(req, callback) {
    var origin = req.headers.origin;
    var peer = (req.socket && req.socket.remoteAddress) || 'unknown';

    if (!origin) {
      // No Origin means either a same-origin request from this app's own
      // pages (the common case - see above) or a non-browser client that
      // doesn't set one. Either way, a hostile cross-origin page cannot
      // reach this branch: the browser itself attaches a real Origin header
      // to any actual cross-origin request, which is rejected below instead.
      return callback(null, true);
    }

    if (!isAllowedOrigin(origin)) {
      serialLog('warn', 'Socket.IO handshake rejected from disallowed origin: ' + origin + ' (' + peer + ')');
      return callback(null, false);
    }

    return callback(null, true);
  }
});

var fs = require('fs');
var path = require("path");
const join = require('path').join;
const {
  mkdirp
} = require('mkdirp')


//const drivelist = require('drivelist'); // removed in 1.0.350 due to Drivelist stability issues

// FluidNC test
var fluidncConfig = "";
// FluidNC end test

app.use(express.static(path.join(__dirname, "app")));
//app.use(express.limit('200M'));

// P3: origin allowlist for CORS. This used to reflect "*" (any origin) plus
// Access-Control-Allow-Private-Network: true, which let an arbitrary website
// open in the user's browser make cross-origin requests to this server (e.g.
// POST /runjob to run gcode on the connected machine) just because the
// server happened to be reachable. Only this app's own pages need to pass
// CORS here - the LAN "Jog from Phone" page (app/jog) never needs it, since
// its own requests back to whatever host:port it was loaded from are
// same-origin and exempt from CORS regardless of this allowlist.
function isAllowedOrigin(origin) {
  if (!origin) return false;
  return getAllowedOrigins().indexOf(origin) !== -1;
}

app.use(function setCommonHeaders(req, res, next) {
  var origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Private-Network", "true");
  }
  next();
});

// P3: an Access-Control-Allow-Origin response header only stops a foreign
// page's JS from READING the response - it does nothing to stop the request
// itself from being sent and processed (a plain auto-submitting cross-site
// <form> to /runjob is not subject to CORS at all, classic CSRF). Browsers
// do send an Origin header on cross-origin state-changing requests even
// though CORS doesn't require it, so actively reject those here for routes
// that change machine/file state - this is what actually stops another
// website from silently running gcode on the connected machine.
var stateChangingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
app.use(function rejectCrossOriginStateChanges(req, res, next) {
  var origin = req.headers.origin;
  if (stateChangingMethods.indexOf(req.method) !== -1 && origin && !isAllowedOrigin(origin)) {
    serialLog('warn', 'Rejected ' + req.method + ' ' + req.path + ' from disallowed origin: ' + origin);
    return res.status(403).send('Forbidden: origin not allowed');
  }
  next();
});


// Interface firmware flash
app.post('/uploadCustomFirmware', (req, res) => {
  // 'firmwareBin' is the name of our file input field in the HTML form
  let upload = multer({
    storage: storage
  }).single('firmwareBin');

  upload(req, res, function(err) {
    // req.file contains information of uploaded file
    // req.body contains information of text fields, if there were any

    if (err instanceof multer.MulterError) {
      return res.send(err);
    } else if (err) {
      return res.send(err);
    }

    // Display uploaded image for user validation
    firmwareImagePath = req.file.path;
    res.send(req.file.path);
  });
});
// end Interface Firmware flash


// P4: this used to load OpenBuilds' own Let's Encrypt key/cert for
// mymachine.openbuilds.com (privkey1.pem/fullchain1.pem) - that's their
// credential, not something this fork should carry or present as its own
// identity, so it's been removed. Replaced with a self-signed, 10-year
// placeholder generated just for this fork (dev-selfsigned-*.pem, CN=
// localhost) so the internal HTTPS listener keeps working. It has no CA
// trust chain, so a browser hitting https://localhost:<port> directly will
// show an untrusted-certificate warning - nothing in this app currently
// navigates there itself (the renderer always loads over plain http://),
// so this only matters if something starts requiring HTTPS specifically.
var httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, 'dev-selfsigned-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'dev-selfsigned-cert.pem'))
};

const httpsserver = https.createServer(httpsOptions, app).listen(config.webPortSsl, function() {
  debug_log('https: listening on:' + ip.address() + ":" + config.webPortSsl);
});

const httpserver = http.listen(config.webPort, '0.0.0.0', httpServerSuccess).on('error', httpServerError);

function httpServerSuccess() {
  debug_log('http:  listening on:' + ip.address() + ":" + config.webPort);
  // status.driver.webPort was set once from config.webPort when the status
  // object literal was constructed, before any fallback-port retry below
  // could run - refresh it here now that we know the port we actually bound
  // to, so LAN-facing pages (Jog from Phone widget) never advertise a stale,
  // abandoned port number.
  status.driver.webPort = config.webPort;
  if (jogWindow) {
    jogWindow.loadURL(`http://localhost:${config.webPort}/`);
  }
}

function httpServerError(error) {
  // If unable to start (port in use) - try next port in array from config.nextWebPort()
  console.error(error.message);
  httpserver.listen(config.nextWebPort());
}

io.attach(httpserver);
io.attach(httpsserver);

const grblStrings = require("./grblStrings.js");

// Serial
const {
  SerialPort
} = require('serialport')
const {
  ReadlineParser
} = require('@serialport/parser-readline')



// telnet
const net = require('net');
var ip = require("ip");
const Evilscan = require('evilscan');

var md5 = require('md5');
var _ = require('lodash');
var formidable = require('formidable')
var lastsentuploadprogress = 0;

// Electron app
const electron = require('electron');
const electronApp = electron.app;

// Urban Creator CONTROL (DEV): keep userData isolated from OpenBuilds CONTROL
// regardless of app "name"/productName changes made in later stages.
electronApp.setPath('userData', path.join(electronApp.getPath('appData'), 'UrbanCreatorCONTROL-dev'))

electronApp.setAppUserModelId("id.urbancreator.control.dev")

const {
  dialog
} = require('electron')
electronApp.commandLine.appendSwitch('ignore-gpu-blacklist')
electronApp.commandLine.appendSwitch('enable-gpu-rasterization')
electronApp.commandLine.appendSwitch('enable-zero-copy')

// --- Serial port lifecycle diagnostics (P1) ---------------------------------
// Persistent log of every open/close/error on the CNC serial connection, so a
// blocked-COM-port report can be diagnosed after the fact (console output is
// not visible in a packaged/tray-mode build). Written to userData so DEV and
// the original OpenBuilds CONTROL never share a log file.
function getUserDataDir() {
  try {
    if (isElectron() && electronApp && electronApp.getPath) {
      return electronApp.getPath('userData');
    }
  } catch (e) {}
  return __dirname;
}

function serialLog(level, message) {
  var line = '[' + new Date().toISOString() + '] [' + level.toUpperCase() + '] ' + message;
  console.log(line);
  try {
    var logPath = path.join(getUserDataDir(), 'serial.log');
    try {
      if (fs.statSync(logPath).size > 2 * 1024 * 1024) { // simple 2MB cap, no rotation needed for this log's volume
        fs.writeFileSync(logPath, '');
      }
    } catch (statErr) {} // file doesn't exist yet - fine
    fs.appendFileSync(logPath, line + '\n');
  } catch (e) {
    console.error('Failed to write serial.log:', e.message);
  }
}
// --- end serial port lifecycle diagnostics ----------------------------------

if (isElectron()) {
  debug_log("Local User Data: " + electronApp.getPath('userData'))
}

const BrowserWindow = electron.BrowserWindow;
const Tray = electron.Tray;
const nativeImage = require('electron').nativeImage
const Menu = require('electron').Menu

var appIcon = null,
  jogWindow = null,
  mainWindow = null
var autoUpdater


var updateIsDownloading = false;
if (isElectron()) {
  autoUpdater = require("electron-updater").autoUpdater
  var availversion = '0.0.0'

  autoUpdater.on('checking-for-update', () => {
    var string = 'Starting update... Please wait';
    var output = {
      'command': 'autoupdate',
      'response': string
    }
    io.sockets.emit('updatedata', output);
  })
  autoUpdater.on('update-available', (ev, info) => {
    updateIsDownloading = true;
    var string = "Starting Download: v" + ev.version;
    availversion = ev.version
    var output = {
      'command': 'autoupdate',
      'response': string
    }
    io.sockets.emit('updatedata', output);
    debug_log(JSON.stringify(ev))
  })
  autoUpdater.on('update-not-available', (ev, info) => {
    var string = 'Update not available. Installed version: ' + require('./package').version + " / Available version: " + ev.version + ".\n";
    if (require('./package').version === ev.version) {
      string += "You are already running the latest version!"
    }
    var output = {
      'command': 'autoupdate',
      'response': string
    }
    io.sockets.emit('updatedata', output);
    debug_log(JSON.stringify(ev))
  })
  autoUpdater.on('error', (ev, err) => {
    if (err) {
      var string = 'Error in auto-updater: \n' + err.split('SyntaxError')[0];
    } else {
      var string = 'Error in auto-updater';
    }
    var output = {
      'command': 'autoupdate',
      'response': string
    }
    io.sockets.emit('updatedata', output);
  })
  autoUpdater.on('download-progress', (ev, progressObj) => {
    updateIsDownloading = true;
    var string = 'Download update ... ' + ev.percent.toFixed(1) + '%';
    debug_log(string)
    var output = {
      'command': 'autoupdate',
      'response': string
    }
    io.sockets.emit('updatedata', output);
    io.sockets.emit('updateprogress', ev.percent.toFixed(0));
  })

  autoUpdater.on('update-downloaded', (info) => {
    var string = "New update ready";
    var output = {
      'command': 'autoupdate',
      'response': string
    }
    io.sockets.emit('updatedata', output);
    io.sockets.emit('updateready', availversion);
    // repeat every minute
    setTimeout(function() {
      io.sockets.emit('updateready', availversion);
    }, 1000 * 60 * 60 * 8) // 8hrs before alerting again if it was snoozed
    updateIsDownloading = false;
  });
} else {
  debug_log("Running outside Electron: Disabled AutoUpdater")
}

if (isElectron()) {
  var uploadsDir = electronApp.getPath('userData') + '/upload/';
} else {
  var uploadsDir = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + 'Library/Preferences' : '/var/local')
}
var jobStartTime = false;
var jobCompletedMsg = ""; // message sent when job is done
var uploadedgcode = ""; // var to store uploaded gcode
var uploadedworkspace = ""; // var to store uploaded OpenBuildsCAM Workspace

mkdirp(uploadsDir).then(made =>
  debug_log('Created Uploads Temp Directory'))

// Check USB Selective Suspend Settings
function checkPowerSettings() {
  if (process.platform == 'win32') {
    debug_log("Checking Power Settings")
    var powerplan = "",
      usbselectiveAC = false,
      usbselectiveDC = false;
    const {
      exec
    } = require('child_process');

    const cfg = exec('powercfg /GETACTIVESCHEME', function(error, stdout, stderr) {
      if (error) {
        debug_log(error.stack);
        debug_log('Error code: ' + error.code);
        debug_log('Signal received: ' + error.signal);
      }
      // console.log('Child Process STDOUT: ' + stdout);
      // console.log('Child Process STDERR: ' + stderr);
      powerplan = stdout.split(":")[1].split("()")[0].trim()
    });

    cfg.on('exit', function(code) {
      debug_log('powercfg /GETACTIVESCHEME exited with exit code ' + code);
      if (code == 0) {
        const usbsetting = exec('powercfg /q ' + powerplan, function(error, stdout, stderr) {
          if (error) {
            debug_log(error.stack);
            debug_log('Error code: ' + error.code);
            debug_log('Signal received: ' + error.signal);
          }
          // console.log('Child Process STDOUT: ' + stdout);
          // console.log('Child Process STDERR: ' + stderr);
          usbselective = (stdout.slice(stdout.search("USB selective suspend setting") - 1)).split("\n")
          usbselective.length = 7;

          if (usbselective[5].indexOf("0x00000000") != -1) {
            debug_log("USB Selective Suspend DISABLED on AC power ")
            status.driver.powersettings.usbselectiveAC = false;
          } else if (usbselective[5].indexOf("0x00000001") != -1) {
            debug_log("USB Selective Suspend ENABLED on AC power ")
            status.driver.powersettings.usbselectiveAC = true;
          }

          if (usbselective[6].indexOf("0x00000000") != -1) {
            debug_log("USB Selective Suspend DISABLED on DC power ")
            status.driver.powersettings.usbselectiveDC = false;
          } else if (usbselective[6].indexOf("0x00000001") != -1) {
            debug_log("USB Selective Suspend ENABLED on DC power ")
            status.driver.powersettings.usbselectiveDC = true;
          }
        });
        usbsetting.on('exit', function(code) {
          debug_log('powercfg /q exited with exit code ' + code);
          setTimeout(function() {
            debug_log(status.driver.powersettings.usbselectiveDC, status.driver.powersettings.usbselectiveAC)
          }, 100);
        })
      }
    });
    //  end USB Selective Suspend
  }
}


var oldiplist;
var oldpinslist;
const iconPath = path.join(__dirname, 'app/icon.png');
const iconNoComm = path.join(__dirname, 'app/icon-notconnected.png');
const iconPlay = path.join(__dirname, 'app/icon-play.png');
const iconStop = path.join(__dirname, 'app/icon-stop.png');
const iconPause = path.join(__dirname, 'app/icon-pause.png');
const iconAlarm = path.join(__dirname, 'app/icon-bell.png');

var iosocket;
var lastCommand = false
var gcodeQueue = [];
// P10: queue index -> { line, tool } for every M6 (tool change) line in the
// CURRENT job, built by runJob() below. Populated only for tracked jobs
// (trackRecovery) - a probing routine or console command with a stray M6 in
// it is not intercepted. Cleared at every point that dumps gcodeQueue (see
// test/reconnect-stale-state.test.js's structural check).
var toolChangeQIndexes = new Map();
// The { line, tool } entry send1Q() is currently waiting on (null when
// status.comms.awaitingToolChange is false) - copied out of toolChangeQIndexes
// at the moment the M6 entry is skipped, so nothing needs to re-derive it by
// queue index later. Cleared at the same points as toolChangeQIndexes.
var pendingToolChange = null;
// One-shot latch: the controller reports "Idle" repeatedly once it truly is
// idle, but the "show the wizard now" event must fire only once per M6.
var toolChangeWizardEmitted = false;
// P10 Tahap 1b-i: how the CURRENT tracked job handles every M6 it hits -
// 'pause' (Tahap 1a's wizard) or 'ignore' (skip silently, no wizard - see
// send1Q()). Set fresh at the start of every tracked runJob() call (never
// conditionally preserved), so unlike the three above it does not need to
// join their reset-at-every-queue-dump discipline: there is no per-index
// state here that could wrongly point at the wrong thing if left stale,
// just one scalar that the NEXT tracked job always overwrites regardless of
// what the last one left behind (locked down by a test that runs one
// 'ignore' job immediately followed by one 'pause' job, with no reset
// in between, and checks the second one is not left running 'ignore').
var toolChangeMode = 'pause';
// P10 Tahap 1b-ii: a SEPARATE queue/pointer/sent-buffer for Fixed Tool
// Sensor's automatic probe gcode - proven necessary, not a style choice: a
// vm-harness test (the investigation before this commit) showed that
// routing this gcode through runJob()/gcodeQueue/send1Q() WHILE the main
// job is parked at awaitingToolChange=true causes two confirmed bugs -
// toolChangeQIndexes.clear() silently wipes detection of any LATER M6 in
// the same job, and send1Q()'s own gate (the thing holding the main job)
// ALSO holds the wizard's own gcode hostage forever (a permanent deadlock,
// not just a slowdown). This trio never touches gcodeQueue/queuePointer/
// sentBuffer/toolChangeQIndexes, and vice versa - see sendToolChangeWizardQ()
// and the "ok" routing in the port's data handler.
var toolChangeWizardQueue = [];
var toolChangeWizardPointer = 0;
var toolChangeWizardSentBuffer = [];
var queuePointer = 0;
var statusLoop;
var frontEndUpdateLoop, sysinfoUpdateLoop

var queueCounter;
var listPortsLoop;

var GRBL_RX_BUFFER_SIZE = 127; // 128 characters
var GRBLHAL_RX_BUFFER_SIZE = 1023; // 128 characters
var sentBuffer = [];

var xPos = 0.00;
var yPos = 0.00;
var zPos = 0.00;
var aPos = 0.00;
var xOffset = 0.00;
var yOffset = 0.00;
var zOffset = 0.00;
var aOffset = 0.00;


var feedOverride = 100,
  spindleOverride = 100;


//regex to identify MD5hash on sdupload later
var re = new RegExp("^[a-f0-9]{32}");

var status = {
  login: false,
  driver: {
    version: require('./package').version,
    ipaddress: ip.address(),
    webPort: config.webPort, // P3: exposed so LAN-facing pages (Jog from Phone widget) don't hardcode the port
    operatingsystem: false,
    powersettings: {
      usbselectiveAC: null,
      usbselectiveDC: null
    },
  },
  machine: {
    name: '',
    has4thAxis: false,
    inputs: [],
    overrides: {
      feedOverride: 100, //
      spindleOverride: 100, //
      realFeed: 0, //
      realSpindle: 0 //
    },
    //
    tool: {
      nexttool: {
        number: 0,
        line: ""
      }
    },
    modals: {
      //motionmode: "G0", // G0, G1, G2, G3, G38.2, G38.3, G38.4, G38.5, G80
      coordinatesys: "G54", // G54, G55, G56, G57, G58, G59
      plane: "G17", // G17, G18, G19
      distancemode: "G90", // G90, G91
      arcdistmode: "G91.1", // G91.1
      feedratemode: "G94", // G93, G94
      unitsmode: "G21", // G20, G21
      radiuscomp: "G40", // G40
      tlomode: "G49", // G43.1, G49
      // programmode: "M0", // M0, M1, M2, M30
      spindlestate: "M5", // M3, M4, M5
      coolantstate: "M9", // M7, M8, M9
      homedRecently: false
      // tool: "0",
      // spindle: "0",
      // feedrate: "0"
    },
    probe: {
      x: 0.00,
      y: 0.00,
      z: 0.00,
      state: -1
    },
    position: {
      work: {
        x: 0,
        y: 0,
        z: 0,
        a: 0,
        e: 0
      },
      offset: {
        x: 0,
        y: 0,
        z: 0,
        a: 0,
        e: 0
      }

    },
    firmware: {
      type: "",
      platform: "",
      version: "",
      date: "",
      buffer: [],
      features: [],
      blockBufferSize: 0,
      rxBufferSize: 0,
    },
  },
  comms: {
    connectionStatus: 0, //0 = not connected, 1 = opening, 2 = connected, 3 = playing, 4 = paused, 5 = alarm, 6 = firmware upgrade
    runStatus: "Pending", // 0 = init, 1 = idle, 2 = alarm, 3 = stop, 4 = run, etc?
    queue: 0,
    blocked: false,
    paused: false,
    // P10: a tool-change (M6) line was reached and skipped - separate from
    // "paused" on purpose (see pause()'s guard below): only the wizard's own
    // "Continue" (the "resumeToolChange" socket handler) may clear this one.
    awaitingToolChange: false,
    controllerBuffer: 0, // Seems like you are tracking available buffer?  Maybe nice to have in frontend?
    interfaces: {
      type: "",
      ports: "",
      networkDevices: [],
      activePort: "" // or activeIP in the case of wifi/telnet?
    },
    alarm: ""
  },
  interface: {
    diskdrive: false,
      firmware: {
        availVersion: "",
        installedVersion: "",
      },
      connected: false
  }
};

// P9: server-side "Recover Job" persistence (see jobRecovery.js for the why).
// The callbacks read live sender state lazily, so it doesn't matter that
// gcodeQueue/queuePointer/sentBuffer are declared above/below this line.
const jobRecovery = require('./jobRecovery').createJobRecovery({
  getDir: getUserDataDir,
  log: serialLog,
  // Queue index of the oldest line the controller has NOT yet acknowledged:
  // lines sent minus lines still awaiting their "ok" (sentBuffer holds exactly
  // those, in order - send1Q is the only non-realtime sender). "sent" is not
  // "acknowledged": counting sent lines would skip work still in the buffer.
  // -1 means the queue was dumped (alarm reset etc.) and nothing meaningful
  // can be read from it any more.
  getFirstUnackedQ: function() {
    if (gcodeQueue.length === 0) return -1;
    return Math.max(0, queuePointer - sentBuffer.length);
  },
  getPlannerBlocks: function() {
    return parseInt(status.machine.firmware.blockBufferSize) || 0;
  }
});

async function findPorts() {
  const ports = await SerialPort.list()
  // console.log(ports)
  status.comms.interfaces.ports = ports;
  for (i = 0; i < status.comms.interfaces.ports.length; i++) {
    var data = friendlyPort(status.comms.interfaces.ports[i])
    status.comms.interfaces.ports[i].img = data.img;
    status.comms.interfaces.ports[i].note = data.note;
  }
}
findPorts()

// async function findDisks() {
//   const drives = await drivelist.list();
//   status.interface.diskdrives = drives;
// } // removed in 1.0.350 due to Drivelist stability issues

var PortCheckinterval = setInterval(function() {
  if (status.comms.connectionStatus == 0) {
    findPorts();
  }
  //findDisks(); // removed in 1.0.350 due to Drivelist stability issues
}, 1000);

// var telnetCheckinterval = setInterval(function() {
//   if (status.comms.connectionStatus == 0) {
//     scanForTelnetDevices();
//   }
// }, 30000);
// scanForTelnetDevices();

checkPowerSettings()

// JSON API
app.get('/api/version', (req, res) => {
  data = {
    "application": "OMD",
    "version": require('./package').version,
    "ipaddress": ip.address() + ":" + config.webPort
  }
  res.send(JSON.stringify(data), null, 2);
})

app.get('/activate', (req, res) => {
  debug_log(req.hostname)
  res.send('Host: ' + req.hostname + ' asked to activate Urban Creator CONTROL v' + require('./package').version);
  showJogWindow()
  setTimeout(function() {
    io.sockets.emit('activate', req.hostname);
  }, 500);
})

// Upload
app.get('/upload', (req, res) => {
  res.sendFile(__dirname + '/app/upload.html');
})

app.get('/gcode', (req, res) => {
  if (uploadedgcode.indexOf('$') != 0) { // Ignore grblSettings jobs
    res.send(uploadedgcode);
  }
})

app.get('/workspace', (req, res) => {
  res.send(uploadedworkspace);
})

// http-post version of runJob


app.post('/runjob', (req, res) => {
  // 'firmwareBin' is the name of our file input field in the HTML form
  let upload = multer({
    storage: storage
  }).single('file');

  upload(req, res, function(err) {
    // req.file contains information of uploaded file
    // req.body contains information of text fields, if there were any
    if (err instanceof multer.MulterError) {
      return res.send(err);
    } else if (err) {
      return res.send(err);
    }
    // P9: the uploaded blob is always named "upload.gcode" (see runJobFile()
    // in app/js/main.js), so the real file name travels in a separate form
    // field. Untrusted text: jobRecovery sanitises it on write and read, and
    // the renderer escapes it on display.
    var recoveryFileName = (req.body && typeof req.body.fileName === 'string') ? req.body.fileName : '';
    // "Start From Line": the client sends the opening lines of the file plus the
    // lines from the chosen one on, and says how far its line numbers are from the
    // original file's, so the recorded resume line stays in ORIGINAL file lines.
    var recoveryLineOffset = (req.body && typeof req.body.lineOffset === 'string' && /^\d{1,9}$/.test(req.body.lineOffset)) ? parseInt(req.body.lineOffset, 10) : 0;
    // P10 Tahap 1b-i: the client's chosen M6 handling for this run. Not
    // trusted blindly - runJob() re-validates it with its own allow-list
    // (anything other than exactly "ignore" becomes "pause", the safe
    // default), same as this route already does for fileName/lineOffset.
    var recoveryToolChangeMode = (req.body && req.body.toolChangeMode === 'ignore') ? 'ignore' : 'pause';
    fs.readFile(req.file.path, 'utf8', function(err, data) {
      if (err) {
        return console.log(err);
      }
      var object = {
        isJob: true,
        //completedMsg: "",
        data: data,
        fileName: recoveryFileName,
        lineOffset: recoveryLineOffset,
        toolChangeMode: recoveryToolChangeMode,
      }
      runJob(object)
    });
    res.send(`Running ` + req.file.path);

  });
});


// File Post
app.post('/upload', function(req, res) {
  //debug_log(req)
  uploadprogress = 0
  var form = new formidable.IncomingForm();
  form.maxFileSize = 300 * 1024 * 1024;
  form.parse(req, function(err, fields, files) {
    // debug_log(files);
  });

  form.on('fileBegin', function(name, file) {
    debug_log(JSON.stringify(name));
    debug_log(JSON.stringify(file));
    debug_log('Uploading ' + file.filepath);
  });

  form.on('progress', function(bytesReceived, bytesExpected) {
    uploadprogress = parseInt(((bytesReceived * 100) / bytesExpected).toFixed(0));
    if (uploadprogress != lastsentuploadprogress) {
      lastsentuploadprogress = uploadprogress;
    }
    debug_log('Progress ' + uploadprogress + "% / " + bytesReceived + "b");

  });

  form.on('file', function(name, file) {
    debug_log('Uploaded ' + file.filepath);
    showJogWindow()
    readFile(file.filepath)
  });

  form.on('aborted', function() {
    // Emitted when the request was aborted by the user. Right now this can be due to a 'timeout' or 'close' event on the socket. After this event is emitted, an error event will follow. In the future there will be a separate 'timeout' event (needs a change in the node core).
  });

  form.on('end', function() {
    //Emitted when the entire request has been received, and all contained files have finished flushing to disk. This is a great place for you to send your response.
    res.end();

  });

  res.sendFile(__dirname + '/app/upload.html');
});

app.on('certificate-error', function(event, webContents, url, error,
  certificate, callback) {
  event.preventDefault();
  callback(true);
});

// Native file dialogs. Since Electron 43 a dialog without a defaultPath opens in the Downloads folder
// instead of where it was last used. So each kind of dialog ("gcode": Open GCODE, "interface": the
// Interface USB drive) starts in the folder the user picked last time - remembered across restarts in
// userData/dialog-dirs.json - and in Documents when there is none (or it no longer exists).
var dialogDirs = null;

function dialogDirsFile() {
  return path.join(electronApp.getPath('userData'), 'dialog-dirs.json');
}

function loadDialogDirs() {
  if (dialogDirs) return dialogDirs;
  dialogDirs = {};
  try {
    var saved = JSON.parse(fs.readFileSync(dialogDirsFile(), 'utf8'));
    if (saved && typeof saved === 'object') {
      Object.keys(saved).forEach(function(kind) {
        if (typeof saved[kind] === 'string') dialogDirs[kind] = saved[kind];
      });
    }
  } catch (e) {
    // no file yet, or unreadable: start from Documents
  }
  return dialogDirs;
}

function dialogStartDir(kind) {
  var dir = loadDialogDirs()[kind];
  try {
    if (dir && fs.statSync(dir).isDirectory()) return dir;
  } catch (e) {
    // the folder is gone (removed drive, deleted folder)
  }
  return electronApp.getPath('documents');
}

function rememberDialogDir(kind, dir) {
  if (typeof dir !== 'string' || dir === '') return;
  loadDialogDirs()[kind] = dir;
  try {
    fs.writeFileSync(dialogDirsFile(), JSON.stringify(dialogDirs));
  } catch (e) {
    serialLog('warn', 'Could not remember the last dialog folder: ' + e.message);
  }
}

io.on("connection", function(socket) {

  debug_log("New IO Connection ");

  io.sockets.emit("sysinfo", systemInformation);

  iosocket = socket;

  if (status.machine.firmware.type == 'grbl') {
    debug_log("Is Grbl");
    debug_log("Emit Grbl: 1");
    io.sockets.emit('grbl', status.machine.firmware)
  }

  // Global Update loop
  clearInterval(frontEndUpdateLoop);
  frontEndUpdateLoop = setInterval(function() {
    io.sockets.emit("status", status);
  }, 100);

  clearInterval(sysinfoUpdateLoop);
  sysinfoUpdateLoop = setInterval(function() {
    io.sockets.emit("sysinfo", systemInformation);
  }, 1000 * 60);

  // P9: an unfinished job left over from an earlier run (crash, USB pulled,
  // app closed mid-job, or a Stop) is offered to this newly-connected client.
  // Skipped while a job is actually being tracked - a renderer reload or a
  // phone connecting mid-job must not be told the LIVE job "needs recovery".
  // The client decides whether to show it (the LAN Jog-from-Phone page won't).
  if (!jobRecovery.isTracking()) {
    var pendingRecovery = jobRecovery.peek();
    if (pendingRecovery) {
      socket.emit("recoveryOffer", pendingRecovery);
    }
  }

  // On-demand read for the "Recover Job" ribbon button: always current, so the
  // client never holds a stale copy. Answered through the socket.io ack.
  socket.on("getRecoveryInfo", function(ack) {
    if (typeof ack !== 'function') return;
    ack(jobRecovery.isTracking() ? null : jobRecovery.peek());
  });

  // The user explicitly declined to recover: forget it. Never while a job is
  // running - that record belongs to the live job, not to a leftover.
  socket.on("discardRecovery", function() {
    if (!jobRecovery.isTracking()) {
      jobRecovery.clear('discarded by user');
    }
  });

  socket.on("scannetwork", function(data) {
    scanForTelnetDevices(data)
  })

  socket.on("openFile", function(data) {
    dialog.showOpenDialog(jogWindow, {
      properties: ['openFile'],
      defaultPath: dialogStartDir('gcode')
    }).then(result => {
      console.log(result.canceled)
      console.log(result.filePaths)
      var openFilePath = result.filePaths[0];
      if (!result.canceled && openFilePath) rememberDialogDir('gcode', path.dirname(openFilePath));
      if (openFilePath !== "") {
        debug_log("path" + openFilePath);
        readFile(openFilePath);
      }

    }).catch(err => {
      console.log(err)
    })
  })

  socket.on("openInterfaceDir", function(data) {
    dialog.showOpenDialog(jogWindow, {
      properties: ['openDirectory'],
      title: "Select the USB Flashdrive you want to use with Interface",
      defaultPath: dialogStartDir('interface')
    }).then(result => {
      console.log(result.canceled)
      console.log(result.filePaths)
      if (!result.canceled && result.filePaths[0]) rememberDialogDir('interface', result.filePaths[0]);
      io.sockets.emit("interfaceDrive", result.filePaths[0]);
      status.interface.diskdrive = result.filePaths[0]
    }).catch(err => {
      console.log(err)
    })
  })

  socket.on("openbuilds", function(data) {
    const {
      shell
    } = require('electron')
    shell.openExternal('https://urbancreator.id')
  });

  socket.on("openbuildspartstore", function(data) {
    const {
      shell
    } = require('electron')
    shell.openExternal('https://www.openbuildspartstore.com')
  });

  socket.on("carveco", function(data) {
    const {
      shell
    } = require('electron')
    shell.openExternal('https://carveco.com/carveco-software-range/?ref=openbuilds')
  });

  socket.on("fabber", function(data) {
    const {
      shell
    } = require('electron')
    shell.openExternal('https://www.getfabber.com/openbuilds?ref=OpenBuilds')
  });

  socket.on("lightburn", function(data) {
    const {
      shell
    } = require('electron')
    shell.openExternal('https://openbuildspartstore.com/lightburn/')
  });

  socket.on("vectric", function(data) {
    const {
      shell
    } = require('electron')
    shell.openExternal('https://openbuildspartstore.com/vectric/')
  });

  socket.on("opencam", function(data) {
    const {
      shell
    } = require('electron')
    shell.openExternal('https://cam.openbuilds.com')
  });

  socket.on("opendocs", function(data) {
    const {
      shell
    } = require('electron')
    shell.openExternal('https://urbancreator.id')
  });

  socket.on("openforum", function(data) {
    const {
      shell
    } = require('electron')
    shell.openExternal('https://forum.urbancreator.id')
  });

  socket.on("gpuinfo", function(data) {
    // GPU
    var gpuInfoWindow = new BrowserWindow({
      // 1366 * 768 == minimum to cater for
      width: 800,
      height: 800,
      fullscreen: false,
      center: true,
      resizable: true,
      maximizable: true,
      title: APP_DISPLAY_NAME + ": Chromium's GPU Report",
      frame: true,
      autoHideMenuBar: true,
      //icon: '/app/favicon.png',
      icon: nativeImage.createFromPath(
        path.join(__dirname, "/app/favicon.png")
      ),
      webgl: true,
      experimentalFeatures: true,
      experimentalCanvasFeatures: true,
      offscreen: true,
      backgroundColor: "#fff"
    });
    gpuInfoWindow.loadURL("chrome://gpu");

    gpuInfoWindow.once('ready-to-show', () => {
      gpuInfoWindow.show()
      gpuInfoWindow.setAlwaysOnTop(true);
      gpuInfoWindow.focus();
      gpuInfoWindow.setAlwaysOnTop(false);
    })
  });

  // P8: the custom "X" button in the HTML titlebar (app/index.html) used to
  // just hide to tray - now quits the app for real, via the same validated
  // cleanup path as the tray Quit menu / Cmd+Q (closes the serial port and
  // backend server before exiting). See also jogWindow.on('close', ...)
  // below, which now does the same for Alt+F4/taskbar-Close.
  socket.on("minimisetotray", function(data) {
    quitAndCleanup(0);
  });

  socket.on("minimize", function(data) {
    jogWindow.minimize();
  });

  socket.on("maximize", function(data) {
    if (jogWindow.isFullScreen()) {
      jogWindow.setFullScreen(false);
    }
    if (jogWindow.isMaximized()) {
      jogWindow.unmaximize();
    } else {
      jogWindow.maximize();
    }
  });

  socket.on("fullscreen", function(data) {
    if (jogWindow.isFullScreen()) {
      jogWindow.setFullScreen(false);
    } else {
      jogWindow.setFullScreen(true);
    }
  });

  socket.on("quit", function(data) {
    quitAndCleanup(0);
  });

  socket.on("applyUpdate", function(data) {
    autoUpdater.quitAndInstall();
  })

  socket.on("downloadUpdate", function(data) {
    if (!updateIsDownloading) {
      if (typeof autoUpdater !== 'undefined') {
        autoUpdater.checkForUpdates();
      } else {
        debug_log("autoUpdater not found")
      }
    }
  })

  socket.on("flashGrbl", function(data) {

    var port = data.port;
    var firmwareImagePath = data.file;
    var customImg = data.customImg
    console.log(__dirname, file, data.file)
    if (customImg) {
      var firmwarePath = data.file
    } else {
      var firmwarePath = path.join(__dirname, data.file)
    }

    console.log("-------------------------------------------")
    console.log(firmwarePath)
    console.log("-------------------------------------------")

    if (status.comms.connectionStatus > 0) {
      debug_log('WARN: Closing Port ' + port);
      stopPort();
    } else {
      debug_log('ERROR: Machine connection not open!');
    }

    function flashGrblCallback(debugString, port) {
      debug_log(port, debugString);
      var data = {
        'port': port,
        'string': debugString
      }
      io.sockets.emit("progStatus", data);
    }

    // setTimeout(function() {
    //   var avrgirl = new Avrgirl({
    //     board: board,
    //     port: port,
    //     debug: function(debugString) {
    //       var port = this.connection.options.port;
    //       flashGrblCallback(debugString, port)
    //     }
    //   });
    //
    //   debug_log(JSON.stringify(avrgirl));
    //
    //   status.comms.connectionStatus = 6;
    //   avrgirl.flash(firmwarePath, function(error) {
    //     if (error) {
    //       console.error(error);
    //       io.sockets.emit("progStatus", 'Flashing FAILED!');
    //       status.comms.connectionStatus = 0;
    //     } else {
    //       console.info('done.');
    //       io.sockets.emit("progStatus", 'Programmed Succesfully');
    //       io.sockets.emit("progStatus", 'Please Reconnect');
    //       status.comms.connectionStatus = 0;
    //     }
    //     status.comms.connectionStatus = 0;
    //   });
    // }, 1000)
  })

  socket.on("flashGrblHal", function(data) {
    if (status.comms.connectionStatus > 0) {
      debug_log('WARN: Closing Port ' + port);
      stopPort();
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
    console.log(JSON.stringify(data), null, 4);
    flashGrblHal(data)
  })

  socket.on("flashInterface", function(data) {
    if (status.comms.connectionStatus > 0) {
      debug_log('WARN: Closing Port ' + port);
      stopPort();
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
    flashInterface(data)
  })

  socket.on("flashBLOX", function(data) {
    if (status.comms.connectionStatus > 0) {
      debug_log('WARN: Closing Port ' + port);
      stopPort();
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
    flashBLOX(data)
  })

  socket.on("writeInterfaceUsbDrive", function(data) {

    debug_log(data)
    //data.controller = type of controller
    if (data.controller == "blackbox4x" || data.controller == "genericgrbl") {
      var probesrc = path.join(__dirname, './app/wizards/interface/PROBE/');
      var profilesrc = path.join(__dirname, './app/wizards/interface/PROFILESGRBL/');
    } else if (data.controller == "blackboxx32" || data.controller == "genericgrblhal") {
      var probesrc = path.join(__dirname, './app/wizards/interface/PROBE/');
      var profilesrc = path.join(__dirname, './app/wizards/interface/PROFILESHAL/');
    }

    // P9: data.drive used to be taken straight from the client and fed into
    // path.join() + ncp + fs.mkdir({recursive:true}) + fs.writeFile, so any
    // socket client could have this handler create folders and write files
    // anywhere the app has permission - e.g. the Windows Startup folder, for
    // persistence, plus the user's WiFi PSK in plaintext wherever it liked.
    //
    // The client was never the source of truth for this path anyway: the
    // wizard asks the SERVER to open a native directory picker
    // (socket.on("openInterfaceDir") above), and the server stores what the
    // user picked in status.interface.diskdrive. copyFilesToUsb() in
    // app/wizards/interface/usbprep.js then just echoes that same value back.
    // So use the server's own record and ignore the echo entirely - there is
    // no path string from the client left to validate or sanitise.
    var drive = status.interface.diskdrive;

    if (!drive || typeof drive !== 'string') {
      serialLog('warn', 'writeInterfaceUsbDrive rejected: no USB drive has been picked via the native dialog yet');
      io.sockets.emit('data', {
        'command': 'Interface USB Drive',
        'response': 'No USB drive selected. Click "Select USB Flashdrive" and choose the drive first.',
        'type': 'error'
      });
      return;
    }

    // The drive may have been unplugged between picking it and pressing the
    // button - fail with a clear message instead of silently recreating the
    // directory tree somewhere stale.
    try {
      if (!fs.existsSync(drive) || !fs.statSync(drive).isDirectory()) {
        throw new Error('not a directory');
      }
    } catch (e) {
      serialLog('warn', 'writeInterfaceUsbDrive rejected: selected drive is not available (' + drive + ')');
      io.sockets.emit('data', {
        'command': 'Interface USB Drive',
        'response': 'Selected drive ' + drive + ' is no longer available. Re-select the USB flashdrive and try again.',
        'type': 'error'
      });
      return;
    }

    var probedest = path.join(drive, "/PROBE/");
    var profiledest = path.join(drive, "/PROFILES/");

    var ncp = require('ncp').ncp;
    ncp.limit = 16;

    var output = {
      'command': 'Interface USB Drive',
      'response': "Starting to copy data to " + drive,
      'type': 'info'
    }
    io.sockets.emit('data', output);

    var errorCount = 0;

    if (data.ssid && data.psk) {


      const folderPath = path.join(drive, "CONFIG");

      // Create the subfolder if it doesn't exist and then write the file
      fs.mkdir(folderPath, {
        recursive: true
      }, (err) => {
        if (err) {
          var output = {
            'command': 'Interface USB Drive',
            'response': `Failed to create folder ${folderPath}! Error: ${err}`,
            'type': 'error'
          };
          io.sockets.emit('data', output);
        } else {
          var fileContent = `${data.ssid}\n${data.psk}`;

          fs.writeFile(path.join(folderPath, "wifi.cfg"), fileContent, (err) => {
            if (err) {
              errorCount++;
              var output = {
                'command': 'Interface USB Drive',
                'response': `Failed to create Wifi Configuration file in ${folderPath}! Error: ${err}`,
                'type': 'error'
              };
              io.sockets.emit('data', output);
            } else {
              var output = {
                'command': 'Interface USB Drive',
                'response': `Created Wifi Configuration file in ${folderPath} successfully!`,
                'type': 'success'
              };
              io.sockets.emit('data', output);
            }
          });
        }
      });

    }

    ncp(probesrc, probedest, function(err) {
      if (err) {
        var output = {
          'command': 'Interface USB Drive',
          'response': "Failed to copy PROBE macros to " + probedest + ":  " + JSON.stringify(err),
          'type': 'error'
        }
        io.sockets.emit('data', output);
        errorCount++
      } else {
        var output = {
          'command': 'Interface USB Drive',
          'response': "Copied PROBE macros to " + probedest + " succesfully!",
          'type': 'success'
        }
        io.sockets.emit('data', output);
      }
    });


    ncp(profilesrc, profiledest, function(err) {
      if (err) {
        var output = {
          'command': 'Interface USB Drive',
          'response': "Failed to copy MACHINE PROFILES to " + profiledest + ":  " + JSON.stringify(err),
          'type': 'error'
        }
        io.sockets.emit('data', output);
        errorCount++
      } else {
        var output = {
          'command': 'Interface USB Drive',
          'response': "Copied MACHINE PROFILES to " + profiledest + " succesfully!",
          'type': 'success'
        }
        io.sockets.emit('data', output);
      }
    });



    setTimeout(function() {
      if (errorCount == 0) {
        var output = {
          'command': 'Interface USB Drive',
          'response': "Finished copying supporting files to Drive " + drive,
          'type': 'success'
        }
        io.sockets.emit('data', output);
        var output = {
          'command': 'Interface USB Drive',
          'response': "Please Eject the drive (Safely Remove) and insert it into your Interface's USB port",
          'type': 'info'
        }
        io.sockets.emit('data', output);
      }
    }, 500);
  });

  socket.on("connectTo", function(data) { // If a user picks a port to connect to, open a Node SerialPort Instance to it

    if (status.comms.connectionStatus < 1) {

      if (data.type == "usb") {
        console.log("connect", "Connecting to " + data.port + " via " + data.type);
        serialLog('info', 'Opening USB serial port ' + data.port + ' at baud ' + data.baud);


        var allowRtsCts = false
        var allowHupcl = false
        if (process.platform == 'darwin') {
          allowRtsCts = true // Fix for autoreset getting stuck on MacOS with Silabs Chip
          allowHupcl = true // Fix for autoreset getting stuck on MacOS with Silabs Chip
        }

        port = new SerialPort({
          path: data.port,
          baudRate: parseInt(data.baud),
          rtscts: allowRtsCts,
          hupcl: allowHupcl // Don't set DTR - useful for X32 Reset
        });
      } else if (data.type == "telnet") {
        console.log("connect", "Connecting to " + data.ip + " via " + data.type);
        port = net.connect(23, data.ip);
        port.isOpen = true;
      }

      const parser = port.pipe(new ReadlineParser({
        delimiter: '\r\n'
      }))


      // port.on("data", function(data) {
      //   console.log(data)
      // })

      port.on("error", function(err) {
        if (err.message != "Port is not open") {
          debug_log("Error: ", err.message);
          serialLog('error', 'Port error on ' + (data.port || data.ip) + ': ' + err.message);
          var output = {
            'command': '',
            'response': "PORT ERROR: " + err.message,
            'type': 'error'
          }
          io.sockets.emit('data', output);

          if (status.comms.connectionStatus > 0) {
            debug_log('WARN: Closing Port ' + port.path);
            status.comms.connectionStatus = 0;
            stopPort();
          } else {
            debug_log('ERROR: Machine connection not open!');
          }
        } else {
          serialLog('warn', 'Port error suppressed ("Port is not open") on ' + (data.port || data.ip));
        }

      });


      port.on("ready", function(e) {
        portOpened(port, data)
      });

      port.on("open", function(e) {
        serialLog('info', 'Port ' + (port.path || data.port) + ' opened (native "open" event)');
        portOpened(port, data)
      });

      port.on("close", function() { // open errors will be emitted as an error event
        debug_log("PORT INFO: Port closed");
        serialLog('info', 'Port ' + (data.port || data.ip) + ' closed (native "close" event)');
        var output = {
          'command': 'disconnect',
          'response': "PORT INFO: Port closed",
          'type': 'info'
        }
        io.sockets.emit('data', output);
        status.comms.connectionStatus = 0;
        stopPort() // also clear queues etc
      }); // end port.onclose


      function portOpened(port, data) {
        // setup listeners first

        parser.on("data", function(data) {
          //console.log(data)
          var command = sentBuffer[0];

          if (command == "$CD" && data != "ok") {
            fluidncConfig = fluidncConfig += data + "\n"
          }

          if (data.indexOf("<") != 0) {
            debug_log('data:', data)
          }

          // Grbl $I parser
          if (data.indexOf("[VER:") === 0) {
            // Extracting the full version (1.1f)
            const version = data.split(':')[1].split('.')[0] + '.' + data.split(':')[1].split('.')[1];
            // Extracting the date (20240402)
            const date = data.split(':')[1].split('.')[2];

            status.machine.firmware.version = version;
            status.machine.firmware.date = date;

            io.sockets.emit("status", status);

            status.machine.name = data.split(':')[2].split(']')[0].toLowerCase()
            io.sockets.emit("machinename", data.split(':')[2].split(']')[0].toLowerCase());
          }

          if (data.indexOf("[OPT:") === 0) {

            var startOpt = data.search(/opt:/i) + 4;
            var grblOpt;
            if (startOpt > 4) {
              var grblOptLen = data.substr(startOpt).search(/]/);
              grblOpts = data.substr(startOpt, grblOptLen).split(/,/);

              status.machine.firmware.blockBufferSize = grblOpts[1];
              status.machine.firmware.rxBufferSize = grblOpts[2];

              var features = []

              var i = grblOpts[0].length;
              while (i--) {
                features.push(grblOpts[0].charAt(i))
                switch (grblOpts[0].charAt(i)) {
                  case 'Q':
                    debug_log('SPINDLE_IS_SERVO Enabled')
                    //
                    break;
                  case 'V': //	Variable spindle enabled
                    debug_log('Variable spindle enabled')
                    //
                    break;
                  case 'N': //	Line numbers enabled
                    debug_log('Line numbers enabled')
                    //
                    break;
                  case 'M': //	Mist coolant enabled
                    debug_log('Mist coolant enabled')
                    //
                    break;
                  case 'C': //	CoreXY enabled
                    debug_log('CoreXY enabled')
                    //
                    break;
                  case 'P': //	Parking motion enabled
                    debug_log('Parking motion enabled')
                    //
                    break;
                  case 'Z': //	Homing force origin enabled
                    debug_log('Homing force origin enabled')
                    //
                    break;
                  case 'H': //	Homing single axis enabled
                    debug_log('Homing single axis enabled')
                    //
                    break;
                  case 'T': //	Two limit switches on axis enabled
                    debug_log('Two limit switches on axis enabled')
                    //
                    break;
                  case 'A': //	Allow feed rate overrides in probe cycles
                    debug_log('Allow feed rate overrides in probe cycles')
                    //
                    break;
                  case '$': //	Restore EEPROM $ settings disabled
                    debug_log('Restore EEPROM $ settings disabled')
                    //
                    break;
                  case '#': //	Restore EEPROM parameter data disabled
                    debug_log('Restore EEPROM parameter data disabled')
                    //
                    break;
                  case 'I': //	Build info write user string disabled
                    debug_log('Build info write user string disabled')
                    //
                    break;
                  case 'E': //	Force sync upon EEPROM write disabled
                    debug_log('Force sync upon EEPROM write disabled')
                    //
                    break;
                  case 'W': //	Force sync upon work coordinate offset change disabled
                    debug_log('Force sync upon work coordinate offset change disabled')
                    //
                    break;
                  case 'L': //	Homing init lock sets Grbl into an alarm state upon power up
                    debug_log('Homing init lock sets Grbl into an alarm state upon power up')
                    //
                    break;
                }
              }
              status.machine.firmware.features = features;
              io.sockets.emit("features", features);
            }
          }

          // [PRB:0.000,0.000,0.000:0]
          //if (data.indexOf("[PRB:") === 0 && command != "$#" && command != undefined) {
          if (data.indexOf("[PRB:") === 0) {
            debug_log(data)
            var prbLen = data.substr(5).search(/\]/);
            var prbData = data.substr(5, prbLen).split(/,/);
            var success = data.split(':')[2].split(']')[0];
            status.machine.probe.x = prbData[0];
            status.machine.probe.y = prbData[1];
            status.machine.probe.z = prbData[2].split(':')[0];
            status.machine.probe.state = success;
            if (success > 0) {
              var output = {
                'command': '[ PROBE ]',
                'response': "Probe Completed.",
                'type': 'success'
              }
              io.sockets.emit('data', output);
            } else {
              var output = {
                'command': '[ PROBE ]',
                'response': "Probe move ERROR - probe did not make contact within specified distance",
                'type': 'error'
              }
              io.sockets.emit('data', output);
            }
            io.sockets.emit('prbResult', status.machine.probe);
          };

          if (data.indexOf("[GC:") === 0) {
            gotModals(data)
          }

          if (data.indexOf("[INTF:") === 0) {
            var output = {
              'command': 'connect',
              'response': "Detected an OpenBuilds Interface on port " + port.path,
              'type': 'success'
            }
            io.sockets.emit('data', output);
            status.interface.connected = true;
            if (data.split(":")[1].indexOf("ver") == 0) {
              var installedVersion = parseFloat(data.split(":")[1].split("]")[0].split("-")[1])
              status.interface.firmware.installedVersion = installedVersion
              var output = {
                'command': 'connect',
                'response': "OpenBuilds Interface Firmware Version: v" + installedVersion,
                'type': 'info'
              }
              io.sockets.emit('data', output);
              if (installedVersion < status.interface.firmware.availVersion) {
                var output = {
                  'command': 'connect',
                  'response': "OpenBuilds Interface Firmware OUTDATED: v" + installedVersion + " can be upgraded to v" + status.interface.firmware.availVersion,
                  'type': 'error'
                }
                io.sockets.emit('data', output);
                io.sockets.emit('interfaceOutdated', status);
              }
            }
            io.sockets.emit("status", status);
          }

          // Machine Identification
          if (data.indexOf("Grbl") === 0 || data.indexOf("[FIRMWARE:grblHAL]") === 0) { // Check if it's Grbl
            debug_log(data)
            status.comms.blocked = false;
            if (data.indexOf("GrblHAL") === 0) {
              status.machine.firmware.type = "grbl";
              status.machine.firmware.platform = "grblHAL"
              status.machine.firmware.version = data.substr(8, 4); // get version
            } else if (data.indexOf("[FIRMWARE:grblHAL]") === 0) {
              status.machine.firmware.type = "grbl";
              status.machine.firmware.platform = "grblHAL"
              // Parse version from seperate [VER:...] line not here for this response
            } else if (data.indexOf("FluidNC") != -1) { // Grbl 3.6 [FluidNC v3.6.5 (wifi) '$' for help]
              status.machine.firmware.type = "grbl";
              status.machine.firmware.platform = "FluidNC"
              status.machine.firmware.version = data.substr(19, 5); // get version
            } else {
              status.machine.firmware.type = "grbl";
              status.machine.firmware.platform = "gnea"
              status.machine.firmware.version = data.substr(5, 4); // get version
            }
            if (parseFloat(status.machine.firmware.version) < 1.1) { // If version is too old
              if (status.machine.firmware.version.length < 3) {
                debug_log('invalid version string, stay connected')
              } else {
                if (status.comms.connectionStatus > 0) {
                  debug_log('WARN: Closing Port ' + port.path + " /  v" + parseFloat(status.machine.firmware.version));
                  // stopPort();
                } else {
                  debug_log('ERROR: Machine connection not open!');
                }
                var output = {
                  'command': command,
                  'response': "Detected an unsupported version: Grbl " + status.machine.firmware.version + ". This is sadly outdated. Please upgrade to Grbl 1.1 or newer to use this software.  Go to http://github.com/gnea/grbl",
                  'type': 'error'
                }
                io.sockets.emit('data', output);
              }
            }
            // debug_log("GRBL detected");
            // setTimeout(function() {
            //   io.sockets.emit('grbl', status.machine.firmware)
            //   //v1.0.318 - commented out as a test - too many normal alarms clear prematurely
            //   //io.sockets.emit('errorsCleared', true);
            // }, 600)
            // // Start interval for status queries
            // clearInterval(statusLoop);
            // statusLoop = setInterval(function() {
            //   if (status.comms.connectionStatus > 0) {
            //     addQRealtime("?");
            //   }
            // }, 200);
            status.machine.modals.homedRecently = false;
          } else if (data.indexOf("LPC176") >= 0) { // LPC1768 or LPC1769 should be Smoothieware
            status.comms.blocked = false;
            debug_log("Smoothieware detected");
            status.machine.firmware.type = "smoothie";
            status.machine.firmware.version = data.substr(data.search(/version:/i) + 9).split(/,/);
            status.machine.firmware.date = new Date(data.substr(data.search(/Build date:/i) + 12).split(/,/)).toDateString();
            // Start interval for status queries
            // statusLoop = setInterval(function() {
            //   if (status.comms.connectionStatus > 0) {
            //     addQRealtime("?");
            //   }
            // }, 200);
            var output = {
              'command': "FIRMWARE ERROR",
              'response': "Detected an unsupported version: Smoothieware " + status.machine.firmware.version + ". This software no longer support Smoothieware. \nLuckilly there is an alternative firmware you can install on your controller to make it work with this software. Check out Grbl-LPC at https://github.com/cprezzi/grbl-LPC - Grbl-LPC is a Grbl port for controllers using the NXP LPC176x chips, for example Smoothieboards",
              'type': 'error'
            }
            io.sockets.emit('data', output);
            stopPort();
          } // end of machine identification

          // Machine Feedback: Position
          if (data.indexOf("<") === 0) {
            // debug_log(' Got statusReport (Grbl & Smoothieware)')
            // statusfeedback func
            parseFeedback(data)
            if (command == "?") {
              var output = {
                'command': command,
                'response': data,
                'type': 'info'
              }
              // debug_log(output.response)
              io.sockets.emit('data', output);
            }

            // debug_log(data)
          } else if (data.indexOf("ok") === 0) { // Got an OK so we are clear to send
            io.sockets.emit('ok', command); // added per #325
            // debug_log("OK FOUND")
            command = routeOkAndAdvance(command);
          } else if (data.indexOf('ALARM') === 0) { //} || data.indexOf('HALTED') === 0) {
            debug_log("ALARM:  " + data)
            status.comms.connectionStatus = 5;
            switch (status.machine.firmware.type) {
              case 'grbl':
                // sentBuffer.shift();
                var alarmCode = parseInt(data.split(':')[1]);
                debug_log('ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode));
                status.comms.alarm = alarmCode + ' - ' + grblStrings.alarms(alarmCode)
                if (alarmCode != 5) {
                  io.sockets.emit("toastErrorAlarm", 'ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode) + " [ " + command + " ]")
                }
                var output = {
                  'command': '',
                  'response': 'ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode) + " [ " + command + " ]",
                  'type': 'error'
                }
                io.sockets.emit('data', output);
                break;
            }
            status.comms.connectionStatus = 5;
          } else if (data.indexOf('WARNING: After HALT you should HOME as position is currently unknown') != -1) { //} || data.indexOf('HALTED') === 0) {
            status.comms.connectionStatus = 2;
          } else if (data.indexOf('Emergency Stop Requested') != -1) { //} || data.indexOf('HALTED') === 0) {
            debug_log("Emergency Stop Requested")
            status.comms.connectionStatus = 5;
          } else if (data.indexOf('wait') === 0) { // Got wait from Repetier -> ignore
            // do nothing
          } else if (data.indexOf('error') === 0) { // Error received -> stay blocked stops queue
            switch (status.machine.firmware.type) {
              case 'grbl':
                // sentBuffer.shift();
                var errorCode = parseInt(data.split(':')[1]);

                var lastAlarm = "";
                if (errorCode == 9 && status.comms.connectionStatus == 5 && status.comms.alarm.length > 0) {
                  lastAlarm = "<hr>This error may just be a symptom of an earlier event:<br> ALARM: " + status.comms.alarm
                }
                debug_log('error: ' + errorCode + ' - ' + grblStrings.errors(errorCode) + " [ " + command + " ]");
                var output = {
                  'command': '',
                  'response': 'error: ' + errorCode + ' - ' + grblStrings.errors(errorCode) + " [ " + command + " ]" + lastAlarm,
                  'type': 'error'
                }
                io.sockets.emit('data', output);
                io.sockets.emit("toastError", 'error: ' + errorCode + ' - ' + grblStrings.errors(errorCode) + " [ " + command + " ]" + lastAlarm)
                break;
            }
            debug_log("error;")
            sentBuffer.shift();
            status.comms.connectionStatus = 5;
          } else if (data === ' ') {
            // nothing
          } else {
            // do nothing with +data
          }

          if (data.indexOf("[MSG:Reset to continue]") === 0) {
            switch (status.machine.firmware.type) {
              case 'grbl':
                debug_log("[MSG:Reset to continue] -> Sending Reset")
                addQRealtime(String.fromCharCode(0x18)); // ctrl-x
                break;
            }
          }


          if (command) {
            command = command.replace(/(\r\n|\n|\r)/gm, "");
            // debug_log("CMD: " + command + " / DATA RECV: " + data.replace(/(\r\n|\n|\r)/gm, ""));

            if (command != "?" && command != "M105" && data.length > 0 && data.indexOf('<') == -1) {
              var string = "";
              if (status.comms.sduploading) {
                string += "SD: "
              }
              string += data //+ "  [ " + command + " ]"
              var output = {
                'command': command,
                'response': string,
                'type': 'info'
              }
              // debug_log(output.response)
              io.sockets.emit('data', output);
            }
          } else {
            if (data.indexOf("<") != 0) {
              var output = {
                'command': "",
                'response': data,
                'type': 'info'
              }
              io.sockets.emit('data', output);
            }
          }
        }); // end of parser.on(data)

        // Then try to connect
        // set status
        status.comms.connectionStatus = 1;

        // Log attempt 1
        debug_log("PORT INFO: Connected to " + port.path + " at " + port.baudRate);
        var output = {
          'command': 'connect',
          'response': "PORT INFO: Port is now open: " + port.path + " - Attempting to detect Controller...",
          'type': 'info'
        }
        console.log(port, friendlyPort(port));
        io.sockets.emit('data', output);
        // do attempt 1
        addQRealtime("\n"); // this causes smoothie and grblHAL to send the welcome string

        // log attempt 2
        var output = {
          'command': 'connect',
          'response': "Attempting to detect Controller (1): (Autoreset)",
          'type': 'info'
        }
        io.sockets.emit('data', output);

        // do attempt 2 after 1 second
        setTimeout(function() { //wait for controller to be ready
          if (status.machine.firmware.type.length < 1) {
            debug_log("Didnt detect firmware after AutoReset. Lets see if we have Grbl instance with a board that doesnt have AutoReset");
            var output = {
              'command': 'connect',
              'response': "Attempting to detect Controller (2): (Ctrl+X)",
              'type': 'info'
            }
            io.sockets.emit('data', output);
            addQRealtime(String.fromCharCode(0x18)); // ctrl-x (needed for rx/tx connection)
            debug_log("Sent: Ctrl+x");
          }
        }, config.grblWaitTime * 1000);

        //do attempt 3 after 2 seconds Smoothie and soft-usb
        setTimeout(function() { //wait for controller to be ready
          if (status.machine.firmware.type.length < 1) {
            debug_log("No firmware yet, probably not Grbl then. lets see if we have Smoothie?");
            var output = {
              'command': 'connect',
              'response': "Attempting to detect Controller (3): (others)",
              'type': 'info'
            }
            io.sockets.emit('data', output);
            addQRealtime("version\n"); // Check if it's Smoothieware?
            debug_log("Sent: version");
          }
        }, config.grblWaitTime * 2000);


        // Not smoothie, maybe DTR
        setTimeout(function() { //wait for controller to be ready
          if (status.machine.firmware.type.length < 1) {
            debug_log("Didnt detect firmware after AutoReset or Ctrl+X. Lets try toggling DTR");
            var output = {
              'command': 'connect',
              'response': "Attempting to detect Controller (4): (DTR Enable)",
              'type': 'info'
            }
            io.sockets.emit('data', output);

            // toggle DTR on
            port.set({
              "dtr": true
            }, console.log("Set DTR"));

            // then try Ctrl+X again
            setTimeout(function() {

              setTimeout(function() {
                addQRealtime(String.fromCharCode(0x18)); // ctrl-x (needed for rx/tx connection)
              }, 100);

              addQRealtime(String.fromCharCode(0x18)); // ctrl-x (needed for rx/tx connection)
              debug_log("Sent: Ctrl+x after DTR toggle");

              // port.set({
              //   "dtr": false
              // }, console.log("Set DTR"));
            }, 100);
          }

          // port.set({ // toggle Off again else grbl on Uno gets stuck
          //   "dtr": false
          // }, console.log("Set DTR"));
        }, config.grblWaitTime * 3000);


        setTimeout(function() {
          // Close port if we don't detect supported firmware after 2s.
          if (status.machine.firmware.type.length < 1) {
            debug_log("No supported firmware detected. Closing port " + port.path);
            if (status.interface.connected) {
              var output = {
                'command': 'connect',
                'response': `ERROR!:  Connection established to INTERFACE, but no response from Grbl on the upstream controller. Check that the controller is powered on and properly connected to the Interface. Closing port ` + port.path,
                'type': 'error'
              }
            } else {
              var output = {
                'command': 'connect',
                'response': `ERROR!:  No Response from Controller. Check that it is powered on, the USB cable is connected, and the correct port is selected. Closing port ` + port.path,
                'type': 'error'
              }
            }
            io.sockets.emit('data', output);
            stopPort();
          } else {

            if (status.machine.firmware.type === "grbl") {
              debug_log("GRBL detected");
              var output = {
                'command': 'connect',
                'response': "Detecting Firmware: Detected Grbl Succesfully",
                'type': 'info'
              }

              setTimeout(function() {
                io.sockets.emit('grbl', status.machine.firmware)
                //v1.0.318 - commented out as a test - too many normal alarms clear prematurely
                //io.sockets.emit('errorsCleared', true);
              }, 100)
              // Start interval for status queries
              clearInterval(statusLoop);
              statusLoop = setInterval(function() {
                if (status.comms.connectionStatus > 0) {
                  addQRealtime("?");
                }
              }, 200);
              status.machine.modals.homedRecently = false;
            }

            if (data.type == "usb") {
              var output = {
                'command': 'connect',
                'response': "Firmware Detected:  " + status.machine.firmware.platform + " version " + status.machine.firmware.version + " dated " + status.machine.firmware.date + " on " + port.path,
                'type': 'success'
              }
            } else if (data.type = "telnet") {
              var output = {
                'command': 'connect',
                'response': "Firmware Detected:  " + status.machine.firmware.platform + " version " + status.machine.firmware.version + " dated " + status.machine.firmware.date + " on " + data.ip,
                'type': 'success'
              }
            }
            io.sockets.emit('data', output);
          }
        }, config.grblWaitTime * 4000);



        status.comms.connectionStatus = 2;
        if (data.type == "usb") {
          status.comms.interfaces.activePort = port.path;
          status.comms.interfaces.type = data.type
          status.comms.interfaces.activeBaud = port.baudRate;
        } else if (data.type = "telnet") {
          status.comms.interfaces.activePort = data.ip;
          status.comms.interfaces.type = data.type
          status.comms.interfaces.activeBaud = "net";
        }
      }


    }
  });

  socket.on('saveToSd', function(datapack) {
    saveToSd(datapack);
  });


  socket.on('setqueuePointer', function(data) {
    debug_log('Setting queuePointer to ' + data)
    queuePointer = data
  });

  socket.on('runJob', function(object) {
    // debug_log(data)
    runJob(object);
  });

  socket.on('forceQueue', function(data) {
    send1Q();
  });

  socket.on('serialInject', function(data) {
    // Inject a live command into Serial stream in real-time (dev tool) even while a job is running, etc (straight Port.write from machineSend)
    machineSend(data, true);
  });

  socket.on("dump", function(data) {
    console.log(queuePointer);
    console.log(gcodeQueue);
    console.log(sentBuffer);
  })

  socket.on('runCommand', function(data) {
    debug_log('Run Command (' + data.replace('\n', '|') + ')');
    if (status.comms.connectionStatus > 0) {
      if (data) {
        data = data.split('\n');
        for (var i = 0; i < data.length; i++) {
          var line = data[i].split(';'); // Remove everything after ; = comment
          var tosend = line[0].trim();
          if (tosend.length > 0) {
            addQToEnd(tosend);
          }
        }
        status.comms.runStatus = 'Running'
        // debug_log('sending ' + JSON.stringify(gcodeQueue))
        send1Q();
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('jog', function(data) {
    debug_log('Jog ' + data);
    if (status.comms.connectionStatus > 0) {
      data = data.split(',');
      var dir = data[0];
      var dist = parseFloat(data[1]);
      var feed;
      if (data.length > 2) {
        feed = parseInt(data[2]);
        if (feed) {
          feed = 'F' + feed;
        }
      }
      if (dir && dist && feed) {
        debug_log('Adding jog commands to queue. Firmw=' + status.machine.firmware.type + ', blocked=' + status.comms.blocked + ', paused=' + status.comms.paused + ', Q=' + gcodeQueue.length);
        switch (status.machine.firmware.type) {
          case 'grbl':
            addQToEnd('$J=G91G21' + dir + dist + feed);
            send1Q();
            break;
          default:
            debug_log('ERROR: Unknown firmware!');
            break;
        }
      } else {
        debug_log('ERROR: Invalid params!');
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('jogXY', function(data) {
    debug_log('Jog XY' + data);
    if (status.comms.connectionStatus > 0) {
      // var data = {
      //   x: xincrement,
      //   y: yincrement,
      //   feed: feed
      // }
      var xincrement = parseFloat(data.x);
      var yincrement = parseFloat(data.y);
      var feed = parseFloat(data.feed)
      if (feed) {
        feed = 'F' + feed;
      }

      if (xincrement && yincrement && feed) {
        debug_log('Adding jog commands to queue. blocked=' + status.comms.blocked + ', paused=' + status.comms.paused + ', Q=' + gcodeQueue.length);
        switch (status.machine.firmware.type) {
          case 'grbl':
            addQToEnd('$J=G91G21X' + xincrement + " Y" + yincrement + " " + feed);
            send1Q();
            break;
          default:
            debug_log('ERROR: Unknown firmware!');
            break;
        }
      } else {
        debug_log('ERROR: Invalid params!');
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('jogTo', function(data) { // data = {x:xVal, y:yVal, z:zVal, mode:0(absulute)|1(relative), feed:fVal}
    debug_log('JogTo ' + JSON.stringify(data));
    if (status.comms.connectionStatus > 0) {
      if (data.x !== undefined || data.y !== undefined || data.z !== undefined) {
        var xVal = (data.x !== undefined ? 'X' + parseFloat(data.x) : '');
        var yVal = (data.y !== undefined ? 'Y' + parseFloat(data.y) : '');
        var zVal = (data.z !== undefined ? 'Z' + parseFloat(data.z) : '');
        var mode = ((data.mode == 0) ? 0 : 1);
        var feed = (data.feed !== undefined ? 'F' + parseInt(data.feed) : '');
        debug_log('Adding jog commands to queue. blocked=' + status.comms.blocked + ', paused=' + status.comms.paused + ', Q=' + gcodeQueue.length);
        switch (status.machine.firmware.type) {
          case 'grbl':
            addQToEnd('$J=G91G21' + mode + xVal + yVal + zVal + feed);
            break;
          default:
            debug_log('ERROR: Unknown firmware!');
            break;
        }
      } else {
        debug_log('error Invalid params!');
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('setZero', function(data) {
    debug_log('setZero(' + data + ')');
    if (status.comms.connectionStatus > 0) {
      switch (data) {
        case 'x':
          addQToEnd('G10 L20 P0 X0');
          break;
        case 'y':
          addQToEnd('G10 L20 P0 Y0');
          break;
        case 'z':
          addQToEnd('G10 L20 P0 Z0');
          break;
        case 'a':
          addQToEnd('G10 L20 P0 A0');
          break;
        case 'all':
          addQToEnd('G10 L20 P0 X0 Y0 Z0');
          break;
        case 'xyza':
          addQToEnd('G10 L20 P0 X0 Y0 Z0 A0');
          break;
      }
      send1Q();
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('gotoZero', function(data) {
    debug_log('gotoZero(' + data + ')');
    if (status.comms.connectionStatus > 0) {
      switch (data) {
        case 'x':
          addQToEnd('G0 X0');
          break;
        case 'y':
          addQToEnd('G0 Y0');
          break;
        case 'z':
          addQToEnd('G0 Z0');
          break;
        case 'a':
          addQToEnd('G0 A0');
          break;
        case 'all':
          addQToEnd('G0 X0 Y0 Z0');
          break;
        case 'xyza':
          addQToEnd('G0 X0 Y0 Z0 A0');
          break;
      }
      send1Q();
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('setPosition', function(data) {
    debug_log('setPosition(' + JSON.stringify(data) + ')');
    if (status.comms.connectionStatus > 0) {
      if (data.x !== undefined || data.y !== undefined || data.z !== undefined) {
        var xVal = (data.x !== undefined ? 'X' + parseFloat(data.x) + ' ' : '');
        var yVal = (data.y !== undefined ? 'Y' + parseFloat(data.y) + ' ' : '');
        var zVal = (data.z !== undefined ? 'Z' + parseFloat(data.z) + ' ' : '');
        var aVal = (data.a !== undefined ? 'A' + parseFloat(data.a) + ' ' : '');
        addQToEnd('G10 L20 P0 ' + xVal + yVal + zVal + aVal);
        send1Q();
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('probe', function(data) {
    debug_log('probe(' + JSON.stringify(data) + ')');
    if (status.comms.connectionStatus > 0) {
      switch (status.machine.firmware.type) {
        case 'grbl':
          addQToEnd('G38.2 ' + data.direction + '-5 F1');
          addQToEnd('G92 ' + data.direction + ' ' + data.probeOffset);
          send1Q();
          break;
        default:
          //not supported
          debug_log('Command not supported by firmware!');
          break;
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('feedOverride', function(data) {
    debug_log(data)
    if (status.comms.connectionStatus > 0) {
      switch (status.machine.firmware.type) {
        case 'grbl':
          debug_log("current FRO = " + status.machine.overrides.feedOverride)
          debug_log("requested FRO = " + data)
          var curfro = parseInt(status.machine.overrides.feedOverride)
          var reqfro = parseInt(data)
          var delta;

          if (reqfro == 100) {
            addQRealtime(String.fromCharCode(0x90));
          } else if (curfro < reqfro) {
            // FRO Increase
            delta = reqfro - curfro
            debug_log("delta = " + delta)
            var tens = Math.floor(delta / 10)

            debug_log("need to send " + tens + " x10s increase")
            // for (i = 0; i < tens; i++) {
            //   addQRealtime(String.fromCharCode(0x91));
            // }
            for (let i = 1; i < tens + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(0x91));
                addQRealtime("?");
              }, i * 50);
            }

            var ones = delta - (10 * tens);
            debug_log("need to send " + ones + " x1s increase")
            // for (i = 0; i < ones; i++) {
            //   addQRealtime(String.fromCharCode(0x93));
            // }
            for (let i = 1; i < ones + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(0x93));
                addQRealtime("?");
              }, i * 50);
            }
          } else if (curfro > reqfro) {
            // FRO Decrease
            delta = curfro - reqfro
            debug_log("delta = " + delta)

            var tens = Math.floor(delta / 10)
            debug_log("need to send " + tens + " x10s decrease")
            // for (i = 0; i < tens; i++) {
            //   addQRealtime(String.fromCharCode(0x92));
            // }
            for (let i = 1; i < tens + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(0x92));
                addQRealtime("?");
              }, i * 50);
            }

            var ones = delta - (10 * tens);
            debug_log("need to send " + ones + " x1s decrease")
            // for (i = 0; i < tens; i++) {
            //   addQRealtime(String.fromCharCode(0x94));
            // }
            for (let i = 1; i < ones + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(0x94));
                addQRealtime("?");
              }, i * 50);
            }
          }
          addQRealtime("?");
          status.machine.overrides.feedOverride = parseInt(reqfro); // Set now, but will be overriden from feedback from Grbl itself in next queryloop
          break;
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('spindleOverride', function(data) {
    if (status.comms.connectionStatus > 0) {
      switch (status.machine.firmware.type) {
        case 'grbl':
          debug_log("current SRO = " + status.machine.overrides.spindleOverride)
          debug_log("requested SRO = " + data)
          var cursro = parseInt(status.machine.overrides.spindleOverride)
          var reqsro = parseInt(data)
          var delta;

          if (reqsro == 100) {
            addQRealtime(String.fromCharCode(153));
          } else if (cursro < reqsro) {
            // FRO Increase
            delta = reqsro - cursro
            debug_log("delta = " + delta)
            var tens = Math.floor(delta / 10)

            debug_log("need to send " + tens + " x10s increase")
            // for (i = 0; i < tens; i++) {
            //   addQRealtime(String.fromCharCode(154));
            // }
            for (let i = 1; i < tens + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(154));
                addQRealtime("?");
              }, i * 50);
            }

            var ones = delta - (10 * tens);
            debug_log("need to send " + ones + " x1s increase")
            // for (i = 0; i < ones; i++) {
            //   addQRealtime(String.fromCharCode(156));
            // }
            for (let i = 1; i < ones + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(156));
                addQRealtime("?");
              }, i * 50);
            }
          } else if (cursro > reqsro) {
            // FRO Decrease
            delta = cursro - reqsro
            debug_log("delta = " + delta)

            var tens = Math.floor(delta / 10)
            debug_log("need to send " + tens + " x10s decrease")
            // for (i = 0; i < tens; i++) {
            //   addQRealtime(String.fromCharCode(155));
            // }
            for (let i = 1; i < tens + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(155));
                addQRealtime("?");
              }, i * 50);
            }

            var ones = delta - (10 * tens);
            debug_log("need to send " + ones + " x1s decrease")
            // for (i = 0; i < tens; i++) {
            //   addQRealtime(String.fromCharCode(157));
            // }
            for (let i = 1; i < ones + 1; i++) {
              setTimeout(function timer() {
                addQRealtime(String.fromCharCode(157));
                addQRealtime("?");
              }, i * 50);
            }
          }
          addQRealtime("?");
          status.machine.overrides.spindleOverride = parseInt(reqsro); // Set now, but will be overriden from feedback from Grbl itself in next queryloop
          break;
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('laserTest', function(data) { // Laser Test Fire
    laserTest(data);
  });

  socket.on('pause', function() {
    pause();
  });

  socket.on('resume', function() {
    unpause();
  });

  // P10: the ONLY thing that may clear awaitingToolChange - see pause()'s
  // guard, which refuses to touch it, and send1Q()'s gate, which the manual
  // Resume above cannot get past on its own (see Commit 2/4's tests).
  socket.on('resumeToolChange', function() {
    if (!status.comms.awaitingToolChange) return; // stray/duplicate click
    status.comms.awaitingToolChange = false;
    pendingToolChange = null;
    send1Q();
  });

  socket.on('stop', function(data) {
    stop(data);
  });

  socket.on('clearAlarm', function(data) { // Clear Alarm
    if (status.comms.connectionStatus > 0) {
      data = parseInt(data);
      debug_log('Clearing Queue: Method ' + data);
      switch (data) {
        case 1:
          debug_log('Clearing Lockout');
          switch (status.machine.firmware.type) {
            case 'grbl':
              addQRealtime('$X\n');
              debug_log('Sent: $X');
              break;
          }
          debug_log('Resuming Queue Lockout');
          var output = {
            'command': '[clear alarm]',
            'response': "Operator clicked Clear Alarm: Cleared Lockout",
            'type': 'info'
          }
          io.sockets.emit('data', output);
          break;
        case 2:
          debug_log('Emptying Queue');
          announceJobStopped('alarm-reset'); // before the dump below
          // P9: the dump below kills the job. Freeze its recovery record first (like
          // stop() and stopPort()) - otherwise the next "ok" on the emptied queue
          // looks like "every line sent" and, once the controller is Idle, the
          // record is wiped as "completed".
          jobRecovery.finish('interrupted');
          status.comms.queue = 0
          queuePointer = 0;
          gcodeQueue.length = 0; // Dump the queue
          sentBuffer.length = 0; // Dump bufferSizes
          queuePointer = 0;
          // Same as stop(): a dumped queue means a dead job - drop its start
          // time and completion message so the next command's "ok" doesn't emit
          // a jobComplete with them.
          jobStartTime = false;
          jobCompletedMsg = "";
          // P10: same reasoning - a tool-change wait belongs to a queue that
          // no longer exists after this dump (see
          // test/reconnect-stale-state.test.js's structural check).
          status.comms.awaitingToolChange = false;
          pendingToolChange = null;
          toolChangeWizardEmitted = false;
          toolChangeQIndexes.clear();
          toolChangeWizardQueue.length = 0;
          toolChangeWizardPointer = 0;
          toolChangeWizardSentBuffer.length = 0;
          debug_log('Clearing Lockout');
          switch (status.machine.firmware.type) {
            case 'grbl':
              clearInterval(queueCounter);
              if (jogWindow) {
                jogWindow.setProgressBar(0);
              }
              addQRealtime(String.fromCharCode(0x18)); // ctrl-x
              setTimeout(function() {
                addQRealtime('$X\n');
                debug_log('Sent: $X');
              }, 500);
              status.comms.blocked = false;
              status.comms.paused = false;
              break;
          }
          var output = {
            'command': '[clear alarm]',
            'response': "Operator clicked Clear Alarm: Cleared Lockout and Emptied Queue",
            'type': 'info'
          }
          io.sockets.emit('data', output);
          break;
      }
      status.comms.runStatus = 'Stopped'
      status.comms.connectionStatus = 2;
      status.comms.alarm = "";
      io.sockets.emit('errorsCleared', true);
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('resetMachine', function() {
    if (status.comms.connectionStatus > 0) {
      debug_log('Reset Machine');
      switch (status.machine.firmware.type) {
        case 'grbl':
          addQRealtime(String.fromCharCode(0x18)); // ctrl-x
          debug_log('Sent: Code(0x18)');
          break;
      }
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });

  socket.on('closePort', function(data) { // Close machine port and dump queue
    if (status.comms.connectionStatus > 0) {
      debug_log('WARN: Closing Port ' + port.path);
      stopPort();
    } else {
      debug_log('ERROR: Machine connection not open!');
    }
  });




});

function readFile(filePath) {
  if (filePath) {
    if (filePath.length > 1) {
      var filename = path.parse(filePath)
      filename = filename.name + filename.ext
      debug_log('readfile: ' + filePath)
      fs.readFile(filePath, 'utf8',
        function(err, data) {
          if (err) {
            debug_log(err);
            var output = {
              'command': '',
              'response': "ERROR: File Upload Failed"
            }
            uploadedgcode = "";
          }
          if (data) {
            if (filePath.endsWith('.obc')) { // OpenBuildsCAM Workspace
              uploadedworkspace = data;
              const {
                shell
              } = require('electron')
              shell.openExternal('https://cam.openbuilds.com')
            } else { // GCODE
              var payload = {
                gcode: data,
                filename: filename
              }
              io.sockets.emit('gcodeupload', payload);
              uploadedgcode = data;
              return data
            }
          }
        });
    }
  }
}

function machineSend(gcode, realtime) {
  debug_log("SENDING: " + gcode)
  if (port.isOpen) {
    if (realtime) {
      // realtime commands doesnt count toward the queue, does not generate OK
      port.write(gcode);
    } else {
      if (gcode.match(/T([\d.]+)/i)) {
        var tool = parseFloat(RegExp.$1);
        status.machine.tool.nexttool.number = tool
        status.machine.tool.nexttool.line = gcode
      }
      var queueLeft = parseInt((gcodeQueue.length - queuePointer))
      var queueTotal = parseInt(gcodeQueue.length)
      // debug_log("Q: " + queueLeft)
      var data = []
      data.push(queueLeft);
      data.push(queueTotal);
      // Third element: the line of the ORIGINAL FILE just sent (queuePointer was already
      // advanced, so it is queue index queuePointer-1), via the same mapping as the recovery
      // record. The queue index alone is not a file line (blank/comment lines are dropped,
      // "$G" entries are added, "Start from Line" sends a slice). Left out for jobs that
      // are not tracked (probing, console commands): the client then falls back.
      var sourceLine = (queuePointer >= 1 && queuePointer <= gcodeQueue.length) ? jobRecovery.sourceLineAt(queuePointer - 1) : null;
      if (sourceLine !== null) data.push(sourceLine);
      io.sockets.emit("queueCount", data);
      // debug_log(gcode)
      port.write(gcode);
      debug_log("SENT: " + gcode)
    }
  } else {
    debug_log("PORT NOT OPEN")
  }
}

// P10: does this (already comment-stripped-by-";") source line contain a tool
// change command? Matches M6, M06, M006 - NOT M60/M600/M16 etc (negative
// lookahead on a following digit). Bracket comments "(...)" are stripped here
// too (the caller does not strip them - grbl's own parser ignores them, so
// nothing upstream needs to), so "(switch to M6 next)" is not mistaken for one.
function isToolChangeLine(line) {
  var stripped = String(line).replace(/\([^)]*\)/g, '');
  return /M0*6(?!\d)/i.test(stripped);
}

// The tool number on a tool-change line, e.g. "T2 M6" -> "2". null if none.
function toolChangeToolNumber(line) {
  var stripped = String(line).replace(/\([^)]*\)/g, '');
  var m = stripped.match(/T(-?[\d.]+)/i);
  return m ? m[1] : null;
}

function runJob(object) {

  // object = {
  //   isJob: true,
  //   completedMsg: "",
  //   data: "",
  // }

  jobStartTime = false;
  var data = object.data

  if (object.isJob) {
    if (data.length < 20000) {
      uploadedgcode = data;
    }
    jobStartTime = new Date().getTime();
  }

  if (object.completedMsg) {
    jobCompletedMsg = object.completedMsg
  }


  // debug_log('Run Job (' + data.length + ')');
  if (status.comms.connectionStatus > 0) {
    if (data) {
      data = data.split('\n');
      // P9: only real jobs are tracked for recovery - not probing routines,
      // bounding-box moves or console commands (isJob:false).
      var trackRecovery = (object.isJob === true);
      var recoveryMarks = [];
      // P10: leftover marks from whatever job last populated this belong to a
      // queue that is long gone by the time a new runJob() legitimately starts
      // (every place that dumps gcodeQueue clears this too - see
      // test/reconnect-stale-state.test.js) - cleared again here regardless,
      // since a non-tracked run (trackRecovery false) never repopulates it.
      toolChangeQIndexes.clear();
      // P10 Tahap 1b-i: only a tracked job may choose the mode - a probing
      // routine or console command (isJob:false) leaves whatever the last
      // tracked job set untouched (there is nothing of its own to set it to).
      if (trackRecovery) {
        toolChangeMode = (object.toolChangeMode === 'ignore') ? 'ignore' : 'pause';
      }
      for (var i = 0; i < data.length; i++) {

        var line = data[i].replace("%", "").split(';'); // Remove everything after ; = comment
        var tosend = line[0].trim();
        if (tosend.length > 0) {
          // P9: remember which SOURCE line this queue entry came from. Blank
          // and comment-only lines are dropped above and addQToEnd() injects
          // extra "$G" entries, so queue index != editor line. Recording the
          // queue length just before the push (rather than re-deriving
          // addQToEnd's rules) keeps this correct however that function's
          // insertion rules change.
          if (trackRecovery) {
            recoveryMarks.push({
              q: gcodeQueue.length,
              line: i + 1
            });
            // P10: only tracked jobs get tool-change interception - a probing
            // routine or console command with a stray M6 in it is not one.
            if (isToolChangeLine(tosend)) {
              toolChangeQIndexes.set(gcodeQueue.length, {
                line: i + 1,
                tool: toolChangeToolNumber(tosend)
              });
            }
          }
          addQToEnd(tosend);
        }
      }
      if (i > 0) {
        if (trackRecovery) {
          jobRecovery.begin({
            fileName: object.fileName,
            lineOffset: object.lineOffset, // set by callers that send a slice of the editor
            lineCount: data.length,
            marks: recoveryMarks
          });
        }
        // Start interval for qCount messages to socket clients
        queueCounter = setInterval(function() {
          status.comms.queue = gcodeQueue.length - queuePointer
          if (jogWindow) {
            jogWindow.setProgressBar(queuePointer / gcodeQueue.length)
          }
        }, 500);
        send1Q(); // send first line
        status.comms.connectionStatus = 3;
      }

    }
  } else {
    debug_log('ERROR: Machine connection not open!');
  }
}

// Tell the clients that a job which had started streaming was cut short (Stop
// button, USB pulled, alarm reset), so the renderer can record it in the job
// history as an INCOMPLETE run with the real start and stop times.
//
// This is deliberately its own event, not a variant of "jobComplete": the
// stale-state bug produced a jobComplete{failed:true} carrying an old
// jobStartTime, which is indistinguishable in shape from a legitimate stopped
// job. Keeping the two on separate channels means the "jobComplete" handler can
// refuse to write history for anything failed, and this event can only ever be
// produced right here, at the moment a real job dies.
//
// A job is "real and in progress" only if runJob(isJob) stamped jobStartTime
// AND lines are still queued: jobStartTime is cleared when the last line is
// sent (send1Q) and by every queue dump, and a lone console command never sets
// it. MUST be called before the caller resets jobStartTime / dumps the queue.
function announceJobStopped(reason) {
  if (jobStartTime && gcodeQueue.length > 0) {
    io.sockets.emit('jobStopped', {
      completed: false,
      reason: reason, // 'stopped' | 'interrupted' | 'alarm-reset'
      jobStartTime: jobStartTime,
      jobEndTime: new Date().getTime()
    });
  }
}

function stopPort() {
  // P9: every way the connection goes away mid-job funnels through here (USB
  // pulled -> port "close"/"error", the Disconnect button, firmware flashing).
  // Snapshot BEFORE the queue is wiped a few lines down. No-op if no tracked
  // job is running.
  jobRecovery.finish('interrupted');
  announceJobStopped('interrupted');
  clearInterval(queueCounter);
  clearInterval(statusLoop);
  if (jogWindow) {
    jogWindow.setProgressBar(0);
  }
  status.comms.interfaces.activePort = false;
  status.comms.interfaces.activeBaud = false;
  status.comms.connectionStatus = 0;
  status.machine.firmware.type = "";
  status.machine.firmware.version = ""; // get version
  status.machine.firmware.date = "";
  status.machine.firmware.buffer = "";
  gcodeQueue.length = 0;
  sentBuffer.length = 0; // dump bufferSizes
  // The queue is gone, so the job-scoped state that goes with it must go too.
  // queuePointer used to be left at its old value: after a USB pull mid-job
  // the first command sent on reconnect saw "length 1 - pointer 151 < 0", was
  // silently NOT written to the port, and tripped the "job complete" branch of
  // send1Q with the old jobStartTime (bogus "JOB COMPLETE" log + junk job
  // history entry). A NEW job started before any other command would have
  // begun at line 152 instead of line 1. Every place that dumps the queue
  // (this, stop(), clearAlarm method 2, send1Q's completion) must reset the
  // same three variables - test/reconnect-stale-state.test.js enforces it.
  queuePointer = 0;
  jobStartTime = false;
  jobCompletedMsg = "";
  // P10: same reasoning - a tool-change wait belongs to a queue that no
  // longer exists after this dump.
  status.comms.awaitingToolChange = false;
  pendingToolChange = null;
  toolChangeWizardEmitted = false;
  toolChangeQIndexes.clear();
  toolChangeWizardQueue.length = 0;
  toolChangeWizardPointer = 0;
  toolChangeWizardSentBuffer.length = 0;

  if (typeof port === 'undefined' || !port) {
    return; // never connected - nothing to close
  }

  if (status.comms.interfaces.type == "usb") {
    if (port.isOpen) {
      var closingPath = port.path;
      serialLog('info', 'stopPort: draining then closing ' + closingPath);
      // Drain BEFORE close (not the other way around) so buffered writes reach
      // the controller instead of being cut off mid-transmission - closing a
      // USB-serial port (CH340/FTDI/CP210x) while writes are still in flight
      // is a likely contributor to the driver leaving the COM port "stuck".
      port.drain(function(drainErr) {
        if (drainErr) {
          serialLog('warn', 'Drain before close reported an error on ' + closingPath + ': ' + drainErr.message);
        }
        if (port && port.isOpen) {
          port.close(function(closeErr) {
            if (closeErr) {
              serialLog('error', 'Failed to close ' + closingPath + ': ' + closeErr.message);
            } else {
              serialLog('info', 'Closed ' + closingPath);
            }
          });
        }
      });
    } else {
      serialLog('info', 'stopPort: USB port already closed, nothing to do');
    }
  } else if (status.comms.interfaces.type == "telnet") {
    if (port.isOpen) {
      serialLog('info', 'stopPort: destroying telnet connection');
      port.destroy();
      port.isOpen = false;
    }
  }
}

// --- Graceful shutdown (P1) --------------------------------------------------
// Every quit path in this app (Quit tray menu, Cmd+Q, dock Quit, closing the
// last window, will-quit) used to call electronApp.exit(0) directly, which
// terminates the process immediately without ever calling port.close(). This
// is the most likely cause of COM ports being left "stuck": if the serial
// port was open, its handle was only ever released by raw OS process
// teardown instead of a clean close() handshake with the USB-serial driver
// (CH340/FTDI/CP210x/etc). All quit call sites now route through here.
var isQuitting = false;

// Firmware flashing (flashBLOX/flashInterface/flashGrblHal) spawns an
// esptool child process that opens the COM port itself, entirely outside
// node's `port`/serialport handle. If the app quit/crashed mid-flash with
// nothing tracking that child, it survives as an orphan holding the port
// long after the main app is gone - invisible unless you go looking for
// "esptool.exe" in Task Manager. Track every such child so quit can reap it.
var activeChildProcesses = [];

function trackChildProcess(child, label) {
  if (!child) return;
  activeChildProcesses.push({
    child: child,
    label: label
  });
  child.on('exit', function() {
    activeChildProcesses = activeChildProcesses.filter(function(entry) {
      return entry.child !== child;
    });
  });
}

function killActiveChildProcesses() {
  if (activeChildProcesses.length === 0) return;
  activeChildProcesses.forEach(function(entry) {
    serialLog('warn', 'Terminating child process still running at quit: ' + entry.label + ' (pid ' + entry.child.pid + ')');
    try {
      entry.child.kill();
    } catch (e) {
      serialLog('error', 'Failed to terminate child process ' + entry.label + ': ' + e.message);
    }
  });
  io.sockets.emit('data', {
    'command': '',
    'response': 'Application is closing - an in-progress firmware flash was interrupted.',
    'type': 'error'
  });
  activeChildProcesses = [];
}

// P3: close the local HTTP/HTTPS/Socket.IO backend on quit too. TCP listen
// sockets don't get "stuck" like a COM port does (the OS always reclaims them
// on process exit, even a hard crash) - this is here for consistency with the
// P1/P2 cleanup pattern and so a lingering long-poll/websocket connection
// can't keep anything open past when we intend to exit. Bounded by the same
// kind of safety timeout as the serial port close, for the same reason.
function closeBackendServers(callback) {
  var done = false;

  function finish(reason) {
    if (done) return;
    done = true;
    serialLog('info', 'Backend servers closed (' + reason + ')');
    callback();
  }

  serialLog('info', 'Closing local HTTP/HTTPS/Socket.IO servers');

  try {
    io.close();
  } catch (e) {
    serialLog('warn', 'io.close() error on quit: ' + e.message);
  }

  var pending = 0;
  var safetyTimer = setTimeout(function() {
    finish('timeout after 1s - continuing quit anyway');
  }, 1000);

  function onServerClosed() {
    pending--;
    if (pending <= 0) {
      clearTimeout(safetyTimer);
      finish('all closed');
    }
  }

  [httpserver, httpsserver].forEach(function(server) {
    if (!server) return;
    pending++;
    try {
      server.close(onServerClosed);
    } catch (e) {
      serialLog('warn', 'Error closing a backend server on quit: ' + e.message);
      onServerClosed();
    }
  });

  if (pending === 0) {
    clearTimeout(safetyTimer);
    finish('nothing to close');
  }
}

// P9: is the machine in a state where yanking the serial port would leave it
// moving/cutting with nothing left to stop it? connectionStatus is the
// authoritative one (see the status object: 3 = playing, 4 = paused mid-job,
// 6 = firmware flash - interrupting a flash can brick the controller, which
// is if anything a worse moment to quit than mid-cut). runStatus and a
// non-drained queue are belt-and-braces: any one of them saying "busy" is
// enough, since the cost of a needless prompt is far lower than the cost of
// dropping comms mid-move.
function isMachineBusy() {
  try {
    if ([3, 4, 6].indexOf(status.comms.connectionStatus) !== -1) return true;
    if (/^(Run|Hold|Jog|Door|Running|Paused|Resuming)/i.test(String(status.comms.runStatus || ''))) return true;
    if (typeof gcodeQueue !== 'undefined' && gcodeQueue.length > queuePointer) return true;
  } catch (e) {}
  return false;
}

// P9: bring the machine to a controlled stop before the port disappears -
// feed hold, then soft reset, then a moment for those bytes to actually
// leave the buffer. Same sequence (and same realtime primitives) stop()
// already uses, deliberately reused rather than reinvented. Always calls
// back exactly once, and is hard-capped so a wedged write can never hang
// the quit: the whole point of this path is that the app still exits.
function stopMachineBeforeQuit(done) {
  var settled = false;

  function finish(reason) {
    if (settled) return;
    settled = true;
    if (reason) serialLog('info', 'Machine stop before quit: ' + reason);
    done();
  }

  if (!(status.comms.connectionStatus > 0)) {
    return finish('no machine connected - nothing to stop');
  }

  setTimeout(function() {
    finish('timed out waiting for stop sequence - exiting anyway');
  }, 1200);

  try {
    serialLog('info', 'Quit with machine connected - sending feed hold (!) then soft reset (0x18) before closing port');
    addQRealtime('!'); // hold - decelerate under control
    setTimeout(function() {
      try {
        addQRealtime(String.fromCharCode(0x18)); // ctrl-x soft reset
      } catch (e) {
        serialLog('error', 'Soft reset on quit failed: ' + e.message);
      }
      setTimeout(function() {
        finish('feed hold + soft reset sent');
      }, 150);
    }, 250);
  } catch (e) {
    serialLog('error', 'Feed hold on quit failed: ' + e.message);
    finish('stop sequence errored');
  }
}

// P9: true while the "job is running" confirmation is on screen. Separate
// from isQuitting on purpose - isQuitting means "cleanup has started, point
// of no return", and must NOT be set before the user has actually agreed to
// quit. Setting it around the prompt instead would leave the app permanently
// unquittable after a single cancel.
var quitPromptOpen = false;

// Returns true if the quit is going ahead, false if the user cancelled at the
// confirmation. Callers that can abort their own event (the window 'close'
// handler, will-quit) MUST check the return value and preventDefault(),
// otherwise the window/app would go away anyway despite the user saying no.
function quitAndCleanup(exitCode) {
  if (isQuitting) return true; // already past the point of no return
  if (quitPromptOpen) return false; // don't stack a second dialog on the first

  if (isMachineBusy()) {
    var choice = 1; // default to "go ahead" only if the dialog itself fails
    var promptOptions = {
      type: 'warning',
      buttons: ['Batal', 'Tetap Tutup'],
      defaultId: 0, // Enter = Batal
      cancelId: 0, // Esc / closing the dialog = Batal
      noLink: true,
      title: APP_DISPLAY_NAME,
      message: 'Job sedang berjalan - tutup aplikasi sekarang?',
      detail: 'Mesin masih aktif (status: ' + (status.comms.runStatus || 'tidak diketahui') +
        ').\n\nMenutup aplikasi akan memutus koneksi ke controller. Jika Anda tetap menutup, ' +
        'aplikasi lebih dulu mengirim feed hold dan soft reset supaya mesin berhenti terkendali - ' +
        'tapi job yang sedang berjalan tetap batal dan tidak bisa dilanjutkan.'
    };

    quitPromptOpen = true;
    try {
      // Sync on purpose: this blocks the main process while the dialog is up,
      // so no other quit trigger, socket event or timer can slip in and start
      // tearing things down behind the dialog's back. An async dialog here
      // would be exactly the race this guard exists to prevent.
      choice = jogWindow ?
        dialog.showMessageBoxSync(jogWindow, promptOptions) :
        dialog.showMessageBoxSync(promptOptions);
    } catch (e) {
      // No window to parent to, or dialogs unavailable. Refusing to quit here
      // would make the app impossible to close, pushing the user toward a
      // force-kill - which is the ungraceful teardown this whole path exists
      // to avoid. Proceed, but the controlled-stop below still runs.
      serialLog('error', 'Could not show quit confirmation (' + e.message + ') - proceeding with guarded quit');
      choice = 1;
    } finally {
      quitPromptOpen = false;
    }

    if (choice !== 1) {
      serialLog('info', 'Quit cancelled by user - machine still busy, app stays open');
      return false;
    }
  }

  isQuitting = true;

  // P9: the quit is going ahead (any confirmation above has been answered).
  // Sync-write the recovery snapshot NOW, before the stop sequence and port
  // close below change the picture - the process may exit right after.
  jobRecovery.finish('interrupted');

  serialLog('info', 'Quit requested - beginning shutdown cleanup');

  if (appIcon) {
    try {
      appIcon.destroy();
    } catch (e) {}
  }

  killActiveChildProcesses();

  // Exit only once every cleanup task below (serial port + backend servers)
  // has either finished or hit its own safety timeout.
  var pendingTasks = 2;
  var exited = false;

  function taskDone() {
    pendingTasks--;
    if (pendingTasks <= 0 && !exited) {
      exited = true;
      serialLog('info', 'Shutdown cleanup complete - exiting process');
      electronApp.exit(exitCode || 0);
    }
  }

  // Backend servers can start closing immediately - that's independent of the
  // machine, and nothing about it can disturb the stop sequence below.
  closeBackendServers(taskDone);

  // The port must not close until the machine has been told to stop.
  stopMachineBeforeQuit(function() {
    var portIsOpenUsb = status.comms.interfaces.type == "usb" &&
      typeof port !== 'undefined' && port && port.isOpen;

    if (portIsOpenUsb) {
      var closingPath = port.path;
      serialLog('info', 'Port ' + closingPath + ' is still open at quit - closing before exit');

      // Safety net: never let a wedged driver/board (seen on some grblHAL USB-CDC
      // implementations) block application exit indefinitely - force exit after
      // a short timeout if the close callback never fires.
      var safetyTimer = setTimeout(function() {
        serialLog('warn', 'Port close on quit did not complete within 1.5s - exiting anyway');
        taskDone();
      }, 1500);

      try {
        port.close(function(err) {
          clearTimeout(safetyTimer);
          if (err) {
            serialLog('error', 'Error closing port ' + closingPath + ' on quit: ' + err.message);
          } else {
            serialLog('info', 'Port ' + closingPath + ' closed cleanly on quit');
          }
          taskDone();
        });
      } catch (e) {
        clearTimeout(safetyTimer);
        serialLog('error', 'Exception closing port on quit: ' + e.message);
        taskDone();
      }
    } else {
      serialLog('info', 'No open USB port at quit time');
      taskDone();
    }
  });

  return true;
}
// --- end graceful shutdown ---------------------------------------------------

function parseFeedback(data) {
  //debug_log(data)
  var state = data.substring(1, data.search(/(,|\|)/));
  status.comms.runStatus = state
  // P9: this is where a job is known to have REALLY finished - controller
  // Idle with no line left unacknowledged - so this (not "last line sent") is
  // when the recovery record is cleared.
  if (state == "Idle") {
    jobRecovery.onIdle(sentBuffer.length === 0);
    // P10: the controller reports "Idle" repeatedly once it truly is idle -
    // reuse that (and the same sentBuffer.length===0 signal jobRecovery.onIdle
    // just used above) instead of a separate poller, but latch it so the
    // wizard is only ever told to show ONCE per M6, not on every status tick.
    if (status.comms.awaitingToolChange && !toolChangeWizardEmitted && sentBuffer.length === 0) {
      toolChangeWizardEmitted = true;
      io.sockets.emit('toolChangeWizard', pendingToolChange);
    }
  }
  if (state == "Alarm") {
    // debug_log("ALARM:  " + data)
    status.comms.connectionStatus = 5;
    switch (status.machine.firmware.type) {
      case 'grbl':
        //var alarmCode = parseInt(data.split(':')[1]);
        debug_log('ALARM: ' + data);
        //status.comms.alarm = alarmCode + ' - ' + grblStrings.alarms(alarmCode)
        break;
    }
    status.comms.connectionStatus = 5;
  } else if (state == "Hold:0") {
    pause();
  }
  if (status.machine.firmware.type == "grbl") {
    // Extract work offset (for Grbl > 1.1 only!)
    var startWCO = data.search(/wco:/i) + 4;
    var wco;
    if (startWCO > 4) {
      wco = data.replace(">", "").substr(startWCO).split(/,|\|/, 4);
    }
    if (Array.isArray(wco)) {
      xOffset = parseFloat(wco[0]).toFixed(config.posDecimals);
      yOffset = parseFloat(wco[1]).toFixed(config.posDecimals);
      zOffset = parseFloat(wco[2]).toFixed(config.posDecimals);
      if (status.machine.has4thAxis) {
        aOffset = parseFloat(wco[3]).toFixed(config.posDecimals);
        status.machine.position.offset.x = parseFloat(xOffset);
        status.machine.position.offset.y = parseFloat(yOffset);
        status.machine.position.offset.z = parseFloat(zOffset);
        status.machine.position.offset.a = parseFloat(aOffset);
      } else {
        status.machine.position.offset.x = parseFloat(xOffset);
        status.machine.position.offset.y = parseFloat(yOffset);
        status.machine.position.offset.z = parseFloat(zOffset);
      }
    }
    // Extract wPos (for Grbl > 1.1 only!)
    var startWPos = data.search(/wpos:/i) + 5;
    var wPos;
    if (startWPos > 5) {
      var wPosLen = data.substr(startWPos).search(/>|\|/);
      wPos = data.substr(startWPos, wPosLen).split(/,/);
    }
    var startMPos = data.search(/mpos:/i) + 5;
    var mPos;
    if (startMPos > 5) {
      var mPosLen = data.substr(startMPos).search(/>|\|/);
      mPos = data.substr(startMPos, mPosLen).split(/,/);
    }
    // If we got a WPOS
    if (Array.isArray(wPos)) {
      // debug_log('wpos')
      if (xPos !== parseFloat(wPos[0]).toFixed(config.posDecimals)) {
        xPos = parseFloat(wPos[0]).toFixed(config.posDecimals);
      }
      if (yPos !== parseFloat(wPos[1]).toFixed(config.posDecimals)) {
        yPos = parseFloat(wPos[1]).toFixed(config.posDecimals);
      }
      if (zPos !== parseFloat(wPos[2]).toFixed(config.posDecimals)) {
        zPos = parseFloat(wPos[2]).toFixed(config.posDecimals);
      }
      if (wPos.length > 3) {
        if (aPos !== parseFloat(wPos[3]).toFixed(config.posDecimals)) {
          aPos = parseFloat(wPos[3]).toFixed(config.posDecimals);
          status.machine.has4thAxis = true;
        }
      } else {
        status.machine.has4thAxis = false;
      }
      if (status.machine.has4thAxis) {
        status.machine.position.work.x = parseFloat(xPos);
        status.machine.position.work.y = parseFloat(yPos);
        status.machine.position.work.z = parseFloat(zPos);
        status.machine.position.work.a = parseFloat(aPos);
      } else {
        status.machine.position.work.x = parseFloat(xPos);
        status.machine.position.work.y = parseFloat(yPos);
        status.machine.position.work.z = parseFloat(zPos);
      }
      // end is WPOS
    } else if (Array.isArray(mPos)) {
      // debug_log('mpos', mPos)
      if (xPos !== parseFloat(mPos[0]).toFixed(config.posDecimals)) {
        xPos = parseFloat(mPos[0]).toFixed(config.posDecimals);
      }
      if (yPos !== parseFloat(mPos[1]).toFixed(config.posDecimals)) {
        yPos = parseFloat(mPos[1]).toFixed(config.posDecimals);
      }
      if (zPos !== parseFloat(mPos[2]).toFixed(config.posDecimals)) {
        zPos = parseFloat(mPos[2]).toFixed(config.posDecimals);
      }
      if (mPos.length > 3) {
        if (aPos !== parseFloat(mPos[3]).toFixed(config.posDecimals)) {
          aPos = parseFloat(mPos[3]).toFixed(config.posDecimals);
          status.machine.has4thAxis = true;
        }
      } else {
        status.machine.has4thAxis = false;
      }
      if (status.machine.has4thAxis) {
        status.machine.position.work.x = parseFloat(parseFloat(xPos - status.machine.position.offset.x).toFixed(config.posDecimals));
        status.machine.position.work.y = parseFloat(parseFloat(yPos - status.machine.position.offset.y).toFixed(config.posDecimals));
        status.machine.position.work.z = parseFloat(parseFloat(zPos - status.machine.position.offset.z).toFixed(config.posDecimals));
        status.machine.position.work.a = parseFloat(parseFloat(aPos - status.machine.position.offset.a).toFixed(config.posDecimals));
      } else {
        status.machine.position.work.x = parseFloat(parseFloat(xPos - status.machine.position.offset.x).toFixed(config.posDecimals));
        status.machine.position.work.y = parseFloat(parseFloat(yPos - status.machine.position.offset.y).toFixed(config.posDecimals));
        status.machine.position.work.z = parseFloat(parseFloat(zPos - status.machine.position.offset.z).toFixed(config.posDecimals));
      }
      // end if MPOS
    }

  }
  // Extract override values (for Grbl > v1.1 only!)
  var startOv = data.search(/ov:/i) + 3;
  if (startOv > 3) {
    var ov = data.replace(">", "").substr(startOv).split(/,|\|/, 3);
    if (Array.isArray(ov)) {
      if (ov[0]) {
        status.machine.overrides.feedOverride = parseInt(ov[0]);
      }
      if (ov[1]) {
        status.machine.overrides.rapidOverride = parseInt(ov[1]);
      }
      if (ov[2]) {
        status.machine.overrides.spindleOverride = parseInt(ov[2]);
      }
    }
  }
  // Extract realtime Feed and Spindle (for Grbl > v1.1 only!)
  var startFS = data.search(/\|FS:/i) + 4;
  if (startFS > 4) {
    var fs = data.replace(">", "").substr(startFS).split(/,|\|/);
    if (Array.isArray(fs)) {
      if (fs[0]) {
        status.machine.overrides.realFeed = parseInt(fs[0]);
      }
      if (fs[1]) {
        status.machine.overrides.realSpindle = parseInt(fs[1]);
      }
    }
  }

  // extras realtime feed (if variable spindle is disabled)
  var startF = data.search(/\|F:/i) + 3;
  if (startF > 3) {
    var f = data.replace(">", "").substr(startF).split(/,|\|/);
    console.log(JSON.stringify(f, null, 4))
    if (Array.isArray(f)) {
      if (f[0]) {
        status.machine.overrides.realFeed = parseInt(f[0]);
      }
    }
  }

  // Extract Pin Data
  var startPin = data.search(/Pn:/i) + 3;
  if (startPin > 3) {
    var pinsdata = data.replace(">", "").replace("\r", "").substr(startPin).split(/,|\|/, 1);
    var pins = pinsdata[0].split('')
    status.machine.inputs = pins;
    if (!_.isEqual(pins, oldpinslist)) {
      if (pins.includes('H') && !pins.includes('D')) {
        // pause
        pause();
        var output = {
          'command': '[external from hardware]',
          'response': "Urban Creator CONTROL received a FEEDHOLD notification from Grbl: This could be due to someone pressing the HOLD button (if connected)",
          'type': 'info'
        }
        io.sockets.emit('data', output);
      } // end if HOLD

      if (pins.includes('D')) {
        // pause
        pause();
      }

      if (pins.includes('R')) {
        // abort
        stop(true);
        var output = {
          'command': '[external from hardware]',
          'response': "Urban Creator CONTROL received a RESET/ABORT notification from Grbl: This could be due to someone pressing the RESET/ABORT button (if connected)",
          'type': 'info'
        }
        io.sockets.emit('data', output);
      } // end if ABORT

      if (pins.includes('S')) {
        // abort
        unpause();
        var output = {
          'command': '[external from hardware]',
          'response': "Urban Creator CONTROL received a CYCLESTART/RESUME notification from Grbl: This could be due to someone pressing the CYCLESTART/RESUME button (if connected)",
          'type': 'info'
        }
        io.sockets.emit('data', output);
      } // end if RESUME/START
    }
  } else {
    status.machine.inputs = [];
  }
  oldpinslist = pins;
  // Extract Buffer Data
  var startBuf = data.search(/Bf:/i) + 3;
  if (startBuf > 3) {
    var buffer = data.replace(">", "").replace("\r", "").substr(startBuf).split(/,|\|/, 2);
    // debug_log("BUF: " + JSON.stringify(buffer, null, 2));
    status.machine.firmware.buffer = buffer;
  } else {
    status.machine.firmware.buffer = [];
  }
  // end statusreport
}

function gotModals(data) {
  // as per https://github.com/gnea/grbl/wiki/Grbl-v1.1-Commands#g---view-gcode-parser-state
  // The shown g-code are the current modal states of Grbl's g-code parser.
  // This may not correlate to what is executing since there are usually
  // several motions queued in the planner buffer.
  // [GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0.0 S0]

  // defaults

  data = data.split(/:|\[|\]/)[2].split(" ")

  for (i = 0; i < data.length; i++) {
    // if (data[i] == "G0") {
    //   status.machine.modals.motionmode = "G0";
    // }
    // if (data[i] == "G1") {
    //   status.machine.modals.motionmode = "G1";
    // }
    // if (data[i] == "G2") {
    //   status.machine.modals.motionmode = "G2";
    // }
    // if (data[i] == "G3") {
    //   status.machine.modals.motionmode = "G3";
    // }
    // if (data[i] == "G38.2") {
    //   status.machine.modals.motionmode = "G38.2";
    // }
    // if (data[i] == "G38.3") {
    //   status.machine.modals.motionmode = "G38.3";
    // }
    // if (data[i] == "G38.4") {
    //   status.machine.modals.motionmode = "G38.4";
    // }
    // if (data[i] == "G38.5") {
    //   status.machine.modals.motionmode = "G38.5";
    // }
    // if (data[i] == "G80") {
    //   status.machine.modals.motionmode = "G80";
    // }

    //   status.machine.modals.coordinatesys = "G54"; // G54, G55, G56, G57, G58, G59
    if (data[i] == "G54") {
      status.machine.modals.coordinatesys = "G54";
    }
    if (data[i] == "G55") {
      status.machine.modals.coordinatesys = "G55";
    }
    if (data[i] == "G56") {
      status.machine.modals.coordinatesys = "G56";
    }
    if (data[i] == "G57") {
      status.machine.modals.coordinatesys = "G57";
    }
    if (data[i] == "G58") {
      status.machine.modals.coordinatesys = "G58";
    }
    if (data[i] == "G59") {
      status.machine.modals.coordinatesys = "G59";
    }

    //   status.machine.modals.plane = "G17"; // G17, G18, G19
    if (data[i] == "G17") {
      status.machine.modals.plane = "G17";
    }
    if (data[i] == "G18") {
      status.machine.modals.plane = "G18";
    }
    if (data[i] == "G19") {
      status.machine.modals.plane = "G19";
    }

    //   status.machine.modals.distancemode = "G90"; // G90, G91
    if (data[i] == "G90") {
      status.machine.modals.distancemode = "G90";
    }
    if (data[i] == "G91") {
      status.machine.modals.distancemode = "G91";
    }

    //   status.machine.modals.arcdistmode = "G91.1"; // G91.1
    if (data[i] == "G91.1") {
      status.machine.modals.arcdistmode = "G91.1";
    }

    //   status.machine.modals.feedratemode = "G94"; // G93, G94
    if (data[i] == "G93") {
      status.machine.modals.feedratemode = "G93";
    }
    if (data[i] == "G94") {
      status.machine.modals.feedratemode = "G94";
    }

    //   status.machine.modals.unitsmode = "G21"; // G20, G21
    if (data[i] == "G20") {
      status.machine.modals.unitsmode = "G20";
    }
    if (data[i] == "G21") {
      status.machine.modals.unitsmode = "G21";
    }

    //   status.machine.modals.radiuscomp = "G40"; // G40
    if (data[i] == "G40") {
      status.machine.modals.radiuscomp = "G40";
    }

    //   status.machine.modals.tlomode = "G49"; // G43.1, G49
    if (data[i] == "G49") {
      status.machine.modals.tlomode = "G49";
    }
    if (data[i] == "G43.1") {
      status.machine.modals.tlomode = "G43.1";
    }

    //   status.machine.modals.programmode = "M0"; // M0, M1, M2, M30
    // if (data[i] == "M0") {
    //   status.machine.modals.programmode = "M0";
    // }
    // if (data[i] == "M1") {
    //   status.machine.modals.programmode = "M1";
    // }
    // if (data[i] == "M2") {
    //   status.machine.modals.programmode = "M2";
    // }
    // if (data[i] == "M30") {
    //   status.machine.modals.programmode = "M30";
    // }

    //   status.machine.modals.spindlestate = "M5"; // M3, M4, M5
    if (data[i] == "M3") {
      status.machine.modals.spindlestate = "M3";
    }
    if (data[i] == "M4") {
      status.machine.modals.spindlestate = "M4";
    }
    if (data[i] == "M5") {
      status.machine.modals.spindlestate = "M5";
    }

    //   status.machine.modals.coolantstate = "M9"; // M7, M8, M9
    if (data[i] == "M7") {
      status.machine.modals.coolantstate = "M7";
    }
    if (data[i] == "M8") {
      status.machine.modals.coolantstate = "M8";
    }
    if (data[i] == "M9") {
      status.machine.modals.coolantstate = "M9";
    }

    // //   status.machine.modals.tool = "0",
    // if (data[i].indexOf("T") === 0) {
    //   status.machine.modals.tool = parseFloat(data[i].substr(1))
    // }
    //
    // //   status.machine.modals.spindle = "0"
    // if (data[i].indexOf("S") === 0) {
    //   status.machine.modals.spindle = parseFloat(data[i].substr(1))
    // }
    //
    // //   status.machine.modals.feedrate = "0"
    // if (data[i].indexOf("F") === 0) {
    //   status.machine.modals.feedrate = parseFloat(data[i].substr(1))
    // }
  }
} // end gotModals

function laserTest(data) {
  if (status.comms.connectionStatus > 0) {
    data = data.split(',');
    var power = parseFloat(data[0]);
    var duration = parseInt(data[1]);
    var maxS = parseFloat(data[2]);
    if (power > 0) {
      if (!laserTestOn) {
        // laserTest is off
        // debug_log('laserTest: ' + 'Power ' + power + ', Duration ' + duration + ', maxS ' + maxS);
        if (duration >= 0) {
          switch (status.machine.firmware.type) {
            case 'grbl':
              addQToEnd('G1F1');
              addQToEnd('M3S' + parseInt(power * maxS / 100));
              laserTestOn = true;
              io.sockets.emit('laserTest', power);
              if (duration > 0) {
                addQToEnd('G4 P' + duration / 1000);
                addQToEnd('M5S0');
                laserTestOn = false;
              }
              send1Q();
              break;
          }
        }
      } else {
        // debug_log('laserTest: ' + 'Power off');
        switch (status.machine.firmware.type) {
          case 'grbl':
            addQToEnd('M5S0');
            send1Q();
            break;
        }
        laserTestOn = false;
        io.sockets.emit('laserTest', 0);
      }
    }
  } else {
    debug_log('ERROR: Machine connection not open!');
  }
}

// ---------------------------------------------------------------------------
// P10 Tahap 1b-ii: Fixed Tool Sensor's own gcode sender - fully independent
// of the main job's gcodeQueue/queuePointer/sentBuffer/send1Q() (see the
// comment on toolChangeWizardQueue's declaration for why this has to be
// separate). Deliberately mirrors send1Q()'s own structure (one line per
// "ok", respect the RX buffer) rather than reusing it, since reusing it is
// exactly what caused the two bugs the investigation found.
// ---------------------------------------------------------------------------

// Same formula as BufferSpace('grbl'), but against the wizard's OWN
// sentBuffer - never the main job's. Kept as its own function (not
// BufferSpace() with a parameter) so neither can accidentally read the
// other's state by a future refactor mistake.
function toolChangeWizardBufferSpace() {
  var total = 0;
  for (var i = 0; i < toolChangeWizardSentBuffer.length; i++) {
    total += toolChangeWizardSentBuffer[i].length;
  }
  if (status.machine.firmware.rxBufferSize > 0) {
    return (status.machine.firmware.rxBufferSize - 1) - total;
  }
  return status.machine.firmware.platform == "grblHAL" ? GRBLHAL_RX_BUFFER_SIZE - total : GRBL_RX_BUFFER_SIZE - total;
}

// Minimal tulis-port - deliberately NOT machineSend(): that function reads
// gcodeQueue/queuePointer to emit "queueCount" (the main job's progress),
// which would show confusing/wrong numbers during a probe sequence that has
// nothing to do with the main job's queue. No T-word tracking either - not
// relevant to probe gcode.
function machineSendToolChangeWizard(gcode) {
  debug_log("WIZARD SENDING: " + gcode);
  if (port.isOpen) {
    port.write(gcode);
    debug_log("WIZARD SENT: " + gcode);
  }
}

function sendToolChangeWizardQ() {
  if (status.comms.connectionStatus > 0 && (toolChangeWizardQueue.length - toolChangeWizardPointer) > 0) {
    var spaceLeft = toolChangeWizardBufferSpace();
    var gcode = toolChangeWizardQueue[toolChangeWizardPointer];
    if (gcode.length < spaceLeft) {
      toolChangeWizardPointer++;
      toolChangeWizardSentBuffer.push(gcode);
      machineSendToolChangeWizard(gcode + '\n');
    }
    // P10: deliberately no "blocked" flag/retry-on-timer here for the
    // buffer-full case - proven unnecessary (not just assumed) by the
    // investigation before this commit: every gcode line THIS sender is
    // ever given is validated against an EMPTY buffer's capacity before
    // sending starts at all (see startToolChangeWizardSend()), so a line
    // can only ever be blocked here by OTHER lines still in flight - and
    // those are guaranteed to free the needed space once acked, retried via
    // the "ok" routing below, never by anything stuck waiting with nothing
    // outstanding to ack. See test/toolchange-wizard-queue-separation.test.js
    // for the proof (both the forced-deadlock case this guards against, and
    // the realistic-gcode case showing it never gets close to the limit).
  }
}

// The ONLY way to start the wizard sender - never push to
// toolChangeWizardQueue directly. Returns false (refuses, sends nothing) if
// either precondition is not met:
//   - awaitingToolChange must already be true (nothing to probe for otherwise)
//   - sentBuffer (the MAIN job's) must already be fully drained - proven
//     necessary by the investigation: forcing both sentBuffer and
//     toolChangeWizardSentBuffer to hold something at the same time showed
//     the "ok" routing below silently strands the main job's entry forever,
//     corrupting jobRecovery's unacked-line count for the rest of the
//     session with no error surfaced. Refusing here instead turns that into
//     a loud, logged refusal that can never happen in normal operation (the
//     wizard is only ever offered once Commit 3 of Tahap 1a's own Idle+
//     drained check already confirms sentBuffer is empty) - this is
//     defence-in-depth for if that invariant is ever broken by a future
//     change, not something expected to trigger today.
//   - every line must individually fit in a COMPLETELY EMPTY wizard buffer -
//     proven necessary: a line longer than that can never be sent at all
//     (nothing to retry against), a real, reproduced deadlock for an
//     artificially tiny buffer + long line, even though no realistic probe
//     gcode line comes remotely close (worst case ~28 bytes against a
//     minimum real buffer of 126).
function startToolChangeWizardSend(gcodeLines) {
  if (!status.comms.awaitingToolChange) {
    serialLog('error', 'startToolChangeWizardSend refused: not awaiting a tool change');
    return false;
  }
  if (sentBuffer.length > 0) {
    serialLog('error', 'startToolChangeWizardSend refused: main job sentBuffer not drained (length ' + sentBuffer.length + ')');
    return false;
  }
  var emptyBufferSpace = toolChangeWizardBufferSpace(); // toolChangeWizardSentBuffer is still empty here
  for (var i = 0; i < gcodeLines.length; i++) {
    if (gcodeLines[i].length >= emptyBufferSpace) {
      serialLog('error', 'startToolChangeWizardSend refused: line ' + (i + 1) + ' (' + gcodeLines[i].length +
        ' bytes) does not fit even in a fully empty buffer (' + emptyBufferSpace + ' bytes)');
      return false;
    }
  }
  toolChangeWizardQueue = gcodeLines.slice();
  toolChangeWizardPointer = 0;
  toolChangeWizardSentBuffer.length = 0;
  sendToolChangeWizardQ();
  return true;
}

// P10 Tahap 1b-ii: the routing decision from the serial port's "ok" handler,
// extracted into its own function so it can be tested directly
// (grabFunction('routeOkAndAdvance')) without reconstructing the much larger
// parser.on("data", ...) handler it lives in. Routes to whichever sender
// genuinely has something outstanding - the two never have something at the
// same time in normal operation (see startToolChangeWizardSend's comment),
// so this is never ambiguous in practice, but is written so there is no
// shared state either side could be confused by. Takes and returns `command`
// because the ORIGINAL (pre-Tahap-1b-ii) code reassigned it from
// sentBuffer.shift() for logging further down in the same handler - this
// keeps that exact behaviour for the main-job branch, byte for byte.
function routeOkAndAdvance(command) {
  if (toolChangeWizardSentBuffer.length > 0) {
    command = toolChangeWizardSentBuffer.shift();
    sendToolChangeWizardQ();
  } else {
    if (status.machine.firmware.type === "grbl") {
      command = sentBuffer.shift();
    }
    if (command == "$CD") {
      io.sockets.emit('fluidncConfig', fluidncConfig);
    }
    status.comms.blocked = false;
    send1Q();
  }
  return command;
}

// queue
function BufferSpace(firmware) {
  var total = 0;
  var len = sentBuffer.length;
  for (var i = 0; i < len; i++) {
    total += sentBuffer[i].length;
  }
  if (firmware == "grbl") {
    if (status.machine.firmware.rxBufferSize > 0) {
      return (status.machine.firmware.rxBufferSize - 1) - total;
    } else {
      if (status.machine.firmware.platform == "grblHAL") {
        return GRBLHAL_RX_BUFFER_SIZE - total;
      } else {
        return GRBL_RX_BUFFER_SIZE - total;
      }
    }

  }
}


function send1Q() {
  // console.time('send1Q');
  var gcode;
  var gcodeLen = 0;
  var spaceLeft = 0;
  if (status.comms.connectionStatus > 0) {
    switch (status.machine.firmware.type) {
      case 'grbl':
        if ((gcodeQueue.length - queuePointer) > 0 && !status.comms.blocked && !status.comms.paused && !status.comms.awaitingToolChange) {
          if (toolChangeQIndexes.has(queuePointer)) {
            // P10: an M6 line - never sent to the controller (grbl/grblHAL
            // without $341 does not support it), so it needs no buffer space
            // and no "ok" is ever coming back for it. queuePointer is
            // advanced (this queue entry IS done with, as far as the queue is
            // concerned) but nothing is pushed to sentBuffer - that keeps
            // getFirstUnackedQ() (queuePointer - sentBuffer.length, see
            // jobRecovery.js) correct with zero changes there: once the
            // REST of sentBuffer drains, it naturally lands on the line right
            // after this M6, which is exactly the correct resume point.
            queuePointer++;
            if (toolChangeMode === 'ignore') {
              // Tahap 1b-i: M6 is still never sent (the skip above already
              // guaranteed that - same prerequisite for every mode), but
              // there is no wizard and nothing is waiting on an "ok" for the
              // line just skipped, so carry on immediately. setImmediate
              // (not a direct recursive call) so a pathological file with
              // many consecutive M6 lines can never grow the call stack -
              // each skip is its own fresh stack, however many there are.
              //
              // Guarded on gcodeQueue.length > 0: if this M6 was the LAST
              // queue entry, the completion check a few lines below (after
              // this switch) already runs SYNCHRONOUSLY in this same call -
              // awaitingToolChange is never set in Ignore mode, so nothing
              // stops it - and dumps the queue before this deferred call
              // even fires. Without this guard that leaves a stray
              // send1Q() call to run moments later against an
              // already-completed, already-EMPTY queue, which the
              // completion check cannot tell apart from "a trivial job with
              // nothing in it" and reports as a second, bogus FAILED
              // completion. See test/toolchange-mode-send1q.test.js.
              setImmediate(function() {
                if (gcodeQueue.length > 0) send1Q();
              });
            } else {
              pendingToolChange = toolChangeQIndexes.get(queuePointer - 1);
              status.comms.awaitingToolChange = true;
              toolChangeWizardEmitted = false;
            }
          } else {
            spaceLeft = BufferSpace('grbl');

            // Do we have enough space in the buffer?
            if (gcodeQueue[queuePointer].length < spaceLeft) {
              gcode = gcodeQueue[queuePointer];
              queuePointer++;
              sentBuffer.push(gcode);
              machineSend(gcode + '\n', false);
              // debug_log('Sent: ' + gcode + ' Q: ' + (gcodeQueue.length - queuePointer) + ' Bspace: ' + (spaceLeft - gcode.length - 1));
            } else {
              status.comms.blocked = true;
            }
          }
        }
        break;
    }
    // P10: awaitingToolChange excluded - an M6 as the LAST queue entry must
    // still show the wizard, not be treated as "job complete" just because
    // queuePointer caught up to gcodeQueue.length by skipping over it.
    if (queuePointer >= gcodeQueue.length && !status.comms.awaitingToolChange) {
      // P9: every line has been SENT - not executed. The controller still
      // holds the tail in its RX buffer and planner, so keep the recovery
      // record (state "completing") until it reports Idle with everything
      // acknowledged (see parseFeedback). Must run before the queue is dumped
      // below: it reads the live queue. No-op when no tracked job is active.
      jobRecovery.markFullySent();
      if (gcodeQueue.length > 1) {
        var data = {
          completed: true,
          failed: false,
          jobCompletedMsg: jobCompletedMsg,
          jobStartTime: jobStartTime,
          jobEndTime: new Date().getTime()
        }
        io.sockets.emit('jobComplete', data);
      } else {
        var data = {
          completed: true,
          failed: true,
          jobCompletedMsg: jobCompletedMsg,
          jobStartTime: jobStartTime,
          jobEndTime: new Date().getTime()
        }
        io.sockets.emit('jobComplete', data);
      }
      status.comms.connectionStatus = 2; // finished
      clearInterval(queueCounter);
      if (jogWindow) {
        jogWindow.setProgressBar(0);
      }
      gcodeQueue.length = 0; // Dump the Queye
      queuePointer = 0;
      status.comms.connectionStatus = 2; // finished
      jobCompletedMsg = ""
      jobStartTime = false;
      // P10: awaitingToolChange is already false here (see the guard a few
      // lines up) - reset alongside the rest anyway, uniformly with every
      // other place that dumps the queue, and to clear any map left over
      // from a tool change earlier in this same job.
      status.comms.awaitingToolChange = false;
      pendingToolChange = null;
      toolChangeWizardEmitted = false;
      toolChangeQIndexes.clear();
      toolChangeWizardQueue.length = 0;
      toolChangeWizardPointer = 0;
      toolChangeWizardSentBuffer.length = 0;
    }
  } else {
    debug_log('Not Connected')
  }
  // console.timeEnd('send1Q');
}

var modalCommands = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G17', 'G18', 'G19', 'G90', 'G91', 'G91.1', 'G93', 'G94', 'G20', 'G21', 'G40', 'G43.1', 'G49', 'M0', 'M1', 'M2', 'M30', 'M3', 'M4', 'M5', 'M7', 'M8', 'M9']
var modalCommandsRegExp = new RegExp(modalCommands.join("|"));

function addQToEnd(gcode) {
  // debug_log('added ' + gcode)
  gcodeQueue.push(gcode);
  // if (gcode.indexOf("G54") != -1 || gcode.indexOf("G55") != -1 || gcode.indexOf("G56") != -1 || gcode.indexOf("G57") != -1 || gcode.indexOf("G58") != -1 || gcode.indexOf("G59") != -1) {
  //   gcodeQueue.push("$G");
  // }
  var testGcode = gcode.toUpperCase()
  if (testGcode.indexOf("$H") != -1) {
    status.machine.modals.homedRecently = true;
  }
  if (testGcode == "$CD") {
    fluidncConfig = ""; // empty string
  }
  if (!gcode.startsWith("$J=") && modalCommandsRegExp.test(testGcode)) {
    gcodeQueue.push("$G");
  }
  if (gcode.match(/T([\d.]+)/i)) {
    gcodeQueue.push("$G");
  }


}

function addQToStart(gcode) {
  gcodeQueue.unshift(gcode);
}

function addQRealtime(gcode) {
  // realtime command skip the send1Q as it doesnt respond with an ok
  machineSend(gcode, true);
}

function showJogWindow() {
  if (jogWindow === null) {
    createJogWindow();
  }
  jogWindow.show()
  jogWindow.setAlwaysOnTop(true);
  jogWindow.focus();
  jogWindow.setAlwaysOnTop(false);
}

// Electron
function isElectron() {
  if (typeof window !== 'undefined' && window.process && window.process.type === 'renderer') {
    return true;
  }
  if (typeof process !== 'undefined' && process.versions && !!process.versions.electron) {
    return true;
  }
  return false;
}

if (isElectron()) {
  const gotTheLock = electronApp.requestSingleInstanceLock()
  var lauchGUI = true;
  if (!gotTheLock) {
    debug_log("Already running! Check the System Tray")
    electronApp.exit(0);
    electronApp.quit();
  } else {
    electronApp.on('second-instance', (event, commandLine, workingDirectory) => {
      //Someone tried to run a second instance, we should focus our window.
      // debug_log('SingleInstance')

      function checkFileType(fileName) {
        var fileNameLC = fileName.toLowerCase();
        if (fileNameLC.endsWith('.obc') || fileName.endsWith('.gcode') || fileName.endsWith('.gc') || fileName.endsWith('.tap') || fileName.endsWith('.nc') || fileName.endsWith('.cnc')) {
          return fileName;
        }
      }

      debug_log(commandLine)
      lauchGUI = true;

      var openFilePath = commandLine.find(checkFileType);
      if (openFilePath !== "") {
        readFile(openFilePath);
        if (openFilePath !== undefined) {
          if (openFilePath.endsWith('.obc')) {
            lauchGUI = false;
          } else {
            lauchGUI = true;
          }
        }
      }

      if (lauchGUI) {
        showJogWindow()
      }
    })
    // Create myWindow, load the rest of the app, etc...
    electronApp.on('ready', () => {
      // P8: Windows auto-starts this app at login (see setLoginItemSettings
      // below) - if it were shown every boot, that'd be an unwanted popup on
      // every login, hence the historical "sit in Tray" default. But that
      // same default was also silently applying to a user deliberately
      // opening the app from the Start Menu/desktop shortcut, which is
      // confusing for anyone who doesn't already know to look in the tray.
      // wasOpenedAtLogin distinguishes the two: true only when Windows
      // itself launched the app at boot via the login item, not when a
      // human launched it directly - so only THAT case still starts hidden.
      var openedAtLogin = process.platform == 'win32' && electronApp.getLoginItemSettings().wasOpenedAtLogin;
      if (openedAtLogin) {
        // Don't show window - sit in Tray
      } else {
        showJogWindow()
      }
    })
  }

  if (electronApp) {
    // Module to create native browser window.

    function createApp() {
      createTrayIcon();
      if (process.platform == 'darwin') {
        debug_log("Creating MacOS Menu");
        createMenu();
        status.driver.operatingsystem = 'macos';
      }
      if (process.platform == 'win32' && process.argv.length >= 2) {
        var openFilePath = process.argv[1];
        if (openFilePath !== "") {
          debug_log("path" + openFilePath);
          readFile(openFilePath);
        }
        status.driver.operatingsystem = 'windows';
      }

      if (process.platform == 'darwin' || uploadedgcode.length > 1) {
        showJogWindow()
      }

    }

    function createMenu() {

      var template = [{
        label: "Application",
        submenu: [{
          label: "Quit",
          accelerator: "Command+Q",
          click: function() {
            quitAndCleanup(0);
          }
        }]
      }, {
        label: "Edit",
        submenu: [{
            label: "Cut",
            accelerator: "CmdOrCtrl+X",
            selector: "cut:"
          },
          {
            label: "Copy",
            accelerator: "CmdOrCtrl+C",
            selector: "copy:"
          },
          {
            label: "Paste",
            accelerator: "CmdOrCtrl+V",
            selector: "paste:"
          },
          {
            label: "Select All",
            accelerator: "CmdOrCtrl+A",
            selector: "selectAll:"
          }
        ]
      }, {
        label: "View",
        submenu: [{
            label: "Reload",
            accelerator: "F5",
            click: (item, focusedWindow) => {
              if (focusedWindow) {
                // on reload, start fresh and close any old
                // open secondary windows
                if (focusedWindow.id === 1) {
                  BrowserWindow.getAllWindows().forEach(win => {
                    if (win.id > 1) win.close();
                  });
                }
                focusedWindow.reload();
              }
            }
          },
          {
            label: "Toggle Dev Tools",
            accelerator: "F12",
            click: () => {
              jogWindow.webContents.toggleDevTools();
            }
          }
        ]
      }];

      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    }

    function createTrayIcon() {
      if (process.platform !== 'darwin') {
        appIcon = new Tray(
          nativeImage.createFromPath(iconPath)
        )
        const contextMenu = Menu.buildFromTemplate([{
          label: 'Open User Interface (GUI)',
          click() {
            // debug_log("Clicked Systray")
            showJogWindow()
          }
        }, {
          label: 'Quit ' + APP_DISPLAY_NAME + ' (Disables all integration until started again)',
          click() {
            quitAndCleanup(0);
          }
        }])
        if (appIcon) {
          appIcon.on('click', function() {
            // debug_log("Clicked Systray")
            showJogWindow()
          })
        }

        if (appIcon) {
          appIcon.on('balloon-click', function() {
            // debug_log("Clicked Systray")
            showJogWindow()
          })
        }

        // Call this again for Linux because we modified the context menu
        if (appIcon) {
          appIcon.setContextMenu(contextMenu)
        }

        if (appIcon) {
          appIcon.displayBalloon({
            icon: nativeImage.createFromPath(iconPath),
            title: APP_DISPLAY_NAME + " Started",
            // content: "OpenBuilds CONTROL has started successfully: Active on " + ip.address() + ":" + config.webPort
            content: APP_DISPLAY_NAME + " has started successfully"
          })
        }
      } else {
        const dockMenu = Menu.buildFromTemplate([{
          label: 'Quit ' + APP_DISPLAY_NAME + ' (Disables all integration until started again)',
          click() {
            quitAndCleanup(0);
          }
        }])
        electronApp.dock.setMenu(dockMenu)
      };

    }

    function createJogWindow() {
      // Create the browser window.
      jogWindow = new BrowserWindow({
        // 1366 * 768 == minimum to cater for
        width: 1000,
        minWidth: 1000,
        height: 850,
        minHeight: 850,
        fullscreen: false,
        center: true,
        resizable: true,
        maximizable: true,
        title: APP_DISPLAY_NAME,
        frame: false,
        autoHideMenuBar: true,
        //icon: '/app/favicon.png',
        icon: nativeImage.createFromPath(
          path.join(__dirname, "/app/favicon.png")
        ),
        webgl: true,
        experimentalFeatures: true,
        experimentalCanvasFeatures: true,
        offscreen: true,
        backgroundColor: "#fff",
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false
        }
      });

      jogWindow.setOverlayIcon(nativeImage.createFromPath(iconPath), 'Icon');
      var ipaddr = ip.address();
      // jogWindow.loadURL(`//` + ipaddr + `:3000/`)
      jogWindow.loadURL(`http://localhost:${config.webPort}/`);
      //jogWindow.webContents.openDevTools()

      // P8: used to hide to tray - now quits for real (Alt+F4, taskbar
      // right-click > Close), same validated cleanup path as tray Quit/Cmd+Q/
      // the custom titlebar X (see "minimisetotray" above). quitAndCleanup is
      // idempotent via its own isQuitting guard, so this is harmless if a quit
      // is already under way from another path.
      // P9: it returns false when the user cancels the "job is running"
      // confirmation - the window must then stay open, otherwise it would
      // disappear anyway despite them having just said no.
      jogWindow.on('close', function(event) {
        if (!quitAndCleanup(0)) {
          event.preventDefault();
        }
      });

      // Emitted when the window is closed.
      jogWindow.on('closed', function() {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        jogWindow = null;
      });
      jogWindow.once('ready-to-show', () => {
        showJogWindow()
      })
    }

    // This method will be called when Electron has finished
    // initialization and is ready to create browser windows.
    // Some APIs can only be used after this event occurs.
    electronApp.on('ready', createApp);

    electronApp.on('before-quit', function() {
      serialLog('info', 'before-quit event received');
    })

    // will-quit is a safety net for quit paths we don't originate ourselves
    // (e.g. OS shutdown/logoff triggering Electron's default app.quit() flow).
    // quitAndCleanup() is idempotent, so this is harmless if it already ran.
    electronApp.on('will-quit', function(event) {
      // On OS X it is common for applications and their menu bar
      // to stay active until the user quits explicitly with Cmd + Q
      // We don't take that route, we close it completely.
      // P9: cancelling the "job is running" confirmation has to abort this
      // quit too, same as the window 'close' handler above.
      if (!quitAndCleanup(0)) {
        event.preventDefault();
      }
    });

    // Quit when all windows are closed. On Windows this is the most common
    // exit path (closing the jog window fully quits rather than minimizing
    // to tray), so it's the one most likely to have left a serial port open.
    electronApp.on('window-all-closed', function() {
      // On OS X it is common for applications and their menu bar
      // to stay active until the user quits explicitly with Cmd + Q
      quitAndCleanup(0);
    });

    electronApp.on('activate', function() {
      // On OS X it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) {
        createApp();
      }
    });

    // Autostart on Login
    if (process.platform == 'win32') {
      electronApp.setLoginItemSettings({
        openAtLogin: true,
        args: []
      })
    }

    // Catch termination signals too (Ctrl+C in a dev console, `npm run-local`,
    // a service manager stop) so the port still gets a clean close attempt.
    process.on('SIGINT', function() {
      serialLog('info', 'SIGINT received');
      quitAndCleanup(0);
    });
    process.on('SIGTERM', function() {
      serialLog('info', 'SIGTERM received');
      quitAndCleanup(0);
    });
  }
} else { // if its not running under Electron, lets get Chrome up.
  var isPi = require('detect-rpi');
  if (isPi()) {
    DEBUG = true;
    debug_log('Running on Raspberry Pi!');
    status.driver.operatingsystem = 'rpi'
    startChrome();
  } else {
    debug_log("Running under NodeJS...");
  }
}


function stop(data) {
  //data = { stop: false, jog: false, abort: true}
  if (status.comms.connectionStatus > 0) {
    // A jog-cancel (data.jog: the orange Stop Jog button, released continuous-jog keys)
    // is ONLY 0x85, which the controller honours while it is jogging - during a job it is
    // ignored, while the server below would still dump its queue and report "Connected",
    // leaving the machine running whatever is already in its RX buffer and planner with
    // every Stop button disabled. So when a job is running the request is a FULL stop
    // (hold, then reset). "Running" is judged BEFORE the queue is dumped and NOT by the
    // queue length alone: manual jog commands ("$J=...") are queued too, and a plain jog
    // release must stay a plain 0x85.
    //   3 / 4          streaming / paused job (only runJob sets these)
    //   isTracking()   every line sent but the controller has not reported Idle yet
    //   jobStartTime   a stamped real job with lines still queued
    var jobRunning = status.comms.connectionStatus == 3 || status.comms.connectionStatus == 4 ||
      jobRecovery.isTracking() || (!!jobStartTime && gcodeQueue.length > 0);
    var jogOnly = !!(data && data.jog) && !jobRunning;
    // P9: snapshot where the job had got to BEFORE the queue is dumped below.
    // The record is deliberately KEPT (state "stopped"): "Recover a stopped
    // job" is exactly what the ribbon button is for (tool broke -> Stop ->
    // swap tool -> resume). It is cleared when the job completes, when the
    // user discards it, or when the next job starts. A jog-cancel (data.jog)
    // is not a job stop.
    if (!jogOnly) {
      jobRecovery.finish('stopped');
    }
    // Before the resets further down clear jobStartTime and the queue. Applies
    // to a jog-cancel too: it dumps the whole queue, so a running job is dead.
    announceJobStopped('stopped');
    status.comms.paused = true;
    debug_log('STOP');
    switch (status.machine.firmware.type) {
      case 'grbl':

        if (jogOnly) {
          addQRealtime(String.fromCharCode(0x85)); // canceljog
          debug_log('Sent: 0x85 Jog Cancel');
          debug_log(queuePointer, gcodeQueue)
        }

        if (!data.abort && !jogOnly) { // pause motion first.
          addQRealtime('!'); // hold
          debug_log('Sent: !');
        }

        if (status.machine.firmware.version === '1.1d') {
          addQRealtime(String.fromCharCode(0x9E)); // Stop Spindle/Laser
          debug_log('Sent: Code(0x9E)');
        }

        debug_log('Cleaning Queue');
        if (!jogOnly) {
          setTimeout(function() {
            addQRealtime(String.fromCharCode(0x18)); // ctrl-x
            debug_log('Sent: Code(0x18)');
          }, 200);
        }
        status.comms.connectionStatus = 2;
        break;
    }
    clearInterval(queueCounter);
    if (jogWindow) {
      jogWindow.setProgressBar(0);
    }
    status.comms.queue = 0
    queuePointer = 0;
    gcodeQueue.length = 0; // Dump the queue
    sentBuffer.length = 0; // Dump the queue
    // sentBuffer.length = 0; // Dump bufferSizes
    // The job is dead along with its queue: drop its start time and completion
    // message too. Left set, the next command's "ok" reached send1Q's empty-
    // queue branch and emitted a jobComplete carrying the OLD jobStartTime
    // (bogus "JOB COMPLETE" log + junk job-history entry after every Stop).
    jobStartTime = false;
    jobCompletedMsg = "";
    laserTestOn = false;
    status.comms.blocked = false;
    status.comms.paused = false;
    status.comms.runStatus = 'Stopped';
    status.comms.alarm = "";
    // P10: same reasoning - a tool-change wait belongs to a queue that no
    // longer exists after this dump.
    status.comms.awaitingToolChange = false;
    pendingToolChange = null;
    toolChangeWizardEmitted = false;
    toolChangeQIndexes.clear();
    toolChangeWizardQueue.length = 0;
    toolChangeWizardPointer = 0;
    toolChangeWizardSentBuffer.length = 0;
  } else {
    debug_log('ERROR: Machine connection not open!');
  }
}

function pause() {
  // P10: the queue is already halted at an M6, waiting on the wizard - the
  // controller is confirmed idle by the time this can even be true (see
  // Commit 3), so a manual Pause here would hold nothing that is moving. More
  // importantly: only resumeToolChange may clear awaitingToolChange, so
  // pausing "on top of" it here would do nothing useful and could confuse
  // the two flags in the UI - refuse it outright instead of half-doing it.
  if (status.comms.awaitingToolChange) {
    debug_log('PAUSE ignored: tool-change wizard is active');
    return;
  }
  if (status.comms.connectionStatus == 3) {
    status.comms.paused = true;
    debug_log('PAUSE');
    switch (status.machine.firmware.type) {
      case 'grbl':
        addQRealtime('!'); // Send hold command
        debug_log('Sent: !');
        if (status.machine.firmware.version === '1.1d') {
          addQRealtime(String.fromCharCode(0x9E)); // Stop Spindle/Laser
          debug_log('Sent: Code(0x9E)');
        }
        break;
    }
    status.comms.runStatus = 'Paused';
    status.comms.connectionStatus = 4;
  } else {
    debug_log('ERROR: Machine connection not open!');
  }
}

function unpause() {
  if (status.comms.connectionStatus > 0) {
    debug_log('UNPAUSE');
    switch (status.machine.firmware.type) {
      case 'grbl':
        addQRealtime('~'); // Send resume command
        debug_log('Sent: ~');
        break;
    }
    status.comms.paused = false;
    status.comms.blocked = false;
    setTimeout(function() {
      send1Q(); // restart queue
    }, 200);
    status.comms.runStatus = 'Resuming';
    status.comms.connectionStatus = 3;
  } else {
    debug_log('ERROR: Machine connection not open!');
  }
}

function isJson(item) {
  item = typeof item !== "string" ?
    JSON.stringify(item) :
    item;

  try {
    item = JSON.parse(item);
  } catch (e) {
    return false;
  }

  if (typeof item === "object" && item !== null) {
    return true;
  }

  return false;
}

function startChrome() {
  if (status.driver.operatingsystem == 'rpi') {
    const {
      spawn
    } = require('child_process');
    const chrome = spawn('chromium-browser', [`-app=http://127.0.0.1:${config.webPort}`]);
    chrome.on('close', (code) => {
      debug_log(`Chromium process exited with code ${code}`);
      process.exit(0);
    });
  } else {
    debug_log('Not a Raspberry Pi. Please use Electron Instead');
  }
}

// Interface Programming


// grab latest firmware.bin for Interface on startup

var file = fs.createWriteStream(path.join(uploadsDir, "firmware.bin"));
https.get("https://raw.githubusercontent.com/OpenBuilds/firmware/main/interface/firmware.bin", function(response) {
  response.pipe(file);
  file.on('finish', function() {
    file.close(function() {

      const options = {
        hostname: 'raw.githubusercontent.com',
        port: 443,
        path: '/OpenBuilds/firmware/main/interface/version.txt',
        method: 'GET'
      }

      const req = https.request(options, res => {
        console.log(`statusCode: ${res.statusCode}`)

        res.on('data', d => {
          status.interface.firmware.availVersion = parseFloat(d.toString())

          var output = {
            'command': 'interface firmware update tool',
            'response': "Downloaded firmware.bin v" + status.interface.firmware.availVersion,
            'type': 'info'
          }
          io.sockets.emit('data', output);
          debug_log(JSON.stringify(output));

        })
      })

      req.on('error', error => {
        var output = {
          'command': 'interface firmware update tool',
          'response': "Unable to download latest firmware.bin",
          'type': 'error'
        }
        io.sockets.emit('data', output);
      })

      req.end()


    });
  });
})



var firmwareImagePath = path.join(uploadsDir, './firmware.bin');
var spawn = require('child_process').spawn;
const multer = require('multer');
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, uploadsDir);
  },
  // By default, multer removes file extensions so let's add them back
  filename: function(req, file, cb) {
    cb(null, file.fieldname + '-' + new Date().toJSON().replace(new RegExp(':', 'g'), '.') + path.extname(file.originalname));
  }
});

function flashBLOX(data) {
  status.comms.connectionStatus = 6;

  var port = data.port;
  var file = data.file;
  var customImg = data.customImg
  var erase = data.erase

  console.log(__dirname, file, data.file)

  if (customImg == true) {
    var firmwarePath = firmwareImagePath
  } else {
    var firmwarePath = path.join(__dirname, file)
  }



  console.log("Flashing BLOX on " + port + " with file: " + file)

  var data = {
    'port': port,
    'string': "[Starting...]"
  }
  io.sockets.emit("progStatus", data);

  //esptool.exe --chip esp32s3 --port "COM9" --baud 921600  --before default_reset --after hard_reset write_flash
  //-e -z --flash_mode dio --flash_freq 80m --flash_size 4MB
  //0x0 "C:\Users\user\AppData\Local\Temp\arduino\sketches\1D51207397083FCB1C259015BEFF27B0/external_leds.ino.bootloader.bin"
  //0x8000 "C:\Users\user\AppData\Local\Temp\arduino\sketches\1D51207397083FCB1C259015BEFF27B0/external_leds.ino.partitions.bin"
  //0xe000 "C:\Users\user\AppData\Local\Arduino15\packages\esp32\hardware\esp32\2.0.5/tools/partitions/boot_app0.bin"
  //0x10000 "C:\Users\user\AppData\Local\Temp\arduino\sketches\1D51207397083FCB1C259015BEFF27B0/external_leds.ino.bin"

  var esptool_opts = [
    '--chip', 'esp32s3',
    '--port', port,
    '--baud', '921600',
    '--before', 'default_reset',
    '--after', 'hard_reset',
    'write_flash',
    '-z',
    '--flash_mode', 'dio',
    '--flash_freq', 'keep',
    '--flash_size', 'keep',
    '0x0', path.join(__dirname, "./blox-bootloader.bin").replace('app.asar', 'app.asar.unpacked'),
    '0x8000', path.join(__dirname, "./blox-partition-table.bin").replace('app.asar', 'app.asar.unpacked'),
    '0x10000', path.resolve(firmwarePath).replace('app.asar', 'app.asar.unpacked')
  ];

  if (erase == true) {
    esptool_opts.push('--erase-all');
  }

  console.log(esptool_opts);

  if (process.platform == 'linux') {
    //path.join(__dirname, "..", "lib", "resources", "vad.onnx"),
    fs.chmodSync(path.join(__dirname, "./esptool-linux").replace('app.asar', 'app.asar.unpacked'), 0o755);
    var child = spawn(path.join(__dirname, "./esptool-linux").replace('app.asar', 'app.asar.unpacked'), esptool_opts);
  } else if (process.platform == 'win32') {
    var child = spawn(path.join(__dirname, "./esptool.exe").replace('app.asar', 'app.asar.unpacked'), esptool_opts);
  } else if (process.platform == 'darwin') {
    fs.chmodSync(path.join(__dirname, "./esptool-mac").replace('app.asar', 'app.asar.unpacked'), 0o755);
    var child = spawn(path.join(__dirname, "./esptool-mac").replace('app.asar', 'app.asar.unpacked'), esptool_opts);
  }
  trackChildProcess(child, 'esptool (BLOX flash)');




  child.stdout.on('data', function(data) {
    var debugString = data.toString();
    console.log(debugString)
    var data = {
      'port': port,
      'string': debugString
    }
    io.sockets.emit("progStatus", data);
    status.comms.connectionStatus = 6;

  });

  child.stderr.on('data', function(data) {
    var debugString = data.toString();
    console.log(debugString)
    var data = {
      'port': port,
      'string': debugString
    }
    io.sockets.emit("progStatus", data);
    status.comms.connectionStatus = 6;

  });

  child.on('close', (code) => {
    var data = {
      'port': port,
      'string': `[exit:` + code + `]`,
      'code': code
    }
    io.sockets.emit("progStatus", data);
    status.comms.connectionStatus = 0;

  });
}
// end BLOX Programming

function flashInterface(data) {
  status.comms.connectionStatus = 6;

  var port = data.port;
  var file = data.file;
  var erase = data.erase

  console.log("Flashing Interface on " + port + " with file: " + file)
  // var data = {
  //   'port': port,
  //   'string': debugString
  // }
  // io.sockets.emit("progStatus", data);
  //

  //for (let i = 0; i < ports.length; i++) {

  var data = {
    'port': port,
    'string': "[Starting...]"
  }
  io.sockets.emit("progStatus", data);

  var esptool_opts = [
    '--chip', 'esp32',
    '--port', port,
    '--baud', '921600',
    '--before', 'default_reset',
    '--after', 'hard_reset',
    'write_flash',
    '-z',
    '--flash_mode', 'dio',
    '--flash_freq', '80m',
    '--flash_size', 'detect',
    '0xe000', path.join(__dirname, "./boot_app0.bin").replace('app.asar', 'app.asar.unpacked'),
    '0x1000', path.join(__dirname, "./bootloader_qio_80m.bin").replace('app.asar', 'app.asar.unpacked'),
    '0x10000', path.resolve(firmwareImagePath).replace('app.asar', 'app.asar.unpacked'),
    '0x8000', path.join(__dirname, "./firmware.partitions.bin").replace('app.asar', 'app.asar.unpacked')
  ];

  if (erase == true) {
    esptool_opts.push('--erase-all');
  }

  if (process.platform == 'linux') {
    //path.join(__dirname, "..", "lib", "resources", "vad.onnx"),
    fs.chmodSync(path.join(__dirname, "./esptool-linux").replace('app.asar', 'app.asar.unpacked'), 0o755);
    var child = spawn(path.join(__dirname, "./esptool-linux").replace('app.asar', 'app.asar.unpacked'), esptool_opts);
  } else if (process.platform == 'win32') {
    var child = spawn(path.join(__dirname, "./esptool.exe").replace('app.asar', 'app.asar.unpacked'), esptool_opts);
  } else if (process.platform == 'darwin') {
    fs.chmodSync(path.join(__dirname, "./esptool-mac").replace('app.asar', 'app.asar.unpacked'), 0o755);
    var child = spawn(path.join(__dirname, "./esptool-mac").replace('app.asar', 'app.asar.unpacked'), esptool_opts);
  }
  trackChildProcess(child, 'esptool (Interface flash)');




  child.stdout.on('data', function(data) {
    var debugString = data.toString();
    console.log(debugString)
    var data = {
      'port': port,
      'string': debugString
    }
    io.sockets.emit("progStatus", data);
    status.comms.connectionStatus = 6;

  });

  child.stderr.on('data', function(data) {
    var debugString = data.toString();
    console.log(debugString)
    var data = {
      'port': port,
      'string': debugString
    }
    io.sockets.emit("progStatus", data);
    status.comms.connectionStatus = 6;

  });

  child.on('close', (code) => {
    var data = {
      'port': port,
      'string': `[exit:` + code + `]`,
      'code': code
    }
    io.sockets.emit("progStatus", data);
    status.comms.connectionStatus = 0;

  });
}
// end Interface Programming

function flashGrblHal(data) {

  console.log(JSON.stringify(data))

  status.comms.connectionStatus = 6;

  var port = data.port;
  var file = data.file;
  var customImg = data.customImg
  var erase = data.erase

  if (customImg == true) {
    var firmwarePath = firmwareImagePath
  } else {
    var firmwarePath = path.join(__dirname, file)
  }

  console.log("Flashing BlackBoxX32 on " + port + " with file: " + path.resolve(firmwarePath).replace('app.asar', 'app.asar.unpacked'))
  var data = {
    'port': port,
    'string': "[Starting...]"
  }
  io.sockets.emit("progStatus", data);

  var esptool_opts = [
    '--port', port,
    '--baud', '460800',
    '--before', 'default_reset',
    '--after', 'hard_reset',
    '--chip', 'esp32',
    'write_flash',
    '--flash_mode', 'dio',
    '--flash_size', 'detect',
    '--flash_freq', '40m',
    '0x1000', path.join(__dirname, "./grblhal-bootloader.bin").replace('app.asar', 'app.asar.unpacked'),
    '0x8000', path.join(__dirname, "./grblhal-partition-table.bin").replace('app.asar', 'app.asar.unpacked'),
    '0x10000', path.resolve(firmwarePath).replace('app.asar', 'app.asar.unpacked')
  ];

  if (erase == true) {
    esptool_opts.push('--erase-all');
  }

  if (process.platform == 'linux') {
    fs.chmodSync(path.join(__dirname, "./esptool-linux").replace('app.asar', 'app.asar.unpacked'), 0o755);
    var child = spawn(path.join(__dirname, "./esptool-linux").replace('app.asar', 'app.asar.unpacked'), esptool_opts);
  } else if (process.platform == 'win32') {
    var child = spawn(path.join(__dirname, "./esptool.exe").replace('app.asar', 'app.asar.unpacked'), esptool_opts);
  } else if (process.platform == 'darwin') {
    console.log("Running on MacOS")
    fs.chmodSync(path.join(__dirname, "./esptool-mac").replace('app.asar', 'app.asar.unpacked'), 0o755);
    var child = spawn(path.join(__dirname, "./esptool-mac").replace('app.asar', 'app.asar.unpacked'), esptool_opts);
  }
  trackChildProcess(child, 'esptool (grblHAL/BlackBoxX32 flash)');


  child.stdout.on('data', function(data) {
    var debugString = data.toString();
    console.log(debugString)
    var data = {
      'port': port,
      'string': debugString
    }
    io.sockets.emit("progStatus", data);
    status.comms.connectionStatus = 6;

  });

  child.stderr.on('data', function(data) {
    var debugString = data.toString();
    console.log(debugString)
    var data = {
      'port': port,
      'string': debugString
    }
    io.sockets.emit("progStatus", data);
    status.comms.connectionStatus = 6;

  });

  child.on('close', (code) => {
    var data = {
      'port': port,
      'string': `[exit:` + code + `]`,
      'code': code
    }
    io.sockets.emit("progStatus", data);
    status.comms.connectionStatus = 0;

  });
}
// end BlackBoxX32 Programming


// LAN Scanner for BlackBox X32, Interface, SwitchBlox etc //
function scanForTelnetDevices(range) {
  //var localNetwork = ip.address().split('.');
  //var network = localNetwork[0] + '.' + localNetwork[1] + '.' + localNetwork[2];
  //var range = network + ".1-" + network + ".254"

  var networkDevices = []
  oldiplist = status.comms.interfaces.networkDevices;
  const telnetScanOptions = {
    target: range,
    port: '23',
    status: 'TROU', // Timeout, Refused, Open, Unreachable
    banner: true
  };

  var output = {
    'command': 'network',
    'response': "Starting network scan for: " + telnetScanOptions.target,
    'type': 'success'
  }
  io.sockets.emit('data', output);

  new Evilscan(telnetScanOptions, (err, scan) => {

    if (err) {
      var output = {
        'command': 'network',
        'response': "Network Scan error: " + err,
        'type': 'success'
      }
      io.sockets.emit('data', output);
      //console.log(err);
      return;
    }

    scan.on('result', data => {
      // fired when item is matching options
      //console.log(data);
      if (data.status == "open") {
        var type = false;
        if (data.banner.indexOf("GrblHAL") != -1) {
          type = "grblHAL"
        } else if (data.banner.indexOf("Grbl") != -1) {
          type = "grbl"
        }
        networkDevices.push({
          ip: data.ip,
          type: type,
          banner: data.banner
        })
      }

    });

    scan.on('error', err => {
      //throw new Error(data.toString());
    });

    scan.on('done', () => {
      // finished !
      networkDevices.sort((a, b) => {
        return a.ip.split('.')[3] - b.ip.split('.')[3];
      });
      status.comms.interfaces.networkDevices = networkDevices;
      if (!_.isEqual(status.comms.interfaces.networkDevices, oldiplist)) {
        var newTelnetPorts = _.differenceWith(status.comms.interfaces.networkDevices, oldiplist, _.isEqual)
        if (newTelnetPorts.length > 0) {
          debug_log("Detected new device: " + newTelnetPorts[0].ip);
        }
        var removedTelnetPorts = _.differenceWith(oldiplist, status.comms.interfaces.networkDevices, _.isEqual)
        if (removedTelnetPorts.length > 0) {
          debug_log("No longer detecting device: " + removedTelnetPorts[0].ip);
        }
      }
      oldiplist = status.comms.interfaces.networkDevices;
      if (status.comms.interfaces.networkDevices.length > 0) {
        var output = {
          'command': 'network',
          'response': "Network Scan completed. Found " + status.comms.interfaces.networkDevices.length + " devices.  Network addresses added to the Port selection dropdown.",
          'type': 'success'
        }
      } else {
        var output = {
          'command': 'network',
          'response': "Network Scan completed. Found " + status.comms.interfaces.networkDevices.length + " devices",
          'type': 'error'
        }
      }

      io.sockets.emit('data', output);
    });

    scan.run();
  });
}
// end LAN Scanner

// USB port details

function friendlyPort(port) {
  // var likely = false;
  var img = 'usb.png';
  var note = '';
  var manufacturer = port.manufacturer
  if (manufacturer == `(Standard port types)`) {
    img = 'serial.png'
    note = 'Motherboard Serial Port';
  } else if (port.productId && port.vendorId) {
    if (port.productId == '6015' && port.vendorId == '1D50') {
      // found Smoothieboard
      img = 'smoothieboard.png';
      note = 'Smoothieware USB Port (Not Supported)';
    }
    if (port.productId == '6001' && port.vendorId == '0403') {
      // found FTDI FT232
      img = 'usb.png';
      note = 'FTDI USB to Serial';
    }
    if (port.productId == '6015' && port.vendorId == '0403') {
      // found FTDI FT230x
      img = 'usb.png';
      note = 'FTDI USD to Serial';
    }
    if (port.productId == '606D' && port.vendorId == '1D50') {
      // found TinyG G2
      img = 'usb.png';
      note = 'Tiny G2';
    }
    if (port.productId == '003D' && port.vendorId == '2341') {
      // found Arduino Due Prog Port
      img = 'due.png';
      note = 'Arduino Due Prog';
    }
    if (port.productId == '0043' && port.vendorId == '2341' || port.productId == '0001' && port.vendorId == '2341' || port.productId == '0043' && port.vendorId == '2A03') {
      // found Arduino Uno
      img = 'uno.png';
      note = 'Arduino Uno';
    }
    if (port.productId == '2341' && port.vendorId == '0042') {
      // found Arduino Mega
      img = 'mega.png';
      note = 'Arduino Mega';
    }
    if (port.productId == '7523' && port.vendorId == '1A86') {
      // found CH340
      img = 'uno.png';
      note = 'WCH.cn CH340 USB to UART';
    }
    if (port.productId == 'EA60' && port.vendorId == '10C4') {
      // found CP2102
      img = 'silabs.png';
      note = 'Silicon Labs USB to UART';
    }
    if (port.productId == '000A' && port.vendorId == '2E8A') {
      // found CP2102
      img = 'pipico.png';
      note = 'Raspberry Pi Pico CDC UART';
    }
    if (port.productId == '4001' && port.vendorId == '303A') {
      // found CP2102
      img = 'blox.png';
      note = 'OpenBuilds BLOX (with grblHAL)';
    }
    if (port.productId == '1001' && port.vendorId == '303A') {
      // found CP2102
      img = 'blox.png';
      note = 'OpenBuilds BLOX (Alternate Firmware)';
    }
    if (port.productId == '2303' && port.vendorId == '067B') {
      // found CP2102
      // img = 'nodemcu.png';
      note = 'Prolific USB to Serial';
    }
  } else {
    img = "usb.png";
  }

  return {
    img: img,
    note: note
  };
}

// End USB Port details

// System Info on startup

const os = require('os');
const si = require('systeminformation');

var systemInformation;

async function getSystemInfo() {
  // Basic OS and hardware details
  const osType = os.type(); // 'Linux', 'Darwin' (Mac), 'Windows_NT'
  const osPlatform = os.platform(); // 'win32', 'linux', 'darwin', etc.
  const osRelease = os.release(); // OS version
  const arch = os.arch(); // 'x64', 'arm', 'arm64', etc.
  const totalMemory = os.totalmem();
  const networkInterfaces = os.networkInterfaces();
  const cpu = os.cpus();

  // Additional system information using systeminformation
  const [baseboard, graphics, osInfo] = await Promise.all([
    si.baseboard(),
    si.graphics(),
    si.osInfo()
  ]);

  // Prepare systemInformation JSON object
  systemInformation = {
    // The Electron/Chromium/Node build this copy of the app is running on - handy for support
    // requests and to confirm an upgrade actually took effect. Undefined (not sent) if this ever
    // runs outside Electron (there is no such build to report).
    electron: process.versions.electron ? {
      version: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    } : undefined,
    operatingSystem: {
      type: osType,
      platform: osPlatform,
      release: osRelease,
      arch: arch,
      distro: osInfo.distro || "N/A",
      version: osInfo.release || "N/A",
      codename: osInfo.codename || "N/A",
    },
    hardware: {
      cpu: cpu.map(core => ({
        model: core.model,
        speed: core.speed, // in MHz
        times: core.times
      })),
      motherboard: {
        manufacturer: baseboard.manufacturer,
        model: baseboard.model,
        version: baseboard.version,
        serialNumber: baseboard.serial,
      },
      gpu: graphics.controllers.map(gpu => ({
        model: gpu.model,
        vendor: gpu.vendor,
        vram: gpu.vram, // in MB
        bus: gpu.bus
      })),
      memory: {
        total: (totalMemory / 1024 / 1024 / 1024).toFixed(2) + " GB",
        free: (os.freemem() / 1024 / 1024 / 1024).toFixed(2) + " GB",
      },
    },
    network: Object.keys(networkInterfaces).map(iface => ({
      interface: iface,
      addresses: networkInterfaces[iface].map(addr => ({
        address: addr.address,
        family: addr.family,
        internal: addr.internal,
      })),
    })),
  };

  // Timer to update free memory every minute
  setInterval(() => {
    systemInformation.hardware.memory.free = (os.freemem() / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }, 60000); // 60,000 ms = 1 minute

  // Log the initial systemInformation object
  debug_log(JSON.stringify(systemInformation, null, 2));

  // Return the systemInformation object (if needed for further use)
  io.sockets.emit("sysinfo", systemInformation);

  return systemInformation;
}

// Call the function
getSystemInfo().catch(err => console.error("Error retrieving system information:", err));


// End system info on startup

process.on('exit', (code) => {
  debug_log('exit')
  serialLog('info', 'process exit event, code=' + code)
})