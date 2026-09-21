// Regression tests for setWindowTitle() in app/js/main.js.
//
// The title text feeds two different sinks that need OPPOSITE treatment:
//   - $('#windowtitle').html(...) is an HTML sink (nodeIntegration is on, so an
//     unescaped file name is code execution) -> must be HTML-escaped with the
//     app's shared recoveryEscapeHtml() (wizards/resume/resume.js).
//   - document.title is a native API, not HTML -> must stay RAW; escaping it
//     would show a literal "&lt;" in the OS title bar.
// The real setWindowTitle() and recoveryEscapeHtml() are run in a vm sandbox.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('app/js/main.js');
const RESUME = read('app/wizards/resume/resume.js');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot find function ' + name);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'cannot find the end of function ' + name);
  return src.slice(start, end + 2);
}

function run(fileName, opts = {}) {
  const out = { html: null, title: null };
  const ctx = {
    loadedFileName: fileName,
    nostatusyet: false,
    laststatus: { driver: { version: opts.version || '1.0.0' }, comms: { interfaces: { activePort: opts.port === undefined ? 'COM3' : opts.port } } },
    $: () => ({ html: (h) => { out.html = h; } }),
    document: { set title(t) { out.title = t; }, get title() { return out.title; } },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(RESUME, 'recoveryEscapeHtml'), ctx);
  vm.runInContext(extractFunction(MAIN, 'setWindowTitle'), ctx);
  ctx.setWindowTitle();
  return out;
}

const HOSTILE = '<img src=x onerror=require("child_process").exec("calc")>.nc';

test('#windowtitle (HTML sink): a hostile file name is escaped', () => {
  const { html } = run(HOSTILE);
  assert.ok(!/<img/i.test(html), 'raw tag reached the HTML sink: ' + html);
  assert.ok(html.includes('&lt;img src=x onerror=require(&quot;child_process&quot;).exec(&quot;calc&quot;)&gt;.nc'));
});

test('document.title (native API): the same name stays RAW, not entity-escaped', () => {
  const { title } = run(HOSTILE);
  assert.ok(title.includes(HOSTILE), 'title must contain the original characters: ' + title);
  assert.ok(!/&lt;|&gt;|&quot;|&amp;/.test(title), 'title must not contain HTML entities: ' + title);
});

test('both sinks are fed in one call, one escaped and one raw', () => {
  const { html, title } = run('R&D <v2>.nc');
  assert.ok(html.includes('R&amp;D &lt;v2&gt;.nc'));
  assert.ok(title.includes('R&D <v2>.nc'));
});

test('ordinary names, version and port look the same in both sinks', () => {
  const { html, title } = run('Endcap HGR 3mm.gcode');
  assert.equal(html, ' v1.0.0 / Endcap HGR 3mm.gcode / connected to COM3');
  assert.equal(title, 'Urban Creator CONTROL v1.0.0 / Endcap HGR 3mm.gcode / connected to COM3');
});

test('no file loaded: no file segment in either sink', () => {
  const { html, title } = run('');
  assert.equal(html, ' v1.0.0 / connected to COM3');
  assert.equal(title, 'Urban Creator CONTROL v1.0.0 / connected to COM3');
});

test('other dynamic parts (port, version) are escaped in HTML but raw in the title', () => {
  const { html, title } = run('', { port: '<b>COM9</b>', version: '<i>1</i>' });
  assert.ok(!/<b>|<i>/.test(html));
  assert.ok(title.includes('<b>COM9</b>') && title.includes('<i>1</i>'));
});

test('structural: html() gets the escaped variable and document.title the raw one', () => {
  const body = extractFunction(MAIN, 'setWindowTitle');
  assert.match(body, /\$\('#windowtitle'\)\.html\(htmlString\)/);
  assert.match(body, /document\.title = "Urban Creator CONTROL" \+ string\b/);
  assert.match(body, /recoveryEscapeHtml\(loadedFileName\)/);
  assert.ok(!/document\.title[^\n]*recoveryEscapeHtml/.test(body), 'document.title must never be escaped');
  assert.ok(!/htmlString\s*\+=[^\n]*\bloadedFileName\b(?!\))/.test(body.replace(/recoveryEscapeHtml\([^)]*\)/g, '')), 'raw loadedFileName in htmlString');
});
