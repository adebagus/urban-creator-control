// Regression tests for the job-history dialog (showJobLog in
// app/wizards/jobstats/jobstats.js).
//
// It used to concatenate pastJobs[i].filename straight into an HTML template.
// The file name is untrusted (a loaded file's name, kept in localStorage) and
// this renderer runs with nodeIntegration, so a crafted name was a code-execution
// vector. It now goes through recoveryEscapeHtml() from wizards/resume/resume.js
// - the app's shared escaper, deliberately reused rather than duplicated.
//
// The REAL showJobLog() and recoveryEscapeHtml() are extracted from their source
// files and run in a vm sandbox; the tests inspect the HTML actually handed to
// the dialog.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const JOBSTATS = read('app/wizards/jobstats/jobstats.js');
const RESUME = read('app/wizards/resume/resume.js');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot find function ' + name);
  let end = src.indexOf('\n}\n', start);
  if (end === -1 && src.endsWith('\n}')) end = src.length - 2; // last function in the file
  assert.notEqual(end, -1, 'cannot find the end of function ' + name);
  return src.slice(start, end + 2);
}

// Render the job-history dialog for the given records; returns the HTML content.
function render(records) {
  let content = null;
  const ctx = {
    pastJobs: records,
    Metro: { dialog: { create(opts) { content = opts.content; } } },
    timeConvert: () => '00h:00m', // numbers-as-text in the real app; irrelevant here
    msToTime: () => '00h00m',
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(RESUME, 'recoveryEscapeHtml'), ctx); // the real, shared escaper
  vm.runInContext(extractFunction(JOBSTATS, 'showJobLog'), ctx);       // the real dialog builder
  ctx.showJobLog();
  assert.ok(typeof content === 'string', 'showJobLog must open a dialog');
  return content;
}

const job = (filename) => ({ completed: true, filename, estruntime: 1, streamruntime: 1000, startdate: 1_700_000_000_000, enddate: 1_700_000_060_000 });
const nameCell = (html) => (html.match(/<div style="max-width: 160px !important; word-wrap: break-word;">([\s\S]*?)<\/div>/) || [])[1];

const PAYLOADS = [
  '<img src=x onerror=require("child_process").exec("calc")>',
  '<script>alert(1)</script>',
  '"><svg onload=alert(1)>',
  '</div></td></tr><tr><td><img src=x onerror=alert(1)>',
  "'\"&<>",
];

test('a hostile file name is HTML-escaped in the job-history dialog', () => {
  for (const evil of PAYLOADS) {
    const html = render([job(evil)]);
    const cell = nameCell(html);
    assert.ok(cell !== undefined, 'name cell not found for ' + evil);
    assert.ok(!/[<>"']/.test(cell), 'raw markup characters survived in: ' + cell);
    assert.ok(!/<img|<script|<svg/i.test(html), 'an injected tag reached the dialog HTML for ' + evil);
    assert.ok(cell.includes('&lt;') || !/[<>]/.test(evil), 'angle brackets must be escaped as entities');
  }
});

test('the name cell cannot be broken out of (a name containing </div> stays inside its cell)', () => {
  const html = render([job('a</div><b>bold</b>'), job('second.nc')]);
  assert.equal(nameCell(html), 'a&lt;/div&gt;&lt;b&gt;bold&lt;/b&gt;');
  // both rows still render as separate, intact rows
  assert.equal((html.match(/<tr>/g) || []).length, 3, 'header row + 2 job rows');
});

test('an ordinary file name is shown exactly as it is (no visible change for normal use)', () => {
  for (const name of ['Endcap HGR  Bawah 2pcs 3mm.gcode', 'part_v2 (final).nc', 'プログラム.gcode', 'Surfacing/Flattening Wizard Job']) {
    assert.equal(nameCell(render([job(name)])), name.replace(/&/g, '&amp;'));
  }
});

test('an ampersand is escaped once, not twice', () => {
  assert.equal(nameCell(render([job('R&D 3mm.nc')])), 'R&amp;D 3mm.nc');
});

test('missing / non-string file names do not throw and render harmlessly', () => {
  for (const odd of [undefined, null, 42, {}, ['x']]) {
    assert.doesNotThrow(() => render([job(odd)]), 'filename ' + JSON.stringify(odd));
    assert.ok(!/[<>]/.test(nameCell(render([job(odd)]))));
  }
});

test('history rows keep their status icon and layout (the fix changed only the name cell)', () => {
  const html = render([job('a.nc'), Object.assign(job('b.nc'), { completed: false })]);
  assert.equal((html.match(/fa-check fg-darkGreen/g) || []).length, 1);
  assert.equal((html.match(/fa-times fg-darkRed/g) || []).length, 1);
  assert.match(html, /\(Estimate\)/);
  assert.match(html, /\(Streamed\)/);
});

// --- structural guards ------------------------------------------------------

test('structural: jobstats.js never concatenates a record\'s filename into HTML unescaped', () => {
  assert.ok(!/\+\s*pastJobs\[[^\]]*\]\.filename\s*\+/.test(JOBSTATS), 'raw filename concatenation found');
  assert.match(JOBSTATS, /recoveryEscapeHtml\(pastJobs\[i\]\.filename\)/);
});

test('structural: the shared escaper is loaded on the desktop page, and escapes all five HTML-significant characters', () => {
  const html = read('app/index.html');
  assert.match(html, /wizards\/jobstats\/jobstats\.js/);
  assert.match(html, /wizards\/resume\/resume\.js/, 'jobstats.js depends on resume.js being loaded on the same page');

  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(extractFunction(RESUME, 'recoveryEscapeHtml'), ctx);
  assert.equal(ctx.recoveryEscapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
});
