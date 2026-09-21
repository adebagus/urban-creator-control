// Tests for the two AUTOMATIC recovery notifications (app/wizards/resume/resume.js):
//   - the reconnect BANNER  (offerRecoveryOnReconnect -> showRecoveryBanner): non-blocking,
//     shown when a controller (re)connects with an unfinished job on record;
//   - the app-start MODAL   (showRecoveryOffer): shown once the app is open.
//
// They are INFORMATION ONLY. They appear on their own, at a moment the user did not choose -
// possibly before the machine is homed and zeroed - so nothing in them can start anything: no
// button opens the recovery dialog. The text says where the job stopped and suggests a line
// "after Home and Set Zero"; the way on is the ribbon "Start from Line" button (or the editor's
// right-click), pressed deliberately. Closing a notification NEVER deletes the saved data.
// (What the ribbon button does is tested in recover-job-button.test.js / start-from-line.test.js.)
//
// Also under test: only interrupted / running / completing records are offered automatically (a
// "stopped" record is for the ribbon button); each record (savedAt) is offered at most once per
// app session - counting the modal; the banner never blocks the Stop/jog buttons (no modal);
// nothing is offered on the LAN jog page.
// The real functions are extracted and run in a vm sandbox with a tiny DOM/socket/Metro fake.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const RESUME = read('app/wizards/resume/resume.js');
const WS = read('app/js/websocket.js');
const CSS = read('app/css/main.css');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot find function ' + name);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'cannot find the end of function ' + name);
  return src.slice(start, end + 2);
}

const NAMES = ['showRecoveryOffer', 'recoveryEscapeHtml', 'recoveryRewindLines', 'recoverySuggestedLine', 'recoveryOfferInfoHtml', 'recoveryOfferKey',
  'recoveryMarkOffered', 'shouldAutoOfferRecovery', 'offerRecoveryOnReconnect', 'dismissRecoveryBanner', 'showRecoveryBanner'];
const VARS = ['var RECOVERY_DEFAULT_REWIND', 'var recoveryOfferOpen', 'var RECOVERY_AUTO_OFFER_STATES', 'var recoveryOfferedKeys', 'var RECOVERY_NOTICE_HINT'];

function makeEnv(opts = {}) {
  const env = { banners: [], handlers: {}, dialogs: 0, dialogOpts: null, emitted: [], started: [], splashVisible: !!opts.splashVisible, pending: [], info: opts.info };
  const spy = (name) => (...a) => { env.started.push(name); };
  const ctx = {
    isJogWidget: !!opts.jog,
    window: { localStorage: { getItem: () => null } },
    editor: { session: { getLength: () => 100 } },
    Metro: { dialog: { create: (o) => { env.dialogs++; env.dialogOpts = o; } } },
    socket: {
      emit(ev, ack) {
        env.emitted.push(ev);
        if (ev === 'getRecoveryInfo' && typeof ack === 'function') ack(env.info);
      },
    },
    setTimeout: (fn, ms) => { env.pending.push({ fn, ms }); },
    // anything that could start or open the recovery flow: the notifications must never call these
    recoverJob: spy('recoverJob'), showStartFromLine: spy('showStartFromLine'), startFromHere: spy('startFromHere'), sendGcode: spy('sendGcode'), recoverCrashedJob: spy('recoverCrashedJob'),
    XMLHttpRequest: class { open() { env.started.push('xhr'); } send() { env.started.push('xhr'); } },
    $: (arg) => {
      if (typeof arg === 'string' && arg.startsWith('<div')) return { appendTo() { env.banners.push(arg); return this; } };
      if (arg === '#splash') return { is: () => env.splashVisible };
      if (arg === '#recoveryBanner') return { remove() { env.banners.length = 0; } };
      return { on(ev, fn) { env.handlers[arg] = fn; } };
    },
  };
  vm.createContext(ctx);
  for (const decl of VARS) {
    const i = RESUME.indexOf(decl);
    assert.notEqual(i, -1, 'cannot find ' + decl);
    vm.runInContext(RESUME.slice(i, RESUME.indexOf('\n', i)), ctx); // every extracted var declaration is a single line
  }
  for (const n of NAMES) vm.runInContext(extractFunction(RESUME, n), ctx);
  env.ctx = ctx;
  env.flush = () => { while (env.pending.length) env.pending.shift().fn(); };
  return env;
}

