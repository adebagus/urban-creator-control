// grblHAL settings enumeration ($ES) - app/js/grbl-settings-enum.js, wired into websocket.js and grbl-settings.js.
//
// Settings the static templates do not know ($160-$162 backlash, $485, $539, $676, $680, ...) used to show as
// ";unknown". When the firmware is grblHAL AND its $I answer lists ENUMS, the sender now asks `$ES` once and names
// them from the answer. THE SAFETY RULE under test: `$ES` is NEVER sent to any other firmware (an unsupported
// command answers error:3, which puts the sender into its error state) - the check is before the send.
// The real files run in a vm with fakes for the socket / DOM; the templates are the real, static ones.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const ENUM = read('app/js/grbl-settings-enum.js');
const TEMPLATES = read('app/js/grbl-settings-templates.js');
const WS = read('app/js/websocket.js');
const SETTINGS = read('app/js/grbl-settings.js');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot find function ' + name);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1);
  return src.slice(start, end + 2);
}

// The 'data' handler of websocket.js as a function expression.
function grabDataHandler() {
  const marker = "socket.on('data', function(data) {";
  const start = WS.indexOf(marker);
  assert.notEqual(start, -1, 'cannot find the data handler');
  const end = WS.indexOf('\n  });\n\n  socket.on("grbl"', start);
  assert.notEqual(end, -1, 'cannot find its end');
  return '(' + WS.slice(start + "socket.on('data', ".length, end + '\n  }'.length) + ')';
}

// A jQuery stand-in: every method exists and chains; a few answer with values (overrides: {length, attr, is}).
function jq(over = {}) {
  const chain = new Proxy(function() {}, {
    get(_, name) {
      if (name in over) return over[name];
      if (name === 'length') return 0;
      if (name === 'attr' || name === 'is' || name === 'val' || name === 'data') return () => undefined;
      return () => chain;
    },
  });
  return chain;
}

// Everything the real code touches, faked. opts.jog: the phone jog page.
function boot(opts = {}) {
  const env = { sent: [], logs: [], settingsFed: [], populated: 0, timers: [] };
  const ctx = {
    console,
    isJogWidget: !!opts.jog,
    sendGcode: (g) => env.sent.push(g),
    printLogModern: (icon, source, string) => env.logs.push({ source, string }),
    escapeHTML: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    grblSettings: (d) => env.settingsFed.push(d),
    grblPopulate: () => { env.populated++; },
    setTimeout: (fn) => { env.timers.push(fn); return env.timers.length; },
    $: () => jq(),
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => null },
  };
  vm.createContext(ctx);
  vm.runInContext(TEMPLATES, ctx);
  vm.runInContext(ENUM, ctx);
  vm.runInContext(extractFunction(WS, 'showGrbl'), ctx);
  ctx.handler = vm.runInContext(grabDataHandler(), ctx);
  env.ctx = ctx;
  env.run = (code) => vm.runInContext(code, ctx);
  // the controller connects: showGrbl(true, firmware) - only the platform matters here
  env.connect = (platform) => ctx.showGrbl(true, { platform });
  env.disconnect = () => ctx.showGrbl(false, false);
  // one line of a controller answer, as the server broadcasts it: {command: what was asked, response: the line}
  env.line = (command, response) => ctx.handler({ command, response, type: 'info' });
  env.newopt = (list) => env.line('$I', '[NEWOPT:' + list + ']');
  env.enumerated = () => env.run('JSON.stringify(grblEnum.settings)');
  return env;
}

const S160 = '[SETTING:160|3|X-axis backlash compensation|mm|6|#0.000|0|]';
const SAMPLE = [
  '[SETTING:0|18|Step pulse time|microseconds|6|#0.0|2.0|]',
  S160,
  '[SETTING:161|3|Y-axis backlash compensation|mm|6|#0.000|0|]',
  '[SETTING:485|16|Keep tool number over reboot|||0||||]',
  '[SETTING:539|2|Spindle off delay|ms|5|###0|0|65535|0|0]',
  '[SETTING:676|1|Reset actions||1|Clear homed state,Clear offsets,N/A,Clear tool|||0|]',
  '[SETTING:680|1|Stepper enable delay|ms|5|###0|0|1000|1|]',
];
const answerES = (env, lines = SAMPLE) => { lines.forEach((l) => env.line('$ES', l)); env.line('$ES', 'ok'); };

