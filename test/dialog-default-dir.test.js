// Since Electron 43 a native dialog without a defaultPath opens in the Downloads folder instead of where it was last
// used. The two dialogs of the app (Open GCODE: socket "openFile", and the Interface USB drive: "openInterfaceDir")
// now pass a defaultPath: the folder picked last time (kept in userData/dialog-dirs.json, so it survives a restart),
// else Documents. These tests run the REAL handlers and helpers from index.js in a vm with a fake dialog and a real
// temporary folder tree.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

function grabFunction(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'cannot extract function ' + name);
  const end = SRC.indexOf('\n}\n', start);
  assert.notEqual(end, -1);
  return SRC.slice(start, end + 2);
}
function grabHandler(event) {
  const marker = 'socket.on("' + event + '", function(';
  const start = SRC.indexOf(marker);
  assert.notEqual(start, -1, 'cannot find socket handler ' + event);
  const fnStart = start + ('socket.on("' + event + '", ').length;
  const end = SRC.indexOf('\n  })\n', fnStart);
  assert.notEqual(end, -1, 'cannot find the end of ' + event);
  return '(' + SRC.slice(fnStart, end + '\n  }'.length) + ')';
}

// A fresh app: its own userData and Documents folders (real, temporary), a fake dialog answering what the test says.
function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-dlg-'));
  const userData = path.join(root, 'userData'); const documents = path.join(root, 'Documents');
  fs.mkdirSync(userData); fs.mkdirSync(documents);
  const env = { root, userData, documents, calls: [], answer: null, read: [], emitted: [], logs: [] };
  const ctx = {
    path, fs, console: { log() {} },
    electronApp: { getPath: (n) => (n === 'userData' ? userData : n === 'documents' ? documents : path.join(root, n)) },
    jogWindow: {},
    dialog: { showOpenDialog: (win, opts) => { env.calls.push(opts); return Promise.resolve(env.answer(opts)); } },
    readFile: (p) => env.read.push(p),
    debug_log() {},
    serialLog: (lvl, msg) => env.logs.push(lvl + ': ' + msg),
    io: { sockets: { emit: (ev, d) => env.emitted.push([ev, d]) } },
    status: { interface: {} },
  };
  vm.createContext(ctx);
  vm.runInContext('var dialogDirs = null;\n' + ['dialogDirsFile', 'loadDialogDirs', 'dialogStartDir', 'rememberDialogDir'].map(grabFunction).join('\n'), ctx);
  env.openFile = vm.runInContext(grabHandler('openFile'), ctx);
  env.openInterface = vm.runInContext(grabHandler('openInterfaceDir'), ctx);
  env.ctx = ctx;
  env.pick = (files) => { env.answer = () => ({ canceled: false, filePaths: files }); };
  env.cancel = () => { env.answer = () => ({ canceled: true, filePaths: [] }); };
  env.settle = () => new Promise((r) => setImmediate(r));
  env.savedFile = () => path.join(userData, 'dialog-dirs.json');
  // a "restart": same userData, fresh module state
  env.restart = () => { vm.runInContext('dialogDirs = null', ctx); };
  return env;
}
const mkdir = (env, ...parts) => { const d = path.join(env.root, ...parts); fs.mkdirSync(d, { recursive: true }); return d; };

test('first use: both dialogs start in Documents, not in Downloads', async () => {
  const e = boot();
  e.cancel();
  e.openFile({}); await e.settle();
  e.openInterface({}); await e.settle();
  assert.equal(e.calls.length, 2);
  assert.equal(e.calls[0].defaultPath, e.documents);
  assert.equal(e.calls[1].defaultPath, e.documents);
  assert.equal(e.calls[0].properties[0], 'openFile');
  assert.equal(e.calls[1].properties[0], 'openDirectory');
});

test('Open GCODE remembers the folder of the file that was picked, and starts there next time', async () => {
  const e = boot();
  const jobs = mkdir(e, 'Jobs', 'March');
  e.pick([path.join(jobs, 'part.nc')]);
  e.openFile({}); await e.settle();
  assert.deepEqual(e.read, [path.join(jobs, 'part.nc')], 'the file is still opened as before');
  e.cancel();
  e.openFile({}); await e.settle();
  assert.equal(e.calls[1].defaultPath, jobs);
});

test('the Interface drive dialog remembers the drive/folder picked, separately from Open GCODE', async () => {
  const e = boot();
  const jobs = mkdir(e, 'Jobs'); const usb = mkdir(e, 'USB-DRIVE');
  e.pick([path.join(jobs, 'a.nc')]); e.openFile({}); await e.settle();
  e.pick([usb]); e.openInterface({}); await e.settle();
  assert.deepEqual(e.emitted, [['interfaceDrive', usb]], 'the drive is still reported as before');
  e.cancel();
  e.openFile({}); await e.settle();
  e.openInterface({}); await e.settle();
  assert.equal(e.calls[e.calls.length - 2].defaultPath, jobs, 'Open GCODE keeps its own folder');
  assert.equal(e.calls[e.calls.length - 1].defaultPath, usb, 'the Interface dialog keeps its own');
});

