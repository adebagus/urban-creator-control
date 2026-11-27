// Bench 27 Nov 2026: the console input is disabled while a job runs
// (connectionStatus 3) or is paused (4) - ui.js setConsole() - but it did not
// LOOK disabled, and while paused the Send button stayed enabled (the backend
// refuses console commands while paused). Now: greyed out (class
// console-job-locked on the input and on Metro's .input wrapper), a
// placeholder that says why and what to do, Send disabled too; all restored
// when the job is over.
//
// The REAL ui.js runs in a vm with a small stateful jQuery fake.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

function makeDom() {
  const els = {};
  const el = (sel) => {
    if (!els[sel]) els[sel] = { attrs: {}, props: {}, classes: new Set(), data: {}, text: undefined, html: undefined, exists: false };
    return els[sel];
  };
  const PRESENT = new Set(['#command', '#sendCommand', '.input', '#homingStatusBadge', '#hardLimitStatusBadge']);
  function wrap(sel) {
    const e = el(sel);
    const api = new Proxy({}, {
      get(_, name) {
        switch (name) {
          case 'length': return PRESENT.has(sel) ? 1 : 0;
          case 'attr': return (k, v) => { if (v === undefined) return e.attrs[k]; e.attrs[k] = v; return api; };
          case 'prop': return (k, v) => { if (v === undefined) return e.props[k]; e.props[k] = v; return api; };
          case 'data': return (k, v) => { if (v === undefined) return e.data[k]; e.data[k] = v; return api; };
          case 'toggleClass': return (c, on) => { if (on) e.classes.add(c); else e.classes.delete(c); return api; };
          case 'addClass': return (c) => { e.classes.add(c); return api; };
          case 'removeClass': return (c) => { e.classes.delete(c); return api; };
          case 'hasClass': return (c) => e.classes.has(c);
          case 'text': return (t) => { if (t === undefined) return e.text; e.text = t; return api; };
          case 'html': return (t) => { if (t === undefined) return e.html; e.html = t; return api; };
          case 'closest': return (s) => wrap(s);
          case 'is': return () => false;
          case 'val': return () => undefined;
          default: return () => api;
        }
      },
    });
    return api;
  }
  return { $: wrap, el };
}

function loadUi() {
  const dom = makeDom();
  // the page's own placeholder (app/index.html)
  dom.el('#command').attrs.placeholder = 'Enter GCODE/Serial commands here to send it to your machine';
  const ctx = {
    $: dom.$, jQuery: dom.$, editor: { resize() {}, session: { getLength: () => 0 } },
    toolchanges: [], webgl: true, grblParams: { $22: 0 }, ace: {}, console, setTimeout, clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(read('app/js/ui.js'), ctx);
  return { ctx, dom };
}

test('job running (3): console input disabled, greyed, placeholder says why; Send disabled', () => {
  const { ctx, dom } = loadUi();
  ctx.setConsole(3, {});
  const cmd = dom.el('#command');
  assert.equal(cmd.attrs.disabled, true);
  assert.equal(dom.el('#sendCommand').props.disabled, true);
  assert.equal(cmd.attrs.placeholder, 'Konsol nonaktif selama job berjalan — tunggu selesai atau Stop dulu');
  assert.ok(cmd.classes.has('console-job-locked'));
  assert.ok(dom.el('.input').classes.has('console-job-locked'), 'the Metro wrapper (with the prompt icon) greys out too');
});

test('job paused (4): same, with the pause wording - and Send is disabled now (it used to stay enabled)', () => {
  const { ctx, dom } = loadUi();
  ctx.setConsole(4, {});
  assert.equal(dom.el('#command').attrs.disabled, true);
  assert.equal(dom.el('#sendCommand').props.disabled, true);
  assert.equal(dom.el('#command').attrs.placeholder, 'Konsol nonaktif selama job di-pause — Resume atau Stop dulu');
  assert.ok(dom.el('#command').classes.has('console-job-locked'));
});

test('job over (2) or alarm (5): enabled again, original placeholder back, no grey', () => {
  for (const after of [2, 5]) {
    const { ctx, dom } = loadUi();
    ctx.setConsole(3, {});
    ctx.setConsole(4, {});
    ctx.setConsole(after, {});
    const cmd = dom.el('#command');
    assert.equal(cmd.attrs.disabled, false, String(after));
    assert.equal(dom.el('#sendCommand').props.disabled, false);
    assert.equal(cmd.attrs.placeholder, 'Enter GCODE/Serial commands here to send it to your machine');
    assert.ok(!cmd.classes.has('console-job-locked'));
    assert.ok(!dom.el('.input').classes.has('console-job-locked'));
  }
});

test('not connected (0) keeps the page\'s own placeholder (no job wording)', () => {
  const { ctx, dom } = loadUi();
  ctx.setConsole(0, {});
  assert.equal(dom.el('#command').attrs.placeholder, 'Enter GCODE/Serial commands here to send it to your machine');
  assert.ok(!dom.el('#command').classes.has('console-job-locked'));
});

test('the grey look exists in main.css for both the input and its wrapper', () => {
  const css = read('app/css/main.css');
  assert.match(css, /\.input\.console-job-locked/);
  assert.match(css, /#command\.console-job-locked[^{]*\{[^}]*background-color/);
  assert.match(css, /#command\.console-job-locked::placeholder/);
});