// --------------------------------------------------------------------------- parsing

test('parse: the documented example line', () => {
  const s = boot().ctx.grblEnumParseSetting('[SETTING:0|18|Step pulse time|microseconds|6|#0.0|2.0|]');
  assert.deepEqual(JSON.parse(JSON.stringify(s)), { id: 0, group: 18, name: 'Step pulse time', unit: 'microseconds', type: 6, format: '#0.0', min: '2.0', max: '', reboot: false, nullAllowed: false });
});

test('parse: optional trailing fields, reboot flag, null-allowed flag, bit-field labels with commas', () => {
  const p = boot().ctx.grblEnumParseSetting;
  assert.equal(p('[SETTING:5|1|Limit invert||1|X,Y,Z]').format, 'X,Y,Z');
  const full = p('[SETTING:539|2|Spindle off delay|ms|5|###0|0|65535|1|1]');
  assert.equal(full.reboot, true);
  assert.equal(full.nullAllowed, true);
  assert.equal(full.max, '65535');
  const bare = p('[SETTING:12|1|Arc tolerance]');
  assert.equal(bare.name, 'Arc tolerance');
  assert.equal(bare.type, null);
});

test('parse: anything that is not a usable setting line is refused', () => {
  const p = boot().ctx.grblEnumParseSetting;
  for (const bad of ['', 'ok', '[SETTINGGROUP:1|0|General]', '[SETTING:]', '[SETTING:abc|1|x]', '[SETTING:-1|1|x]', '[SETTING:123456|1|x]', '$0=10', null, undefined, 5, '[NEWOPT:ENUMS]']) {
    assert.equal(p(bad), null, String(bad));
  }
});

test('parse: control characters and huge text are cleaned, a bad type code is ignored', () => {
  const p = boot().ctx.grblEnumParseSetting;
  const s = p('[SETTING:7|1|na\u0000me\u0007|un\nit|x|' + 'y'.repeat(5000) + ']');
  assert.equal(s.name, 'na me');
  assert.ok(!/[\u0000-\u001f]/.test(s.unit));
  assert.equal(s.type, null);
  assert.equal(s.format.length, 4000, 'the format (label list) has its own, larger bound');
  const long = p('[SETTING:8|1|' + 'n'.repeat(500) + '|' + 'u'.repeat(500) + '|5||' + '1'.repeat(500) + '|' + '9'.repeat(500) + ']');
  assert.equal(long.name.length, 200);
  assert.equal(long.unit.length, 200);
  assert.equal(long.min.length, 200);
  assert.equal(long.max.length, 200);
});

// --------------------------------------------------------------------------- forward compatibility (grblHAL sender guide:
// "ignore unknown tag values", "ignore unknown tags", "expect comma separated value lists to get additional values")

test('extra fields at the END of a setting line are ignored: one, many, empty, or containing brackets', () => {
  const p = boot().ctx.grblEnumParseSetting;
  const base = '[SETTING:539|2|Spindle off delay|ms|5|###0|0|65535|1|1';
  const expected = JSON.parse(JSON.stringify(p(base + ']')));
  assert.equal(expected.name, 'Spindle off delay');
  assert.equal(expected.reboot, true);
  for (const tail of ['|new', '|a|b|c', '||||', '|x[y]z', '|1|2|3|4|5|6|7|8|9|10', '|éè', '| ']) {
    assert.deepEqual(JSON.parse(JSON.stringify(p(base + tail + ']'))), expected, JSON.stringify(tail));
  }
});

test('extra fields after a SHORT line still leave the missing optional fields empty', () => {
  const p = boot().ctx.grblEnumParseSetting;
  const s = p('[SETTING:12|1|Arc tolerance|mm|6|#0.000|0.001|extra]');
  assert.equal(s.min, '0.001');
  assert.equal(s.max, 'extra', 'positional, as documented: an early extra is the next field, only trailing ones are new');
  assert.equal(s.reboot, false);
});