const rec = (over) => Object.assign({ state: 'interrupted', fileName: 'part.nc', resumeLine: 120, totalLines: 900, plannerBlocks: 35, startedAt: 1, savedAt: 1000 }, over);

// --------------------------------------------------------------------------- the info text

test('info text: "Pekerjaan terhenti di baris X dari Y total baris. Disarankan mulai sekitar baris X-10 setelah Home dan Set Zero ulang."', () => {
  const html = makeEnv().ctx.recoveryOfferInfoHtml(rec());
  assert.match(html, /^Pekerjaan terhenti di baris <b>120<\/b> dari <b>900<\/b> total baris\./);
  assert.match(html, /Disarankan mulai sekitar baris <b>110<\/b> setelah Home dan Set Zero ulang\.$/);
  assert.match(html, /File: <b>part\.nc<\/b>/);
});

test('info text: an unknown total / no file name are simply left out', () => {
  const info = makeEnv().ctx.recoveryOfferInfoHtml(rec({ totalLines: 0, fileName: '', resumeLine: 1 }));
  assert.match(info, /^Pekerjaan terhenti di baris <b>1<\/b>\./);
  assert.ok(!/total baris|File:|mundur/.test(info));
  assert.match(info, /Disarankan mulai sekitar baris <b>1<\/b> setelah Home dan Set Zero ulang\./);
});

test('info text: the suggested line is 10 before the stopped line, never below 1, and follows a stored setting', () => {
  const { recoverySuggestedLine: sug, recoveryRewindLines: back } = makeEnv().ctx;
  assert.equal(back(), 10);
  assert.equal(sug(120), 110);
  assert.equal(sug(5), 1);
  assert.match(makeEnv().ctx.recoveryOfferInfoHtml(rec({ resumeLine: 5 })), /baris <b>1<\/b> setelah Home/);
  assert.match(makeEnv().ctx.recoveryOfferInfoHtml(rec({ plannerBlocks: 35 })), /baris <b>110<\/b> setelah Home/, 'the planner depth the server records does not change it');
  const env = makeEnv();
  env.ctx.window = { localStorage: { getItem: () => '25' } };
  assert.match(env.ctx.recoveryOfferInfoHtml(rec()), /baris <b>95<\/b> setelah Home/);
});

test('info text: the file name is HTML-escaped, and numbers are coerced', () => {
  const html = makeEnv().ctx.recoveryOfferInfoHtml(rec({ fileName: '<img src=x onerror=alert(1)>.nc' }));
  assert.ok(!/<img/i.test(html));
  assert.match(html, /&lt;img/);
  assert.ok(!/<script>/.test(makeEnv().ctx.recoveryOfferInfoHtml(rec({ resumeLine: '120<script>', totalLines: '900<b>x' }))));
});

// --------------------------------------------------------------------------- the banner

test('banner: appears for an interrupted record, is NOT a modal, and shows the info text and the hint', () => {
  const env = makeEnv({ info: rec() });
  env.ctx.offerRecoveryOnReconnect();
  assert.equal(env.banners.length, 1);
  assert.equal(env.dialogs, 0, 'must not open a modal dialog');
  const html = env.banners[0];
  assert.match(html, /position: fixed; left: 12px; bottom: 12px/);
  assert.match(html, /Pekerjaan belum selesai ditemukan/);
  assert.match(html, /Unfinished job found/);
  assert.ok(html.includes(env.ctx.recoveryOfferInfoHtml(rec())));
  assert.ok(html.includes('Untuk melanjutkan: tombol Start from Line di ribbon. Menutup ini tidak menghapus data.'));
  assert.ok(html.includes('To resume: use the ribbon Start from Line button. Closing this keeps the data.'));
});

