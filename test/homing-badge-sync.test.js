// Bench 27 Nov 2026: "$22=1" typed in the console was accepted by the board,
// but the "Homing: OFF" badge on the Machine Control screen stayed OFF: only
// grblPopulate() (the settings tab rebuild) refreshed it, never
// grblSettings(), which handles every $$ line and every accepted "$N=".
// The REAL grbl-settings.js runs in a vm with a small stateful jQuery fake.
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


function loadSettings() {
  const dom = makeDom();
  const ctx = {
    $: dom.$, jQuery: dom.$, console: { log() {} }, setTimeout, clearTimeout,
    grblParams: {}, laststatus: { machine: { firmware: { platform: 'gnea' } } },
    localStorage: { getItem: () => null }, jogOverride() {}, updateToolOnSValues() {}, document: { getElementById: () => null },
  };
  vm.createContext(ctx);
  vm.runInContext(read('app/js/grbl-settings.js'), ctx);
  return { ctx, dom };
}

test('bench: "$22=1" accepted (console) -> "Homing: ON" at once; "$22=0" -> OFF', () => {
  const { ctx, dom } = loadSettings();
  ctx.grblSettings('$22=0');
  assert.equal(dom.el('#homingStatusBadge').text, 'Homing: OFF');
  ctx.grblSettings('$22=1'); // what websocket.js calls for {command:"$22=1", response:"ok"}
  assert.equal(dom.el('#homingStatusBadge').text, 'Homing: ON');
  assert.ok(dom.el('#homingStatusBadge').classes.has('status-on'));
  ctx.grblSettings('$22=0');
  assert.equal(dom.el('#homingStatusBadge').text, 'Homing: OFF');
  assert.ok(!dom.el('#homingStatusBadge').classes.has('status-on'));
});

test('a $$ dump line updates the badges too (Hard Limit as well)', () => {
  const { ctx, dom } = loadSettings();
  ctx.grblSettings('$21=1');
  ctx.grblSettings('$22=1');
  assert.equal(dom.el('#hardLimitStatusBadge').text, 'Hard Limit: ON');
  assert.equal(dom.el('#homingStatusBadge').text, 'Homing: ON');
});

test('websocket.js asks for a $$ after an accepted $21=/$22= (one, even for both)', () => {
  const src = read('app/js/websocket.js');
  const m = src.match(/if \(\/\^\\\$\\d\*=\/\.test\(data\.command\) && data\.response == 'ok'\) \{[\s\S]*?\n    \}\n/);
  assert.ok(m, 'the accepted-setting branch');
  assert.match(m[0], /\/\^\\\$2\[12\]=\/\.test\(data\.command\)/);
  assert.match(m[0], /clearTimeout\(limitSettingsRefreshTimer\)/);
  assert.match(m[0], /sendGcode\('\$\$'\)/);
});