test('a data type code outside 0-9 (or not a number) means "plain input", never an error', () => {
  const p = boot().ctx.grblEnumParseSetting;
  for (const code of ['10', '12', '99', '-1', 'x', '', ' ', '5x', '1.5']) {
    const s = p('[SETTING:9|1|Name|u|' + code + '|fmt|0|5]');
    assert.ok(s, JSON.stringify(code));
    assert.equal(s.type, null, JSON.stringify(code));
    assert.equal(s.name, 'Name');
  }
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  e.line('$ES', '[SETTING:709|1|Future kind|x|42|whatever|0|9]');
  e.line('$ES', 'ok');
  const row = e.ctx.grblEnumRowHtml('$709', '709', '3');
  assert.ok(row.includes('Future kind') && row.includes('id="val-709-input"') && row.includes('type="text"'));
  assert.ok(row.includes('type="text"'));
});

test('a label list with 40 entries stays whole - none cut, none cut in the middle', () => {
  const e = boot();
  const labels = Array.from({ length: 40 }, (_, i) => 'Label number ' + i);
  e.connect('grblHAL');
  e.newopt('ENUMS');
  e.line('$ES', '[SETTING:710|1|Many bits||1|' + labels.join(',') + '|||0|]');
  e.line('$ES', 'ok');
  const parsed = JSON.parse(e.enumerated())['710'];
  assert.ok(parsed.format.length > 200, 'longer than the old 200 character cut');
  assert.equal(e.ctx.grblEnumLabels(parsed.format).length, 40);
  const row = e.ctx.grblEnumRowHtml('$710', '710', '0');
  assert.ok(row.includes('bit 0 = Label number 0'));
  assert.ok(row.includes('bit 39 = Label number 39'), 'the last bit is still there');
  for (let i = 0; i < 40; i++) assert.ok(row.includes('bit ' + i + ' = Label number ' + i), 'label ' + i + ' whole');
  assert.ok(!row.includes('bit 40'), 'and nothing invented');
});

test('a list that grows: more labels than the firmware had before are all shown (radio buttons too)', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  e.line('$ES', '[SETTING:711|1|Mode||3|Off,On,Auto,N/A,Extra one,Extra two,Brand new option]');
  e.line('$ES', 'ok');
  const row = e.ctx.grblEnumRowHtml('$711', '711', '0');
  for (const t of ['0 = Off', '1 = On', '2 = Auto', '4 = Extra one', '5 = Extra two', '6 = Brand new option']) assert.ok(row.includes(t), t);
  assert.ok(!row.includes('3 = N/A') && !row.includes('N/A'));
});

test('unknown tag lines in the middle of the $ES answer are consumed silently - not printed, not counted; the settings around them are kept', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  e.logs.length = 0;
  e.line('$ES', S160);
  e.line('$ES', '[SETTINGGROUP:1|0|General]');
  e.line('$ES', '[SOMENEWTAG:a|b|c]');
  e.line('$ES', '[MSG:something new]');
  e.line('$ES', '[SETTING:161|3|Y-axis backlash compensation|mm|6|#0.000|0|]');
  e.line('$ES', 'ok');
  assert.deepEqual(Object.keys(JSON.parse(e.enumerated())).sort(), ['160', '161']);
  assert.equal(e.logs.length, 1, 'only the one summary line reached the console: ' + JSON.stringify(e.logs.map((l) => l.string)));
  assert.match(e.logs[0].string, /Read 2 setting definitions/);
});

test('"ok" and errors are still handled as before; a line that is not a tag is still left to the normal path', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  const eat = (resp) => e.ctx.grblEnumHandleData({ command: '$ES', response: resp });
  assert.equal(eat('some plain text'), false, 'only lines starting with [ are swallowed');
  assert.equal(eat('[FUTURE:1]'), true);
  assert.equal(e.run('grblEnum.collecting'), true, 'still collecting');
  assert.equal(eat('ok'), true);
  assert.equal(e.run('grblEnum.collecting'), false);
  const err = boot();
  err.connect('grblHAL');
  err.newopt('ENUMS');
  assert.equal(err.ctx.grblEnumHandleData({ command: '$ES', response: 'error:3' }), false);
  assert.equal(err.run('grblEnum.collecting'), false);
});

