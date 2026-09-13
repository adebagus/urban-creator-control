// P7 regression tests: minimal browser-globals sandbox for loading real
// app/js/*.js files with node:vm and exercising their pure logic directly -
// no Electron, no real DOM, no hardware. This runs the ACTUAL shipped source
// (not a re-implementation copied into the test), so the tests stay honest
// about what the app really does.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Very small jQuery-alike. Supports exactly the methods the files under test
// call, and records every call so tests can assert on them (e.g. "was
// #val-45-input ever touched?"). Not a jQuery replacement - deliberately
// narrow, extend only if a new test needs another method.
function createJqueryStub() {
  const values = {}; // selector -> last value passed to .val()
  const calls = []; // { selector, method, args }
  const handlers = {}; // selector -> { eventName: [handler, ...] }

  function record(selector, method, args) {
    calls.push({ selector, method, args });
  }

  function $(selector) {
    const api = {
      val(v) {
        if (arguments.length === 0) return values[selector];
        record(selector, 'val', [v]);
        values[selector] = v;
        return api;
      },
      prop(name, v) {
        record(selector, 'prop', [name, v]);
        return api;
      },
      addClass(c) {
        record(selector, 'addClass', [c]);
        return api;
      },
      removeClass(c) {
        record(selector, 'removeClass', [c]);
        return api;
      },
      is() {
        return false;
      },
      html(v) {
        record(selector, 'html', [v]);
        return api;
      },
      hide() {
        return api;
      },
      show() {
        return api;
      },
      blur() {
        return api;
      },
      click() {
        return api;
      },
      on(events, handler) {
        record(selector, 'on', [events]);
        String(events)
          .split(' ')
          .forEach((evt) => {
            if (!handlers[selector]) handlers[selector] = {};
            if (!handlers[selector][evt]) handlers[selector][evt] = [];
            handlers[selector][evt].push(handler);
          });
        return api;
      },
      trigger(evt, evObj) {
        const fns = (handlers[selector] && handlers[selector][evt]) || [];
        fns.forEach((fn) => fn.call(api, evObj || {}));
        return api;
      },
      data() {
        return { val() {} };
      },
      empty() {
        return api;
      },
      append() {
        return api;
      },
      ready() {
        // Deliberately a no-op: the $(document).ready(...) blocks in these
        // files wire up hundreds of DOM event bindings we don't need for
        // logic tests, and every function this test suite calls is a
        // top-level function declaration (hoisted, defined regardless of
        // whether the ready callback ever runs).
        return api;
      },
    };
    return api;
  }

  $.calls = calls;
  $.values = values;
  $.callsFor = (selector) => calls.filter((c) => c.selector === selector);
  $.wasTouched = (selector) => calls.some((c) => c.selector === selector);

  return $;
}

function createLocalStorageStub() {
  let store = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
  };
}

function createSocketStub() {
  const emitted = [];
  return {
    emit: (event, data) => emitted.push({ event, data }),
    emitted,
  };
}

/**
 * Loads a real app/js/*.js file into an isolated vm context with minimal
 * browser-global stubs, and returns the context (so tests can read/call any
 * top-level var/function the file declares) plus the stubs used, for
 * assertions.
 *
 * @param {string} relativeFilePath e.g. 'app/js/jog.js'
 * @param {object} extraGlobals additional globals the file needs (e.g.
 *   grblParams, laststatus, unit) - merged over the defaults.
 */
function loadAppScript(relativeFilePath, extraGlobals = {}) {
  const fullPath = path.join(__dirname, '..', '..', relativeFilePath);
  const source = fs.readFileSync(fullPath, 'utf8');

  const $ = createJqueryStub();
  const localStorage = createLocalStorageStub();
  const socket = createSocketStub();

  const sandbox = {
    $,
    jQuery: $,
    localStorage,
    socket,
    console,
    sendGcode: (gcode) => socket.emit('runCommand', gcode),
    grblParams: {},
    laststatus: {
      machine: {
        firmware: { platform: '', type: 'grbl' },
        position: {
          offset: { x: 0, y: 0, z: 0 },
          work: { x: 0, y: 0, z: 0 },
        },
      },
      comms: { runStatus: 'Idle', connectionStatus: 2 },
    },
    unit: 'mm',
    waitingForStatus: false,
    printLog: () => {},
    // P8: app/js/jog.js's tap-vs-hold upgrade timer needs real timers - use
    // Node's own (this file runs outside the vm sandbox, in the same
    // process, so they're the real thing, not a fake/instant stand-in).
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    Metro: { toast: { create: () => () => {} } },
    document: {
      activeElement: { blur: () => {} },
      getElementById: () => ({ select: () => {} }),
    },
    ...extraGlobals,
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: fullPath });

  return { context, $, localStorage, socket };
}

module.exports = { loadAppScript, createJqueryStub, createLocalStorageStub, createSocketStub };
