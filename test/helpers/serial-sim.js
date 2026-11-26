'use strict';
// Serial-line simulator for the sender's pairing logic.
//
// index.js cannot be require()d (it boots Electron and the servers), so this
// runs the REAL code extracted from its source text in a vm sandbox:
//   - the serial port's parser.on("data", ...) handler (every reply line),
//   - the queue functions (send1Q, addQToEnd, machineSend, ...),
//   - the socket handlers a user drives (runCommand, resetMachine, clearAlarm,
//     jog, ...),
// against MockGrbl, a scripted controller whose replies copy the real board's
// format (D:\GRBL_Mythos\bench_a0_log.txt, firmware 53AS): the banner text,
// the $I lines, and the order of lines on a hard limit (the board resets
// itself and prints its banner BEFORE "ALARM:1").
//
// The controller model only answers when a test calls grbl.answer(), so a
// test decides exactly what is "in flight" when something else happens - the
// window every bench finding lived in. A soft reset (0x18) wipes whatever the
// controller had received but not yet answered, exactly like the firmware.
//
// Functions that do not exist yet in index.js are skipped (not an error), so
// the same scenario test can be run against the code BEFORE a fix and shown
// to fail on behaviour rather than on harness setup.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createJobRecovery } = require('../../jobRecovery');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

const BANNER = "Grbl 1.1f [GRBL Mythos - CNC Urban Creator 2026]['$' for help]";
const UNLOCK_MSG = "[MSG:'$H'|'$X' to unlock]";
const CTRL_X = String.fromCharCode(0x18);

function grab(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start === -1) return null;
  const end = SRC.indexOf('\n}\n', start);
  if (end === -1) throw new Error('cannot find the end of function ' + name);
  return SRC.slice(start, end + 2);
}
function grabSocketHandler(event) {
  const marker = "socket.on('" + event + "', function(";
  const start = SRC.indexOf(marker);
  if (start === -1) return null;
  const fnStart = start + ("socket.on('" + event + "', ").length;
  const end = SRC.indexOf('\n  });', fnStart);
  return '(' + SRC.slice(fnStart, end + '\n  }'.length) + ')';
}
function grabDataHandler() {
  const marker = 'parser.on("data", function(data) {';
  const start = SRC.indexOf(marker);
  if (start === -1) throw new Error('cannot find the serial data handler');
  const fnStart = start + 'parser.on("data", '.length;
  const end = SRC.indexOf('}); // end of parser.on(data)', start);
  if (end === -1) throw new Error('cannot find the end of the serial data handler');
  return '(' + SRC.slice(fnStart, end + 1) + ')';
}
function grabVar(re) {
  const m = SRC.match(re);
  return m ? m[0] : '';
}

const FUNCTIONS = [
  'BufferSpace', 'send1Q', 'addQToEnd', 'addQRealtime', 'machineSend', 'parseFeedback',
  'announceJobStopped', 'stop', 'runJob', 'pause', 'unpause', 'stopPort',
  // added by the reliability work - skipped when absent (pre-fix code)
  'resetSenderState', 'resetController', 'isRealtimeCommand', 'dropUnsentLines', 'reportDroppedLines',
  'commandRejection', 'rejectCommand', 'onAlarmReported', 'onFirmwareBanner', 'isSpontaneousMessage',
  'parseVersionLine',
];
const SOCKET_HANDLERS = ['runCommand', 'resetMachine', 'clearAlarm', 'jog', 'jogXY', 'jogTo', 'closePort'];
const VARS = [
  /var modalCommands = \[[^\]]*\]\n/, /var modalCommandsRegExp = [^\n]*\n/,
  /var GRBL_RX_BUFFER_SIZE = [^\n]*\n/, /var GRBLHAL_RX_BUFFER_SIZE = [^\n]*\n/,
  /var ALARM_ANSWER_TIMEOUT_MS = [^\n]*\n/, /var SPONTANEOUS_MESSAGES = [^\n]*\n/,
].map(grabVar).join('');

function isRealtimeByte(s) {
  return s.length === 1 && ('?!~'.includes(s) || s === CTRL_X || s.charCodeAt(0) >= 0x80);
}

class MockGrbl {
  constructor(sim) {
    this.sim = sim;
    this.inbox = []; // received, not yet answered: {kind:'line', text} | {kind:'reset'}
    this.alarm = false;
    this.rules = [];
    this.realtime = [];
  }

  // Byte by byte, like the firmware's serial ISR: a realtime byte is picked
  // out wherever it appears - also inside a written line (the old Restart
  // path wrote "\x18\n") - and ctrl-x resets on arrival, flushing everything
  // received but not yet answered, including the rest of this write.
  receive(s) {
    let line = '';
    for (const ch of s) {
      if (ch === CTRL_X) {
        this.inbox = [{ kind: 'reset' }];
        return;
      }
      if (isRealtimeByte(ch)) {
        this.realtime.push(ch);
      } else if (ch === '\n') {
        this.inbox.push({ kind: 'line', text: line });
        line = '';
      } else {
        line += ch;
      }
    }
  }

  // Answer up to n received items in arrival order (default: everything).
  answer(n = Infinity) {
    while (n-- > 0 && this.inbox.length) {
      const item = this.inbox.shift();
      if (item.kind === 'reset') {
        this.sim.rx(BANNER);
        if (this.alarm) this.sim.rx(UNLOCK_MSG);
      } else {
        for (const r of this.reply(item.text)) this.sim.rx(r);
      }
    }
  }

  // on(/A10/, ['[MSG:A is Y2 ($309=1): A10.000]', 'error:33'])
  on(re, replies) {
    this.rules.push([re, replies]);
    return this;
  }