test('unknown tags are swallowed ONLY during our own $ES answer - anywhere else they print as before', () => {
  const idle = boot();
  idle.line('$ES', '[FUTURE:1]');
  assert.equal(idle.logs.length, 1, 'not collecting: printed');
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  answerES(e);
  e.logs.length = 0;
  e.line('$I', '[FUTURE:1]'); // another command
  e.line('$ES', '[FUTURE:2]'); // the answer is over
  assert.equal(e.logs.length, 2);
});

test('NEWOPT stays strict: only the exact ENUMS token counts, whatever else is listed (ENUMS=1 and friends are NOT accepted)', () => {
  const h = boot().ctx.grblEnumHasEnums;
  assert.equal(h('[NEWOPT:ENUMS=1,ES]'), false);
  assert.equal(h('[NEWOPT:ENUMS=0]'), false);
  assert.equal(h('[NEWOPT:ENUMS:1]'), false);
  assert.equal(h('[NEWOPT:ENUMS2]'), false);
  assert.equal(h('[NEWOPT:NEW1,ENUMS,NEW2=3,ES,SED,XYZ]'), true, 'unknown tokens around it are ignored');
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS=1,ES,SED');
  assert.deepEqual(e.sent, []);
});

// --------------------------------------------------------------------------- capability detection

test('ENUMS is detected as an exact token; "ES" (e-stop) and look-alikes are NOT it', () => {
  const h = boot().ctx.grblEnumHasEnums;
  assert.equal(h('[NEWOPT:ENUMS,RT+,ES,TC,SED]'), true);
  assert.equal(h('[NEWOPT:ES,TC,SED]'), false, 'ES alone is the e-stop signal');
  assert.equal(h('[NEWOPT:RT+,ENUMS]'), true);
  assert.equal(h('[NEWOPT:ENUMS]'), true);
  for (const bad of ['[NEWOPT:ENUMSX]', '[NEWOPT:XENUMS]', '[NEWOPT:enums]', '[NEWOPT:]', '[NEWOPT:SED,ES]', '[OPT:ENUMS]', 'ENUMS', '', null, undefined, '[NEWOPT:ATC=ENUMS]']) {
    assert.equal(h(bad), false, String(bad));
  }
});

// --------------------------------------------------------------------------- THE SAFETY RULE: when $ES may be sent

test('grblHAL + ENUMS: $ES is sent exactly once', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS,RT+,ES,TC,SED');
  assert.deepEqual(e.sent, ['$ES']);
});

test('NEVER SENT to other firmware, even when the $I answer says ENUMS: gnea Grbl, FluidNC, plain grbl, unknown, empty', () => {
  for (const platform of ['gnea', 'FluidNC', 'grbl', 'Grbl', 'grblhal', 'GRBLHAL', 'smoothie', 'unknown', '', undefined, null, 'grblHAL ']) {
    const e = boot();
    e.connect(platform);
    e.newopt('ENUMS,RT+,ES,TC,SED');
    assert.deepEqual(e.sent, [], 'platform ' + JSON.stringify(platform));
    assert.equal(e.run('grblEnum.requested'), false);
  }
});

test('NEVER SENT to grblHAL that does not list ENUMS: only ES, no NEWOPT line at all, an [OPT:] line, or ENUMS-like words', () => {
  for (const list of ['ES,TC,SED', 'RT+', '', 'ENUMSX', 'enums', 'SED']) {
    const e = boot();
    e.connect('grblHAL');
    e.newopt(list);
    assert.deepEqual(e.sent, [], JSON.stringify(list));
  }
  const e = boot();
  e.connect('grblHAL');
  e.line('$I', '[VER:1.1f.20260923:]');
  e.line('$I', '[OPT:VNMPZ,35,254]');
  e.line('$I', '[FIRMWARE:grblHAL]');
  e.line('$ES', 'ok'); // an "ok" without our request changes nothing
  assert.deepEqual(e.sent, []);
});

test('NEVER SENT before the platform is known, and NEVER SENT from the phone jog page', () => {
  const early = boot();
  early.newopt('ENUMS'); // no showGrbl yet
  assert.deepEqual(early.sent, []);
  early.connect('grblHAL'); // learning the platform afterwards does not send either: only the $I answer triggers it
  assert.deepEqual(early.sent, []);

  const phone = boot({ jog: true });
  phone.connect('grblHAL');
  phone.newopt('ENUMS,RT+,ES,TC,SED');
  assert.deepEqual(phone.sent, [], 'the desktop app asks; the answer reaches every client');
});