test('the remembered folder survives a restart (stored in userData/dialog-dirs.json)', async () => {
  const e = boot();
  const jobs = mkdir(e, 'Jobs');
  e.pick([path.join(jobs, 'a.nc')]); e.openFile({}); await e.settle();
  assert.ok(fs.existsSync(e.savedFile()));
  assert.deepEqual(JSON.parse(fs.readFileSync(e.savedFile(), 'utf8')), { gcode: jobs });
  e.restart();
  e.cancel();
  e.openFile({}); await e.settle();
  assert.equal(e.calls[e.calls.length - 1].defaultPath, jobs);
});

test('cancelling never changes the remembered folder', async () => {
  const e = boot();
  const jobs = mkdir(e, 'Jobs'); const other = mkdir(e, 'Other');
  e.pick([path.join(jobs, 'a.nc')]); e.openFile({}); await e.settle();
  e.answer = () => ({ canceled: true, filePaths: [path.join(other, 'b.nc')] }); // even if the answer carried a path
  e.openFile({}); await e.settle();
  e.cancel();
  e.openFile({}); await e.settle();
  assert.equal(e.calls[e.calls.length - 1].defaultPath, jobs);
  e.pick([]); // nothing chosen, not flagged as cancelled
  e.openInterface({}); await e.settle();
  e.cancel(); e.openInterface({}); await e.settle();
  assert.equal(e.calls[e.calls.length - 1].defaultPath, e.documents);
});

test('cancelling the Interface dialog never changes ITS remembered folder either, even if the answer carried a path', async () => {
  const e = boot();
  const usb = mkdir(e, 'USB'); const other = mkdir(e, 'Other');
  e.pick([usb]); e.openInterface({}); await e.settle();
  e.answer = () => ({ canceled: true, filePaths: [other] });
  e.openInterface({}); await e.settle();
  e.cancel(); e.openInterface({}); await e.settle();
  assert.equal(e.calls[e.calls.length - 1].defaultPath, usb);
});

test('a remembered folder that no longer exists (removed drive, deleted folder) falls back to Documents', async () => {
  const e = boot();
  const gone = mkdir(e, 'Gone');
  e.pick([path.join(gone, 'a.nc')]); e.openFile({}); await e.settle();
  fs.rmSync(gone, { recursive: true });
  e.cancel();
  e.openFile({}); await e.settle();
  assert.equal(e.calls[e.calls.length - 1].defaultPath, e.documents);
  // a remembered FILE path (someone edited the json) is not a folder either
  fs.writeFileSync(e.savedFile(), JSON.stringify({ gcode: path.join(e.documents) + path.sep + 'x.txt' }));
  fs.writeFileSync(path.join(e.documents, 'x.txt'), 'x');
  e.restart();
  e.openFile({}); await e.settle();
  assert.equal(e.calls[e.calls.length - 1].defaultPath, e.documents);
});

test('a missing, corrupt or odd dialog-dirs.json never breaks the dialogs', async () => {
  for (const content of ['', '{not json', 'null', '[]', '42', '{"gcode": 5, "interface": null}', '{"gcode": {"a": 1}}']) {
    const e = boot();
    fs.writeFileSync(e.savedFile(), content);
    e.cancel();
    e.openFile({}); await e.settle();
    e.openInterface({}); await e.settle();
    assert.equal(e.calls[0].defaultPath, e.documents, JSON.stringify(content));
    assert.equal(e.calls[1].defaultPath, e.documents, JSON.stringify(content));
  }
});

test('failing to write the state file is logged and the dialog result still works', async () => {
  const e = boot();
  const jobs = mkdir(e, 'Jobs');
  fs.mkdirSync(e.savedFile()); // a folder where the file should be: writing fails
  e.pick([path.join(jobs, 'a.nc')]); e.openFile({}); await e.settle();
  assert.deepEqual(e.read, [path.join(jobs, 'a.nc')], 'the file is still opened');
  assert.ok(e.logs.some((l) => /^warn: Could not remember the last dialog folder/.test(l)), e.logs.join(' | '));
  e.cancel();
  e.openFile({}); await e.settle();
  assert.equal(e.calls[e.calls.length - 1].defaultPath, jobs, 'and it is still remembered for this session');
});

test('behaviour that must not change: a cancelled Open GCODE opens nothing; the drive event is sent as before', async () => {
  const e = boot();
  e.cancel();
  e.openFile({}); await e.settle();
  assert.ok(e.read.every((p) => !p), 'no file is read for a cancelled dialog (the handler passes undefined, which readFile ignores - unchanged)');
  e.openInterface({}); await e.settle();
  assert.deepEqual(e.emitted, [['interfaceDrive', undefined]], 'unchanged (the client already copes with it)');
});

test('structure: every showOpenDialog in the app passes a defaultPath from dialogStartDir', () => {
  const calls = SRC.match(/dialog\.showOpenDialog\(jogWindow, \{[^}]*\}/g) || [];
  assert.equal(calls.length, 2, 'exactly the two known dialogs');
  for (const c of calls) assert.match(c, /defaultPath: dialogStartDir\('(gcode|interface)'\)/, c);
  assert.match(SRC, /rememberDialogDir\('gcode', path\.dirname\(openFilePath\)\)/);
  assert.match(SRC, /rememberDialogDir\('interface', result\.filePaths\[0\]\)/);
});