  reply(line) {
    for (const [re, r] of this.rules) {
      if (re.test(line)) return typeof r === 'function' ? r(line, this) : r;
    }
    const up = line.toUpperCase();
    if (up === '') return ['ok'];
    if (up === '$X') {
      this.alarm = false;
      return ['[MSG:Caution: Unlocked]', 'ok'];
    }
    if (up === '$H') {
      this.alarm = false;
      return ['ok'];
    }
    if (this.alarm && (up[0] !== '$' || up.startsWith('$J='))) return ['error:9'];
    if (up === '$G') return ['[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]', 'ok'];
    if (up === '$I') return ['[VER:1.1f.20261126.53AS.4A-AS:Grbl Mythos ]', '[OPT:VML,35,253]', 'ok'];
    return ['ok'];
  }

  // bench_a0_log.txt 20:22:37 - a hard limit: the board resets itself (its RX
  // buffer is gone) and prints its banner before the alarm.
  hardLimit() {
    this.inbox = [];
    this.alarm = true;
    for (const l of ['[MSG:Check Limits]', BANNER, UNLOCK_MSG, 'ALARM:1', '[MSG:Reset to continue]']) this.sim.rx(l);
  }
}

function createSim(opts = {}) {
  const wire = [];
  const log = [];
  const events = [];
  let now = 0;
  let nextTimerId = 1;
  const timers = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-serial-sim-'));

  const sim = { wire, log, events };
  const grbl = new MockGrbl(sim);
  sim.grbl = grbl;

  const ctx = {
    gcodeQueue: [], sentBuffer: [], queuePointer: 0, queueCounter: null, statusLoop: null,
    jobStartTime: false, jobCompletedMsg: '', laserTestOn: false, fluidncConfig: '', uploadedgcode: '',
    jogWindow: null, oldpinslist: [], echoNextStatusReport: false,
    controllerReady: opts.controllerReady === undefined ? true : opts.controllerReady,
    alarmActive: false, alarmPendingAnswers: 0, alarmAnswerTimer: null,
    xPos: 0, yPos: 0, zPos: 0, aPos: 0, xOffset: 0, yOffset: 0, zOffset: 0, aOffset: 0,
    config: { posDecimals: 3, grblWaitTime: 1 },
    status: {
      comms: { connectionStatus: 2, runStatus: 'Idle', queue: 0, blocked: false, paused: false, alarm: '', interfaces: { type: 'usb' } },
      interface: { connected: false, firmware: { availVersion: 0 } },
      machine: {
        name: '', has4thAxis: false, inputs: [], overrides: {}, probe: {}, modals: {}, tool: { nexttool: {} },
        position: { work: {}, offset: {} },
        firmware: { type: 'grbl', platform: 'gnea', version: '1.1f', date: '', rxBufferSize: 253, blockBufferSize: 35, buffer: [], features: [] },
      },
    },
    port: {
      isOpen: true, path: 'COM9',
      write(s) { wire.push(s); grbl.receive(s); },
      drain(cb) { cb(); }, close(cb) { this.isOpen = false; if (cb) cb(); },
    },
    io: {
      sockets: {
        emit(ev, d) {
          events.push([ev, d]);
          if (ev === 'data') log.push({ command: d.command || '', response: String(d.response), type: d.type });
        },
      },
    },
    grblStrings: { alarms: (c) => 'alarm text ' + c, errors: (c) => 'error text ' + c },
    debug_log() {}, serialLog() {}, console: { log() {} },
    _: { isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
    gotModals() {},
    setTimeout(fn, ms) { const id = nextTimerId++; timers.push({ id, at: now + (ms || 0), fn }); return id; },
    clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i !== -1) timers.splice(i, 1); },
    setInterval() { return nextTimerId++; },
    clearInterval() {},
  };
  ctx.jobRecovery = createJobRecovery({
    getDir: () => dir, autoTimer: false, writeIntervalMs: 0,
    getFirstUnackedQ: () => (ctx.gcodeQueue.length === 0 ? -1 : Math.max(0, ctx.queuePointer - ctx.sentBuffer.length)),
    getPlannerBlocks: () => 35,
  });
  vm.createContext(ctx);
  vm.runInContext(VARS + FUNCTIONS.map(grab).filter(Boolean).join('\n'), ctx);
  const handlers = {};
  for (const ev of SOCKET_HANDLERS) {
    const src = grabSocketHandler(ev);
    if (src) handlers[ev] = vm.runInContext(src, ctx);
  }
  const onData = vm.runInContext(grabDataHandler(), ctx);

  Object.assign(sim, {
    ctx, handlers,
    rx(line) { onData(line); },
    type(cmd) { handlers.runCommand(cmd); },
    restart() { handlers.runCommand(CTRL_X); }, // what the ribbon's Restart / Restart Grbl buttons send
    advance(ms) {
      now += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > now) break;
        timers.shift().fn();
      }
    },
    // the log lines whose response starts with `prefix`, as "[label] response"
    logged(prefix) {
      return log.filter((l) => l.response.startsWith(prefix)).map((l) => '[' + l.command + '] ' + l.response);
    },
    eventsOf(name) { return events.filter((e) => e[0] === name).map((e) => e[1]); },
    state() {
      return {
        gcodeQueue: [...ctx.gcodeQueue], queuePointer: ctx.queuePointer, sentBuffer: [...ctx.sentBuffer],
        blocked: ctx.status.comms.blocked, paused: ctx.status.comms.paused, connectionStatus: ctx.status.comms.connectionStatus,
      };
    },
    unsent() { return ctx.gcodeQueue.length - ctx.queuePointer; },
  });
  return sim;
}

module.exports = { createSim, BANNER, UNLOCK_MSG, CTRL_X, SRC };