test('once per connection: a second $I answer does not ask again; the same platform announced again keeps the state', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS,SED');
  answerES(e);
  e.newopt('ENUMS,SED'); // "refresh settings" runs $I again
  e.connect('grblHAL'); // a page reload / second client announces the same platform
  e.newopt('ENUMS,SED');
  assert.deepEqual(e.sent, ['$ES']);
  assert.equal(JSON.parse(e.enumerated())['160'].name, 'X-axis backlash compensation', 'and what was read is kept');
});

test('disconnect resets everything; a new grblHAL connection asks again - a non-grblHAL one never does', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  answerES(e);
  e.disconnect();
  assert.equal(e.enumerated(), '{}');
  assert.equal(e.run('grblEnum.requested'), false);
  e.connect('grblHAL');
  e.newopt('ENUMS');
  assert.deepEqual(e.sent, ['$ES', '$ES']);
  e.disconnect();
  e.connect('gnea');
  e.newopt('ENUMS');
  assert.deepEqual(e.sent, ['$ES', '$ES'], 'nothing more for the other firmware');
});

test('a different platform on the same session resets the state (no map carried over)', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  answerES(e);
  e.connect('FluidNC');
  assert.equal(e.enumerated(), '{}');
  e.newopt('ENUMS');
  assert.deepEqual(e.sent, ['$ES']);
});

test('structure: exactly one place sends $ES in the whole app and the server never does', () => {
  const dir = path.join(__dirname, '..', 'app', 'js');
  let sends = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = read('app/js/' + f);
    if (/^(three|ace)/.test(f)) continue;
    sends += (src.match(/sendGcode\(\s*['"`]\$ES/g) || []).length;
    assert.ok(!/socket\.emit\(\s*['"]runCommand['"]\s*,\s*['"]\$ES/.test(src), f);
  }
  assert.equal(sends, 1);
  assert.ok(!/\$ES/.test(read('index.js')), 'the server never asks for it');
  const request = extractFunction(ENUM, 'grblEnumRequest');
  assert.match(request, /if \(!grblEnumMaySend\(\)\) return false;\s*grblEnum\.requested = true;/, 'the gate is checked BEFORE the send');
  assert.match(extractFunction(ENUM, 'grblEnumMaySend'), /grblEnum\.platform === 'grblHAL' && grblEnum\.enums === true && grblEnum\.requested === false/);
  assert.match(WS, /grblEnumSetPlatform\(bool && firmware \? firmware\.platform : ''\);/);
});

// --------------------------------------------------------------------------- the $ES answer

test('the answer fills the map, the raw [SETTING:...] lines are NOT printed, and one summary line is', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS,SED');
  e.logs.length = 0;
  answerES(e);
  const m = JSON.parse(e.enumerated());
  assert.deepEqual(Object.keys(m).sort(), ['0', '160', '161', '485', '539', '676', '680']);
  assert.equal(m['539'].name, 'Spindle off delay');
  assert.equal(e.logs.filter((l) => /SETTING/.test(l.string)).length, 0, 'no raw protocol line in the console');
  assert.equal(e.logs.length, 1);
  assert.match(e.logs[0].string, /Read 7 setting definitions from the controller/);
  assert.equal(e.run('grblEnum.done'), true);
  assert.equal(e.run('grblEnum.collecting'), false);
});

test('the handler reports "consumed" only for our own $ES answer; everything else still prints as before', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  const eat = (command, response) => e.ctx.grblEnumHandleData({ command, response });
  assert.equal(eat('$ES', S160), true);
  assert.equal(eat('$ES', 'ok'), true);
  assert.equal(eat('$$', '$0=10'), false);
  assert.equal(eat('$I', '[VER:1.1f.20260923:]'), false);
  assert.equal(eat('$ES', S160), false, 'after the answer is complete a stray line is shown normally (it was not ours)');
  const idle = boot();
  assert.equal(idle.ctx.grblEnumHandleData({ command: '$ES', response: S160 }), false, 'a $ES the user typed themselves is not swallowed');
  idle.line('$ES', S160);
  assert.equal(idle.logs.length, 1, 'and it is printed by the normal path');
});

test('a $ES error keeps everything working: no map, the error is shown, and it is not asked again', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  assert.equal(e.ctx.grblEnumHandleData({ command: '$ES', response: 'error:3' }), false, 'the error line is left to the normal path');
  e.run('grblEnum.collecting = true'); // (the line above already ended collecting; restore it to print through the real handler)
  e.logs.length = 0;
  e.line('$ES', 'error:3');
  assert.equal(e.logs.length, 1, 'and the normal path prints it');
  assert.equal(e.run('grblEnum.collecting'), false);
  assert.equal(e.enumerated(), '{}');
  e.newopt('ENUMS');
  assert.deepEqual(e.sent, ['$ES']);
  assert.equal(e.ctx.grblSettingName('160', true), 'unknown');
});

test('the map is bounded and unusable lines inside the answer are skipped', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  e.line('$ES', '[SETTING:x|1|bad]');
  e.line('$ES', '[SETTINGGROUP:1|0|General]');
  for (let i = 0; i < 2100; i++) e.line('$ES', '[SETTING:' + i + '|1|s' + i + ']');
  assert.equal(e.run('grblEnum.count'), 2000);
});