test('banner: NO action button - the only button is the corner close (x); nothing in it can start or open the recovery', () => {
  const env = makeEnv({ info: rec() });
  env.ctx.offerRecoveryOnReconnect();
  const html = env.banners[0];
  const buttons = [...html.matchAll(/<button [^>]*id="([^"]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(buttons, [['recoveryBannerClose', '&times;']]);
  assert.ok(!/Recover Job<\/button>|>Lanjutkan|Buang \/|Nanti \/|Buka file G-code|Mulai dari Baris/.test(html), 'no button caption of the old flow');
  assert.equal(Object.keys(env.handlers).join(), '#recoveryBannerClose', 'the only click handler is the close');
});

test('banner: the close (x) just closes it - nothing is sent, nothing is started, the saved data is kept', () => {
  const env = makeEnv({ info: rec() });
  env.ctx.offerRecoveryOnReconnect();
  env.emitted.length = 0;
  env.handlers['#recoveryBannerClose']();
  assert.equal(env.banners.length, 0);
  assert.deepEqual(env.emitted, [], 'no discardRecovery, no other event');
  assert.deepEqual(env.started, []);
});

test('banner: running and completing records are offered too', () => {
  for (const state of ['running', 'completing']) {
    const env = makeEnv({ info: rec({ state }) });
    env.ctx.offerRecoveryOnReconnect();
    assert.equal(env.banners.length, 1, state);
  }
});

test('banner: a "stopped" record is NEVER offered automatically (ribbon button only)', () => {
  const env = makeEnv({ info: rec({ state: 'stopped' }) });
  env.ctx.offerRecoveryOnReconnect();
  assert.equal(env.banners.length, 0);
  assert.equal(env.dialogs, 0);
});

test('banner: nothing to offer for no record, a malformed record, or an unknown state', () => {
  for (const info of [null, undefined, {}, rec({ resumeLine: 0 }), rec({ resumeLine: 'x' }), rec({ state: 'bogus' })]) {
    const env = makeEnv({ info });
    env.ctx.offerRecoveryOnReconnect();
    assert.equal(env.banners.length, 0, JSON.stringify(info));
  }
});

test('banner: each record (savedAt) is offered at most once per session - closing keeps the data, but Connect does not repeat it', () => {
  const env = makeEnv({ info: rec() });
  env.ctx.offerRecoveryOnReconnect();
  env.ctx.dismissRecoveryBanner();
  env.ctx.offerRecoveryOnReconnect(); // clicks Connect again
  env.ctx.offerRecoveryOnReconnect();
  assert.equal(env.banners.length, 0, 'same savedAt must not reappear');
  env.info = rec({ savedAt: 2000 }); // a NEW interruption is a new record
  env.ctx.offerRecoveryOnReconnect();
  assert.equal(env.banners.length, 1);
});

test('banner: it waits for the splash screen instead of hiding under it', () => {
  const env = makeEnv({ info: rec(), splashVisible: true });
  env.ctx.offerRecoveryOnReconnect();
  assert.equal(env.banners.length, 0);
  env.splashVisible = false;
  env.flush();
  assert.equal(env.banners.length, 1);
});

test('banner: the LAN Jog-from-Phone page never gets it', () => {
  const env = makeEnv({ info: rec(), jog: true });
  env.ctx.offerRecoveryOnReconnect();
  assert.equal(env.banners.length, 0);
  assert.equal(env.emitted.length, 0);
});

// --------------------------------------------------------------------------- the app-start modal

function openModal(info) {
  const env = makeEnv({ info });
  env.ctx.showRecoveryOffer(info);
  env.flush();
  assert.equal(env.dialogs, 1, 'modal must open');
  return env;
}

test('modal: bilingual title, the info text, the hint, ONE action "Tutup / Close" and a close (x)', () => {
  const env = openModal(rec());
  const o = env.dialogOpts;
  assert.match(o.title, /Pekerjaan belum selesai ditemukan/);
  assert.match(o.title, /class='recovery-title-en'>Unfinished job found</);
  assert.ok(o.content.includes(env.ctx.recoveryOfferInfoHtml(rec())));
  assert.ok(o.content.includes('Menutup ini tidak menghapus data.'));
  assert.equal(o.actions.length, 1);
  assert.equal(o.actions[0].caption, 'Tutup / Close');
  assert.equal(o.closeButton, true);
});

test('modal: NO action can start the recovery - only "Tutup / Close" and the (x)', () => {
  const env = openModal(rec());
  const captions = Array.from(env.dialogOpts.actions, (a) => a.caption).join(' ');
  assert.ok(!/Recover|Lanjutkan|Buang|Discard|Nanti|Later|Buka|Mulai/i.test(captions));
  env.dialogOpts.actions[0].onclick();
  assert.deepEqual(env.started, []);
  assert.equal(env.pending.length, 0, 'no delayed hand-off to another dialog');
});

test('modal: closing it - by the button or the (x) - keeps the saved data and starts nothing', () => {
  const env = openModal(rec());
  env.dialogOpts.onClose();
  assert.deepEqual(env.emitted, [], 'nothing is sent to the server: no discardRecovery');
  assert.deepEqual(env.started, []);
});

test('modal: uses the SAME info text as the banner', () => {
  const info = rec({ fileName: 'Endcap HGR.gcode' });
  const modal = openModal(info);
  const bannerEnv = makeEnv({ info });
  bannerEnv.ctx.offerRecoveryOnReconnect();
  const text = bannerEnv.ctx.recoveryOfferInfoHtml(info);
  assert.ok(modal.dialogOpts.content.includes(text));
  assert.ok(bannerEnv.banners[0].includes(text));
});

test('modal: can be shown again after closing, but never while one is open', () => {
  const env = openModal(rec());
  env.ctx.showRecoveryOffer(rec({ savedAt: 5 })); env.flush();
  assert.equal(env.dialogs, 1, 'no second dialog while one is open');
  env.dialogOpts.onClose();
  env.ctx.showRecoveryOffer(rec({ savedAt: 6 })); env.flush();
  assert.equal(env.dialogs, 2);
});

test('modal: marks its record as offered, so connecting the controller does not show the banner for it', () => {
  const env = openModal(rec());
  env.ctx.offerRecoveryOnReconnect();
  assert.equal(env.banners.length, 0);
});

test('modal: waits for the splash; ignores unusable records; escapes the file name', () => {
  const env = makeEnv({ info: rec(), splashVisible: true });
  env.ctx.showRecoveryOffer(rec());
  assert.equal(env.dialogs, 0);
  env.splashVisible = false; env.flush();
  assert.equal(env.dialogs, 1);
  for (const bad of [null, {}, rec({ resumeLine: 0 })]) {
    const e = makeEnv();
    e.ctx.showRecoveryOffer(bad); e.flush();
    assert.equal(e.dialogs, 0, JSON.stringify(bad));
  }
  assert.ok(!/<img/i.test(openModal(rec({ fileName: '<img src=x onerror=alert(1)>.nc' })).dialogOpts.content));
});

// --------------------------------------------------------------------------- wiring

test('wiring: neither notification can reach the recovery flow - by construction', () => {
  for (const n of ['showRecoveryBanner', 'showRecoveryOffer', 'offerRecoveryOnReconnect']) {
    const body = extractFunction(RESUME, n);
    assert.ok(!/recoverJob|recoverCrashedJob|showStartFromLine|startFromHere|sendGcode|XMLHttpRequest|runJob|setInterval|discardRecovery/.test(body), n + ' must stay information only');
  }
  assert.ok(!/discardRecovery/.test(RESUME), 'the UI never asks the server to forget the saved job');
});

test('wiring: showGrbl(true) triggers the offer, showGrbl(false) does not; connect code is untouched', () => {
  const body = extractFunction(WS, 'showGrbl');
  const [onTrue, onFalse] = body.split('} else { // Hide');
  assert.match(onTrue, /typeof offerRecoveryOnReconnect === 'function'/, 'must tolerate pages without resume.js');
  assert.match(onTrue, /offerRecoveryOnReconnect\(\)/);
  assert.ok(!/offerRecoveryOnReconnect/.test(onFalse));
  assert.equal((WS.match(/offerRecoveryOnReconnect/g) || []).length, 2, 'only the guarded call in showGrbl');
  for (const f of ['connectTo', 'portOpened']) {
    for (const rel of fs.readdirSync(path.join(__dirname, '..', 'app/js')).filter((x) => x.endsWith('.js')).map((x) => 'app/js/' + x)) {
      const src = read(rel);
      if (src.includes('function ' + f + '(')) assert.ok(!/offerRecovery|recoveryBanner/.test(extractFunction(src, f)), f + ' in ' + rel);
    }
  }
});

test('wiring: the reconnect path never creates a modal, and only the agreed states are auto-offered', () => {
  for (const n of ['offerRecoveryOnReconnect', 'showRecoveryBanner', 'shouldAutoOfferRecovery']) {
    assert.ok(!/Metro\.dialog/.test(extractFunction(RESUME, n)), n + ' must not open a modal');
  }
  assert.match(RESUME, /RECOVERY_AUTO_OFFER_STATES = \['interrupted', 'running', 'completing'\]/);
  assert.match(extractFunction(RESUME, 'showRecoveryOffer'), /recoveryMarkOffered\(info\)/);
});

// --------------------------------------------------------------------------- visuals (the banner floats over the console)

const cssRule = (sel) => {
  const i = CSS.indexOf(sel + ' {');
  assert.notEqual(i, -1, 'cannot find CSS rule ' + sel);
  return CSS.slice(i, CSS.indexOf('}', i));
};
const cssProp = (rule, prop) => (rule.match(new RegExp('(?:^|[\\s;{])' + prop + ':\\s*([^;!]+)')) || [])[1];
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('visual: the banner has an OPAQUE solid background and keeps its floating shadow', () => {
  const rule = cssRule('.recovery-banner');
  assert.match(cssProp(rule, 'background-color').trim(), /^#[0-9a-f]{6}$/i, 'solid 6-digit hex, not rgba/transparent');
  assert.match(cssProp(rule, 'box-shadow'), /rgba\(0, 0, 0, 0\.\d+\)/);
  assert.ok(!/class="remark/.test(extractFunction(RESUME, 'showRecoveryBanner')), '.remark has no background');
});

test('visual: text, the close x and the muted lines meet WCAG AA (>= 4.5:1); the unused button style is gone', () => {
  const rule = cssRule('.recovery-banner');
  const bg = cssProp(rule, 'background-color').trim();
  assert.ok(contrast(cssProp(rule, 'color').trim(), bg) >= 4.5, 'body text');
  assert.ok(contrast(cssProp(cssRule('.recovery-banner .recovery-banner-close'), 'color').trim(), bg) >= 4.5, 'close x');
  assert.ok(contrast(cssProp(cssRule('.recovery-banner .recovery-banner-en'), 'color').trim(), bg) >= 4.5, 'muted line');
  assert.ok(contrast('#fa6800', bg) >= 3, 'accent border');
  assert.ok(contrast(cssProp(cssRule('.recovery-title-en'), 'color').trim(), '#505050') >= 4.5, 'English title line on the dark dialog title bar (#505050)');
  assert.ok(!/recovery-banner-primary|recovery-banner-secondary/.test(CSS + RESUME), 'the banner has no action buttons any more');
});

test('visual: the close x sits in the corner', () => {
  const x = cssRule('.recovery-banner .recovery-banner-close');
  assert.match(cssProp(x, 'position'), /absolute/);
  assert.match(cssProp(x, 'top'), /\d+px/);
  assert.match(cssProp(x, 'right'), /\d+px/);
});
