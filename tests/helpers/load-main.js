// Loads main.js outside Electron, with the `electron` module stubbed, and
// returns the internals the tests need. main.js itself is not modified: its
// source is compiled with an export line appended.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXPORTS = ['crawl', 'config', 'writeUnique', 'drawingSetHash', 'samePath', 'readPackage'];

function loadMain() {
  const noop = () => {};
  const electron = {
    app: {
      setPath: noop, on: noop, isPackaged: false,
      getPath: () => os.tmpdir(), getVersion: () => '0.0.0',
      whenReady: () => new Promise(() => {})     // never boots a window
    },
    BrowserWindow: function () {},
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: noop },
    ipcMain: { handle: noop, on: noop },
    dialog: {}, shell: {}
  };
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? electron : load.call(this, request, ...rest);
  };
  // DATA_DIR is worked out from APPDATA before anything else runs.
  process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbler-appdata-'));
  try {
    const file = path.join(__dirname, '..', '..', 'main.js');
    const src = fs.readFileSync(file, 'utf8') + `\nmodule.exports = { ${EXPORTS.join(', ')} };\n`;
    const m = new Module(file, module);
    m.filename = file;
    m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(src, file);
    return m.exports;
  } finally {
    Module._load = load;
  }
}

module.exports = { loadMain };