test('when the answer arrives, an untouched Advanced Settings table is rebuilt; an edited one is not', () => {
  const rebuild = (saveDisabled) => {
    const e = boot();
    e.ctx.$ = (sel) => jq({
      length: sel === '#grblSettingsTable' ? 1 : 0,
      attr: () => (saveDisabled ? 'disabled' : undefined),
      is: () => true,
    });
    e.connect('grblHAL');
    e.newopt('ENUMS');
    answerES(e);
    return e.populated;
  };
  assert.equal(rebuild(true), 1, 'no unsaved edits: rebuilt so the rows get their names');
  assert.equal(rebuild(false), 0, 'unsaved edits: left alone');
});

// --------------------------------------------------------------------------- names and rows

test('names: a static template title wins; else the controller\'s name; else "unknown" (the fallback is unchanged)', () => {
  const e = boot();
  assert.equal(e.ctx.grblSettingName('160', true), 'unknown');
  assert.equal(e.ctx.grblSettingName('0', true), 'Step pulse time, microseconds', 'template title, as before');
  e.connect('grblHAL');
  e.newopt('ENUMS');
  e.line('$ES', '[SETTING:0|18|SOMETHING ELSE|x|6]');
  answerES(e);
  assert.equal(e.ctx.grblSettingName('160', true), 'X-axis backlash compensation');
  assert.equal(e.ctx.grblSettingName('539', false), 'Spindle off delay');
  assert.equal(e.ctx.grblSettingName('0', true), 'Step pulse time, microseconds', 'the template still wins for a known key');
  assert.equal(e.ctx.grblSettingName('9999', true), 'unknown');
});

test('names are escaped where they go into HTML and left plain for the backup file', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  e.line('$ES', '[SETTING:700|1|<img src=x onerror=alert(1)>"\'&|x|5]');
  e.line('$ES', 'ok');
  const html = e.ctx.grblSettingName('700', true);
  assert.ok(!/<img/.test(html) && html.includes('&lt;img'));
  assert.equal(e.ctx.grblSettingName('700', false), '<img src=x onerror=alert(1)>"\'&', 'plain text for the file');
});

test('the log line for "$160=0" now says what it is (websocket.js data handler, escaped)', () => {
  const e = boot();
  e.line('$$', '$160=0.000');
  assert.match(e.logs[e.logs.length - 1].string, /\$160=0\.000 {2};unknown$/, 'before: unknown');
  e.connect('grblHAL');
  e.newopt('ENUMS');
  answerES(e);
  e.logs.length = 0;
  e.line('$$', '$160=0.000');
  assert.equal(e.logs[0].string, '$160=0.000  ;X-axis backlash compensation');
  e.line('$ES', '[SETTING:701|1|<b>x</b>]'); // (not collecting any more: shown as a normal line, escaped by the normal path)
});

