// The source of index.js, and of one `function name(...) {...}` in it
// (brace-matched), for tests that run a single function in a vm.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('index.js');

function grab(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

module.exports = { read, SRC, grab };
