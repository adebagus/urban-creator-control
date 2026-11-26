// GRBL Mythos settings $309 / $319 / $329 get names instead of ";unknown".
//
// They come from the firmware's own documentation (GRBL_Mythos AUTOSQUARE.md):
//   $309  auto-square mode: 0 = 4 axes, 1 = the A pin drives the Y2 motor (after a reset)
//   $319  max squaring distance of the second Y side, mm (1-25)
//   $329  Y2 offset after squaring, mm (+-10); positive backs Y2 off - same as grblHAL $171
// Only when the connected firmware IS Mythos (its banner "[GRBL Mythos - ...]", or
// the name in its $I answer): the same numbers can mean something else elsewhere,
// and a static template would also override a grblHAL controller's own names.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSim, BANNER } = require('./helpers/serial-sim');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const ENUM = read('app/js/grbl-settings-enum.js');
const TEMPLATES = read('app/js/grbl-settings-templates.js');
const WS = read('app/js/websocket.js');

function grabDataHandler() {
  const marker = "socket.on('data', function(data) {";
  const start = WS.indexOf(marker);
  const end = WS.indexOf('\n  });\n\n  socket.on("grbl"', start);
  assert.ok(start !== -1 && end !== -1, 'cannot find the client data handler');
  return '(' + WS.slice(start + "socket.on('data', ".length, end + '\n  }'.length) + ')';
}

function jq() {
  const chain = new Proxy(function() {}, {
    get(_, name) {
      if (name === 'length') return 0;
      if (name === 'attr' || name === 'is' || name === 'val' || name === 'data') return () => undefined;
      return () => chain;
    },
  });
  return chain;
}

// variant: what the server put in status.machine.firmware.variant
function client(variant) {
  const logs = [];
  const ctx = {
    console,
    isJogWidget: false,
    laststatus: { machine: { firmware: { variant, platform: 'gnea' } } },
    sendGcode() {},
    printLogModern: (icon, source, string) => logs.push(string),
    escapeHTML: (s) => String(s),
    grblSettings() {},
    grblPopulate() {},
    setTimeout() {},
    $: () => jq(),
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => null },
  };
  vm.createContext(ctx);
  vm.runInContext(TEMPLATES, ctx);
  vm.runInContext(ENUM, ctx);
  const handler = vm.runInContext(grabDataHandler(), ctx);
  return { ctx, logs, line: (command, response) => handler({ command, response, type: 'info' }) };
}

test('Mythos: the $$ dump names $309/$319/$329 instead of ";unknown"', () => {
  const c = client('mythos');
  c.line('$$', '$309=1');
  c.line('$$', '$319=5.000');
  c.line('$$', '$329=0.000');
  assert.ok(c.logs.some((l) => l.includes('$309=1') && l.includes('Auto-square mode')), JSON.stringify(c.logs));
  assert.ok(c.logs.some((l) => l.includes('$319=5.000') && l.includes('max squaring distance')));
  assert.ok(c.logs.some((l) => l.includes('$329=0.000') && l.includes('Y2 offset') && l.includes('$171')));
  assert.ok(!c.logs.some((l) => /;unknown/.test(l)), JSON.stringify(c.logs));
});

test('not Mythos (plain Grbl / grblHAL without $ES): the same numbers stay ";unknown", exactly as before', () => {
  const c = client('');
  c.line('$$', '$309=1');
  assert.ok(c.logs.some((l) => l.includes('$309=1') && /;unknown/.test(l)), JSON.stringify(c.logs));
});

test('a grblHAL controller\'s own $ES definition is used, never the Mythos one', () => {
  const c = client('');
  c.ctx.grblEnum.settings['309'] = { id: 309, name: 'Something else entirely', unit: '', type: 6, format: '', min: '', max: '', reboot: false };
  assert.equal(c.ctx.grblSettingName('309'), 'Something else entirely');
});

test('static templates still come first (e.g. $341 stays "Tool Change Mode" on Mythos)', () => {
  const c = client('mythos');
  assert.equal(c.ctx.grblSettingName('341'), 'Tool Change Mode');
});

test('Advanced Settings row for $309 on Mythos: name, the 0/1 meaning, and "restart the controller after saving"; same input id as before', () => {
  const c = client('mythos');
  const row = c.ctx.grblEnumRowHtml('$309', '309', '1');
  assert.match(row, /Auto-square mode \(dual Y\)/);
  assert.match(row, /0 = 4 axes \(A is its own axis\), 1 = A pin drives the Y2 motor/);
  assert.match(row, /restart the controller after saving/);
  assert.match(row, /id="val-309-input"/);
});

test('Advanced Settings rows for $319/$329 on Mythos: mm, and their ranges', () => {
  const c = client('mythos');
  const r319 = c.ctx.grblEnumRowHtml('$319', '319', '5');
  assert.match(r319, /range 1 to 25/);
  assert.match(r319, /data-append="mm"/);
  const r329 = c.ctx.grblEnumRowHtml('$329', '329', '0');
  assert.match(r329, /range -10 to 10/);
  assert.match(r329, /positive backs Y2 off, same as grblHAL \$171/);
});

test('not Mythos: the $309 row is the unchanged plain row (red key, "?" input)', () => {
  const c = client('');
  const row = c.ctx.grblEnumRowHtml('$309', '309', '1');
  assert.match(row, /tally alert/);
  assert.match(row, /data-append="\?"/);
});

// --- the server marks the firmware variant ------------------------------------

test('server: the Mythos banner marks the firmware as "mythos"; a plain Grbl banner does not', () => {
  const sim = createSim();
  sim.rx(BANNER);
  assert.equal(sim.ctx.status.machine.firmware.variant, 'mythos');
  sim.rx("Grbl 1.1h ['$' for help]");
  assert.equal(sim.ctx.status.machine.firmware.variant, '');
});

test('server: the $I name says it too (a native-USB board may never print its banner), and a disconnect clears it', () => {
  const sim = createSim();
  sim.rx('[VER:1.1f.20261126.53AS.4A-AS:Grbl Mythos ]');
  assert.equal(sim.ctx.status.machine.firmware.variant, 'mythos');
  sim.ctx.port.isOpen = false;
  sim.ctx.stopPort();
  assert.equal(sim.ctx.status.machine.firmware.variant, '');
});