test('rows: without a definition the row is what the panel always showed (red key, plain input, val-<n>-input)', () => {
  const e = boot();
  const row = e.ctx.grblEnumRowHtml('$160', '160', '0.000');
  assert.match(row, /<span class="tally alert">\$160<\/span>/);
  assert.match(row, /data-append="\?" type="text" value="0\.000" id="val-160-input"/);
});

test('rows: with a definition - name, unit, hint, reboot note, tooltip; the input keeps its id so Save works', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  answerES(e);
  const r160 = e.ctx.grblEnumRowHtml('$160', '160', '0.000');
  assert.ok(r160.includes('X-axis backlash compensation'));
  assert.ok(r160.includes('data-append="mm"'));
  assert.ok(r160.includes('id="val-160-input"') && r160.includes('value="0.000"'));
  assert.ok(!r160.includes('tally alert'), 'no more bare red key');
  const r539 = e.ctx.grblEnumRowHtml('$539', '539', '0');
  assert.ok(r539.includes('range 0 to 65535'));
  const r680 = e.ctx.grblEnumRowHtml('$680', '680', '0');
  assert.ok(r680.includes('restart the controller after saving'));
  const r676 = e.ctx.grblEnumRowHtml('$676', '676', '3');
  assert.ok(r676.includes('bit 0 = Clear homed state') && r676.includes('bit 1 = Clear offsets') && r676.includes('bit 3 = Clear tool'));
  assert.ok(!r676.includes('N/A'), 'unavailable bits are not shown');
  assert.ok(/title="\$676 - Reset actions/.test(r676));
});

test('rows: every firmware-supplied string and the value are escaped (nodeIntegration is on)', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  e.line('$ES', '[SETTING:701|1|"><script>alert(1)</script>|"><b>|5|"><i>|"><u>|"><s>]');
  e.line('$ES', 'ok');
  const row = e.ctx.grblEnumRowHtml('$701', '701', '"><script>alert(2)</script>');
  assert.ok(!/<script|<b>|<i>|<u>|<s>/.test(row), row);
  const fallback = e.ctx.grblEnumRowHtml('$999', '999', '"><script>alert(3)</script>');
  assert.ok(!/<script/.test(fallback), 'the fallback row escapes the value too');
});

test('rows: a password setting gets a password input, other types a text input', () => {
  const e = boot();
  e.connect('grblHAL');
  e.newopt('ENUMS');
  e.line('$ES', '[SETTING:330|9|Admin password||8|x(32)]');
  e.line('$ES', '[SETTING:302|9|IP address||9]');
  e.line('$ES', 'ok');
  assert.match(e.ctx.grblEnumRowHtml('$330', '330', '********'), /type="password"/);
  assert.match(e.ctx.grblEnumRowHtml('$302', '302', '1.2.3.4'), /type="text"/);
  assert.ok(e.ctx.grblEnumHint({ type: 7, format: 'x(32)' }).includes('up to 32 characters'));
});

// --------------------------------------------------------------------------- wiring

test('wiring: the panel, the backup file and the save dialog use grblSettingName / grblEnumRowHtml (no hard-coded "unknown")', () => {
  assert.ok(!/"unknown"/.test(SETTINGS) && !/"unknown"/.test(WS));
  assert.match(SETTINGS, /grblSettingName\(key2, false\)/);
  assert.match(SETTINGS, /grblSettingName\(newParamKey, true\)/);
  assert.match(SETTINGS, /template \+= grblEnumRowHtml\(key, key2, grblParams\[key\]\)/);
  assert.match(WS, /grblSettingName\(key, true\)/);
  assert.match(WS, /if \(grblEnumHandleData\(data\)\) return;/);
});

test('wiring: both pages load the enumeration script before grbl-settings.js / websocket.js need it', () => {
  const main = read('app/index.html');
  assert.ok(main.indexOf('js/grbl-settings-enum.js') > main.indexOf('js/grbl-settings-templates.js'));
  assert.ok(main.indexOf('js/grbl-settings-enum.js') < main.indexOf('js/grbl-settings.js'));
  const jog = read('app/jog/index.html');
  assert.ok(jog.includes('../js/grbl-settings-enum.js'));
});
