// Tool-change wizard, Tahap 1b-i, Commit 2: every client-side place that
// starts a REAL job (POST /runjob - the ribbon Run button in app/js/main.js,
// and "Start from Line" in app/wizards/resume/resume.js) must send the
// chosen toolChangeMode along with it, same as fileName/lineOffset already
// do. This is a STRUCTURAL scan: for every file that POSTs to '/runjob' at
// all, the number of "toolChangeMode" appends in that file must match the
// number of '/runjob' POSTs - so a future call site (or a future branch in
// an existing one, like runJobFile()'s two) that forgets the field is
// caught, instead of silently defaulting to "pause" server-side (safe, but
// not what the user actually chose). Same style as the existing fileName
// structural check a few lines below runJobFile() in this test suite's
// P9 recovery tests (test/regression-static-checks.test.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true })) {
    const rel = dir + '/' + entry.name;
    if (entry.isDirectory()) out.push(...jsFiles(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const count = (src, re) => (src.match(re) || []).length;

test("structural: in every file that POSTs to '/runjob', the number of toolChangeMode appends matches the number of /runjob POSTs", () => {
  const files = [...jsFiles('app/js'), ...jsFiles('app/wizards')];
  const filesWithRunjob = files.filter((rel) => read(rel).includes("'/runjob'"));

  assert.deepEqual(filesWithRunjob.sort(), ['app/js/main.js', 'app/wizards/resume/resume.js'],
    'the known /runjob callers - a new one appearing here must also be covered below');

  let totalSites = 0;
  for (const rel of filesWithRunjob) {
    const src = read(rel);
    const runjobCount = count(src, /'\/runjob'/g);
    const modeCount = count(src, /formData\.append\("toolChangeMode",\s*toolChangeMode\)/g);
    assert.equal(modeCount, runjobCount, rel + ': ' + runjobCount + ' /runjob POST(s) but ' + modeCount + ' toolChangeMode append(s)');
    totalSites += runjobCount;
  }
  assert.equal(totalSites, 3, 'expected the 3 known /runjob call sites in total (main.js x2, resume.js x1)');
});
