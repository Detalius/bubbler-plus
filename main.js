const path = require('path');
const fsSync = require('fs');

// ---------------------------------------------------------------------------
// The data folder — config, recents, crash recovery and the local index.
//
// ALWAYS the per-user app data folder (%APPDATA%\Bubbler+ on Windows), never
// beside the executable: an installer update removes the old version's folder.
// Worked out by hand, with Electron's own rule (productName, else name),
// because the pool sizing below needs config.json before `electron` may be
// required. app.setPath() pins Electron to the same folder once it loads.
// ---------------------------------------------------------------------------
const DATA_DIR = (() => {
  const os = require('os');
  const pkg = require('./package.json');
  const name = pkg.productName || pkg.name;
  const home = os.homedir();
  const base = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return path.join(base, name);
})();

// ---------------------------------------------------------------------------
// Thread pool size — MUST be settled before anything does asynchronous I/O.
//
// Node's async filesystem calls run on libuv's thread pool, sized once from
// UV_THREADPOOL_SIZE the first time anything uses it. The default of 4 would
// cap CONCURRENCY. Everything above here is synchronous and never touches the
// pool; NOTHING that does async I/O may go above this line. A value already in
// the environment is left alone.
// ---------------------------------------------------------------------------
// CONCURRENCY from config.json, read synchronously.
function bootConcurrency() {
  try {
    const n = JSON.parse(fsSync.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')).CONCURRENCY;
    if (Number.isFinite(n) && n > 0) return Math.min(64, Math.round(n));
  } catch { /* absent or unreadable — the default below stands */ }
  return 8;
}
// Headroom over CONCURRENCY: the crawl is not the only thing using the pool,
// and a thread parked on a network read costs a stack and nothing else.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(Math.max(8, bootConcurrency() + 8));
}

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
app.setPath('userData', DATA_DIR);
// Chromium's own caches (GPU, code cache, storage) go in a subfolder, so the
// data folder a user opens holds this app's files and not a pile of Chromium's.
app.setPath('sessionData', path.join(DATA_DIR, 'Session'));
const fs = require('fs/promises');
const os = require('os');

let win = null;

// ---------------------------------------------------------------------------
// Config
//
// config.json, in the data folder. Missing or malformed config isn't fatal: the
// app runs, and the search has nowhere to look until a folder is set.
// ---------------------------------------------------------------------------
const CONFIG_DEFAULTS = {
  NETWORK_PATH: '',        // share root to crawl, e.g. //server/share/Parts
  // Where the sidecar index lives; may sit outside the NETWORK_PATH tree.
  SIDECAR_PATH: '',
  // The folder inside a part folder that holds the .insp packages. The crawl
  // recognises a part folder by it.
  PACKAGE_DIR: 'QC',
  ARCHIVE_DIR: 'Archive',  // sub-folder inside the package folder, superseded revisions
  // How far below the root a package folder may sit, counting the root's
  // children as level 1: ROOT/CUSTOMER/PART/QC is 3, ROOT/PART/QC is 2. ROOT/QC
  // is always found.
  SEARCH_DEPTH: 4,
  // Directory reads in flight at once. Also sizes the thread pool at startup,
  // so a change takes effect on the next launch.
  CONCURRENCY: 8,
  // Inches of margin when PRINTING A DRAWING. Sheets never get one: their
  // geometry is measured against a full page.
  PRINT_MARGIN_IN: 0.25
};
let config = { ...CONFIG_DEFAULTS };

// The data folder, created on first use.
let dataReady = false;
function appDir() {
  if (!dataReady) {
    try { fsSync.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* reported by whoever writes */ }
    dataReady = true;
  }
  return DATA_DIR;
}

ipcMain.handle('app:open-data-folder', async () => {
  const err = await shell.openPath(appDir());
  return err ? { ok: false, error: err, path: DATA_DIR } : { ok: true, path: DATA_DIR };
});
ipcMain.handle('app:data-folder', () => DATA_DIR);
ipcMain.handle('app:version', () => app.getVersion());

function configPath() {
  return path.join(appDir(), 'config.json');
}

function loadConfig() {
  try {
    const p = configPath();
    if (!fsSync.existsSync(p)) {
      console.warn('[Config] config.json not found; using defaults.');
      return;
    }
    config = { ...CONFIG_DEFAULTS, ...JSON.parse(fsSync.readFileSync(p, 'utf8')) };
  } catch (err) {
    console.error('[Config] Could not read config.json:', err.message);
  }
}

async function saveConfig() {
  try {
    await fs.writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[Config] Could not write config.json:', err.message);
    return false;
  }
}

// Every filesystem call on a share gets a deadline: an unreachable SMB path
// otherwise hangs the whole operation with no feedback.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

ipcMain.handle('config:get', () => ({ ...config }));

ipcMain.handle('config:set', async (_event, patch) => {
  config = { ...config, ...patch };
  await saveConfig();
  return { ...config };
});

// Verifies a share root is actually reachable before it gets saved.
ipcMain.handle('config:test-path', async (_event, dir) => {
  if (!dir) return { ok: false, reason: 'No folder set' };
  try {
    const entries = await withTimeout(
      fs.readdir(dir, { withFileTypes: true }), 4000, 'Share read');
    return { ok: true, folders: entries.filter(e => e.isDirectory()).length };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

ipcMain.handle('dialog:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (win) win.focus();
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

function send(action) {
  if (win) win.webContents.send('menu-action', action);
}

// ---------------------------------------------------------------------------
// Native file dialogs
// ---------------------------------------------------------------------------
const FILTERS = {
  any: [
    { name: 'Inspection package or drawing', extensions: ['insp', 'pdf'] },
    { name: 'Inspection package', extensions: ['insp'] },
    { name: 'PDF drawing', extensions: ['pdf'] }
  ],
  pdf: [{ name: 'PDF drawing', extensions: ['pdf'] }],
  workbook: [{ name: 'Excel workbook', extensions: ['xlsx', 'xlsm', 'xltx', 'xltm'] }],
  insp: [{ name: 'Inspection package', extensions: ['insp'] }]
};

ipcMain.handle('dialog:open', async (_event, intent) => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: FILTERS[intent] || FILTERS.any
  });
  if (win) win.focus();
  if (result.canceled || !result.filePaths.length) return null;
  const file = result.filePaths[0];
  const buffer = await fs.readFile(file);
  return { name: path.basename(file), path: file, data: new Uint8Array(buffer) };
});

// A file's size and mtime, or null if it's absent. Both, since mtime alone is
// coarse on some filesystems.
async function fileStamp(file) {
  try {
    const st = await withTimeout(fs.stat(file), 5000, 'stat');
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

const sameStamp = (a, b) =>
  !!a && !!b && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2;

// Writes to `file`, or to "name (2).ext", "name (3).ext"… if it's taken, and
// returns the path used. 'wx' fails on an existing file, so the check and the
// write are one step and two writers can't both claim a name. Runs for batch
// exports into a folder, from dialog:save's noClobber.
async function writeUnique(file, data) {
  const { dir, name, ext } = path.parse(file);
  for (let n = 2; ; n++) {
    try {
      await fs.writeFile(file, Buffer.from(data), { flag: 'wx' });
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      file = path.join(dir, `${name} (${n})${ext}`);
    }
  }
}

// `filePath` set: write there (Save). Unset: ask where (Save As, first save).
// `noClobber` never overwrites; `expect` refuses if the file changed since it
// was read.
ipcMain.handle('dialog:save', async (_event, { filePath, defaultPath, data, filters, expect, noClobber }) => {
  let target = filePath;
  let chosen = false;
  if (!target) {
    const result = await dialog.showSaveDialog(win, { defaultPath, filters });
    if (win) win.focus();
    if (result.canceled || !result.filePath) return null;
    target = result.filePath;
    chosen = true;
  }
  if (noClobber && !chosen) {
    target = await writeUnique(target, data);
    return { path: target, name: path.basename(target), stamp: await fileStamp(target) };
  }
  // The file on disk is the real guard; a lock is only advisory. Not for a path
  // just picked, whose own overwrite prompt stands.
  if (expect && !chosen) {
    const now = await fileStamp(target);
    if (now && !sameStamp(now, expect)) {
      return { conflict: true, path: target, name: path.basename(target) };
    }
  }
  // Save As onto a package another session has open: the OS prompt can't know
  // it's live. Refused before writing.
  if (chosen) {
    const by = await lockHolder(target);
    if (by) return { locked: true, by, path: target, name: path.basename(target) };
  }
  await fs.writeFile(target, Buffer.from(data));
  return { path: target, name: path.basename(target), stamp: await fileStamp(target) };
});

// ---------------------------------------------------------------------------
// Excel export
//
// The renderer never sees workbook bytes: it sends a path and columns, and main
// reads, appends and writes, off the renderer's thread.
// ---------------------------------------------------------------------------
ipcMain.handle('xlsx:pick', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a workbook to add data to',
    properties: ['openFile'],
    filters: [...FILTERS.workbook, ...FILTERS.any]
  });
  if (win) win.focus();
  if (result.canceled || !result.filePaths.length) return null;
  const file = result.filePaths[0];
  return { path: file, name: path.basename(file) };
});

ipcMain.handle('xlsx:append', async (_event, { file, sheets }) => {
  try {
    const { appendSheets } = require('./xlsx-append');
    const before = await fs.readFile(file);
    const { bytes, added } = appendSheets(before, sheets);

    // Written beside the target and renamed over it: rename is atomic, so a
    // crash mid-write leaves the original intact.
    const tmp = `${file}.bubbler-tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, file);
    return { ok: true, added };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ---------------------------------------------------------------------------
// Assets and printing
// ---------------------------------------------------------------------------
// Asset bytes (fonts, the logo) for the renderer. fetch() on a file:// origin
// is unreliable.
ipcMain.handle('asset:read', async (_event, name) => {
  if (!/^[\w.-]+$/.test(name)) throw new Error('Bad asset name');
  const buf = await fs.readFile(path.join(__dirname, 'assets', name));
  return new Uint8Array(buf);
});

// Renders a standalone HTML document to PDF in an offscreen window. Runs for
// every sheet and record PDF.
ipcMain.handle('print:pdf', async (_event, { html, landscape }) => {
  const w = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false }
  });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // Fonts are embedded as data URIs, but give layout a beat to settle.
    await new Promise(r => setTimeout(r, 250));
    const pdf = await w.webContents.printToPDF({
      pageSize: 'Letter',
      landscape: !!landscape,
      printBackground: true,
      preferCSSPageSize: false,
      margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 }
    });
    return new Uint8Array(pdf);
  } finally {
    w.destroy();
  }
});

// Prints a PDF the renderer has already produced, through a temp file: a
// data URL of a multi-megabyte PDF means a huge base64 string. Margins are 'none'
// for both print paths: sheets fill the page, and a drawing's margin is baked
// into its bytes, since Chromium's PDF viewer ignores this option.
ipcMain.handle('print:pdfBytes', async (_event, { data, landscape }) => {
  const tmp = path.join(app.getPath('temp'), `bubbler-print-${Date.now()}.pdf`);
  await fs.writeFile(tmp, Buffer.from(data));
  const w = new BrowserWindow({ show: false, webPreferences: { plugins: true } });
  try {
    await w.loadURL('file://' + tmp.replace(/\\/g, '/'));
    await new Promise(r => setTimeout(r, 600));      // let the PDF viewer lay out
    return await new Promise(resolve => {
      w.webContents.print(
        { silent: false, printBackground: true, landscape: !!landscape,
          margins: { marginType: 'none' } },
        (ok, reason) => resolve({ ok, reason })
      );
    });
  } finally {
    setTimeout(() => {
      try { w.destroy(); } catch {}
      fs.unlink(tmp).catch(() => {});
    }, 1500);
  }
});

// Renders a sheet's HTML in a hidden window and opens the system print dialog.
// Margins 'none', matching print:pdf: the geometry is measured against the
// whole page.
ipcMain.handle('print:dialog', async (_event, { html, landscape }) => {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise(r => setTimeout(r, 250));
    return await new Promise(resolve => {
      w.webContents.print(
        { silent: false, printBackground: true, landscape: !!landscape,
          margins: { marginType: 'none' } },
        (ok, reason) => resolve({ ok, reason })
      );
    });
  } finally {
    setTimeout(() => { try { w.destroy(); } catch {} }, 500);
  }
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
ipcMain.handle('window:title', (_event, title) => {
  if (win) win.setTitle(title);
});

// Closing round-trips to the renderer, which alone knows the dirty state, but
// 'close' is synchronous: cancel it, ask, then re-issue it on the answer.
let allowClose = false;
let closePending = false;

// Renderer's verdict on a pending close.
ipcMain.handle('window:close-confirmed', (_event, ok) => {
  closePending = false;
  if (!ok || !win) return;
  allowClose = true;
  win.close();
});

// ---------------------------------------------------------------------------
// Package hashing
// ---------------------------------------------------------------------------
const fflate = require('fflate');
const crypto = require('crypto');

// Identifies the exact set of drawings a package holds. Must match the
// renderer's drawingSetString() byte for byte: non-empty hashes, deduped,
// sorted, newline-joined.
function drawingSetHash(list) {
  const canon = [...new Set((list || []).filter(Boolean))].sort().join('\n');
  if (!canon) return null;
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Share index — sidecars
//
// The index is a folder of small JSON files, written whenever a package is saved
// or opened:
//
//   <root>/pkg/<packageId>.json        the record: path, part, drawing hashes
//   <root>/hash/<sha256>/<pkgId>.json  a pointer, one per drawing
//   <root>/set/<setHash>/<pkgId>.json  a pointer, one per drawing set
//
// Resolution is a path read, not a search. A directory per hash, since one
// drawing can sit in several packages; one file per package, so no two machines
// ever write the same file. Packages stay self-contained and work with no share.
// ---------------------------------------------------------------------------
const SIDECAR_DIR = '.bubbler-index';

// TWO indexes, kept DISJOINT by routing:
//
//   shared — every package under the packages root
//   local  — everything else, in the data folder
//
// No package belongs to both, so reading both is a concatenation. Everything in
// the shared index is reachable from every machine, which is what lets
// markMissing() judge it; a package on someone's desktop stays local and is
// never reported missing elsewhere.
const localRoot = () => path.join(appDir(), SIDECAR_DIR);

// The shared index, or null. Only honoured when a packages root is set: without
// one there is nothing to crawl, and relative paths have nothing to resolve
// against.
const sharedRoot = () =>
  (config.NETWORK_PATH && config.SIDECAR_PATH) ? config.SIDECAR_PATH : null;

// Where a write goes when nothing more specific is known, and what the Settings
// line describes. Reads go through indexRoots(), which covers both.
const indexRoot = () => sharedRoot() || localRoot();
const indexIsLocal = () => !sharedRoot();
const indexRoots = () => {
  const s = sharedRoot();
  return s ? [{ root: s, shared: true }, { root: localRoot(), shared: false }]
           : [{ root: localRoot(), shared: false }];
};

const pkgFileIn = (root, id) => path.join(root, 'pkg', `${safeName(id)}.json`);
const hashDirIn = (root, h) => path.join(root, 'hash', safeName(h));
// One drawing may sit in many packages; a drawing SET identifies one package
// version exactly, which is what an inspection record was taken against.
const setDirIn = (root, h) => path.join(root, 'set', safeName(h));

// Ids and hashes are ours, but never build a path from unvalidated input.
const safeName = v => String(v || '').replace(/[^\w.-]/g, '_').slice(0, 120);

// Windows is case-insensitive and takes either separator, so two spellings of
// one file must compare equal.
const samePath = (a, b) => {
  if (!a || !b) return false;
  const n = p => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? n(a).toLowerCase() === n(b).toLowerCase()
    : n(a) === n(b);
};

const insideRoot = file => {
  const root = config.NETWORK_PATH;
  if (!root || !file) return false;
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

function targetRoot(file) {
  const s = sharedRoot();
  if (s && insideRoot(file)) return { root: s, shared: true };
  return { root: localRoot(), shared: false };
}

// Shared records store the path relative to the packages root, so machines
// reaching the share by different names (Z:\Jobs, \\srv\jobs) write identical
// bytes. Resolved on read, so nothing downstream handles a relative path.
const toStored = (file, shared) =>
  shared ? path.relative(config.NETWORK_PATH, file) : file;
const fromStored = (p, shared) =>
  (shared && p && !path.isAbsolute(p)) ? path.join(config.NETWORK_PATH, p) : p;

async function readJson(file) {
  try {
    return JSON.parse(await withTimeout(fs.readFile(file, 'utf8'), 5000, 'Sidecar read'));
  } catch {
    return null;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await withTimeout(
    fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8'), 8000, 'Sidecar write');
}

// Every read of a record goes through here, so `path` is absolute everywhere
// above this line and `sharedIndex` says which index it came from.
async function readRecord(root, shared, id) {
  const rec = await readJson(pkgFileIn(root, id));
  if (!rec) return null;
  rec.path = fromStored(rec.path, shared);
  rec.sharedIndex = shared;
  return rec;
}

// Is this package id already indexed against a DIFFERENT file that still
// exists? That separates a copy (old path alive) from a move (old path dead).
// Used by publishSidecar()'s open check and by the fork check on save.
async function idTakenElsewhere(packageId, file) {
  if (!packageId) return { taken: false, at: null };
  for (const { root, shared } of indexRoots()) {
    const rec = await readRecord(root, shared, packageId);
    if (!rec?.path || samePath(rec.path, file)) continue;
    if (await reachable(rec.path)) return { taken: true, at: rec.path };
  }
  return { taken: false, at: null };
}

// Removes a record and every pointer to it from ONE index. The package itself is
// untouched.
async function unpublish(root, shared, packageId) {
  const rec = await readRecord(root, shared, packageId);
  if (!rec) return false;
  const rm = async f => { try { await fs.unlink(f); } catch { /* already gone */ } };
  if (rec.drawingSetHash) {
    await rm(path.join(setDirIn(root, rec.drawingSetHash), `${safeName(packageId)}.json`));
  }
  for (const d of rec.drawings || []) {
    if (d.sha256) await rm(path.join(hashDirIn(root, d.sha256), `${safeName(packageId)}.json`));
  }
  await rm(pkgFileIn(root, packageId));
  return true;
}

// Writes a package's record and one pointer per drawing, and clears pointers for
// drawings it no longer holds. Runs after every save and open, and for each
// package a rebuild finds.
async function publishSidecar(entry) {
  if (!entry?.packageId || !entry?.file) return { ok: false, reason: 'no-package' };

  // Opening never takes another file's record: if the id is indexed against a
  // different file that still exists, this is a copy. `forked` tells the renderer
  // to mint a new id on save; opening never writes the file.
  if (entry.onOpen) {
    const clash = await idTakenElsewhere(entry.packageId, entry.file);
    if (clash.taken) return { ok: true, forked: true, at: clash.at };
  }

  const { root, shared } = targetRoot(entry.file);
  const prev = await readRecord(root, shared, entry.packageId);
  const record = {
    packageId: entry.packageId,
    path: toStored(entry.file, shared),
    partNumber: entry.partNumber || '',
    partRev: entry.partRev || '',
    partName: entry.partName || '',
    customer: entry.customer || '',
    drawingSetHash: entry.drawingSetHash ||
      drawingSetHash((entry.drawings || []).map(d => d.sha256)),
    drawings: (entry.drawings || []).map(d => ({ id: d.id, sha256: d.sha256, label: d.label })),
    sheets: entry.sheets || 0,
    inspections: entry.inspections || 0,
    updatedUtc: new Date().toISOString()
  };

  try {
    await writeJson(pkgFileIn(root, record.packageId), record);
    const ptr = { packageId: record.packageId, path: record.path };
    if (record.drawingSetHash) {
      await writeJson(path.join(setDirIn(root, record.drawingSetHash),
        `${safeName(record.packageId)}.json`), ptr);
    }
    const now = new Set(record.drawings.map(d => d.sha256).filter(Boolean));
    for (const h of now) {
      await writeJson(path.join(hashDirIn(root, h), `${safeName(record.packageId)}.json`), ptr);
    }
    // A changed drawing set leaves its old pointer behind.
    if (prev?.drawingSetHash && prev.drawingSetHash !== record.drawingSetHash) {
      try {
        await fs.unlink(path.join(setDirIn(root, prev.drawingSetHash),
          `${safeName(record.packageId)}.json`));
      } catch { /* already gone */ }
    }
    // Drawings removed since the last save leave pointers behind.
    for (const d of (prev?.drawings || [])) {
      if (d.sha256 && !now.has(d.sha256)) {
        try {
          await fs.unlink(path.join(hashDirIn(root, d.sha256), `${safeName(record.packageId)}.json`));
        } catch { /* already gone */ }
      }
    }
    // A package moved into or out of the share keeps its id, so its record in the
    // other index is removed; a stale one would list twice.
    for (const other of indexRoots()) {
      if (samePath(other.root, root)) continue;
      if (await unpublish(other.root, other.shared, record.packageId)) {
        console.info('[Index] Moved', record.packageId,
                     other.shared ? 'out of the shared index' : 'out of the local index');
      }
    }
    return { ok: true, shared };
  } catch (err) {
    console.error('[Index] Could not publish sidecar:', err.message);
    return { ok: false, reason: err.message };
  }
}

// A sidecar is only trusted if the package it names is still there.
async function sidecarIfLive(record) {
  if (!record?.path) return null;
  return await reachable(record.path) ? record : null;
}

// Reads every pointer in a directory and resolves each to its live package.
async function followPointers(root, shared, dir) {
  let names = [];
  try {
    names = await withTimeout(fs.readdir(dir), 5000, 'Pointer read');
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const ptr = await readJson(path.join(dir, n));
    if (!ptr?.packageId) continue;
    const rec = await sidecarIfLive(await readRecord(root, shared, ptr.packageId));
    if (rec) out.push(rec);
  }
  return out;
}

// Finds packages by drawing set, drawing hash or id, with direct reads. Shared
// index first; the two are disjoint, so the first hit is the answer.
async function lookupSidecar({ drawingSetHash: setHash = null, sha256List = [], packageId = null }) {
  for (const { root, shared } of indexRoots()) {
    // Most precise first: a drawing set names one package version exactly, where
    // a single drawing may be shared by several.
    if (setHash) {
      const out = await followPointers(root, shared, setDirIn(root, setHash));
      if (out.length) return { via: 'drawingSet', entries: out };
    }
    for (const h of sha256List) {
      if (!h) continue;
      const out = await followPointers(root, shared, hashDirIn(root, h));
      if (out.length) return { via: 'sha256', entries: out };
    }
    if (packageId) {
      const rec = await sidecarIfLive(await readRecord(root, shared, packageId));
      if (rec) return { via: 'packageId', entries: [rec] };
    }
  }
  return { via: null, entries: [] };
}

// Who the OS says is at the keyboard. Unverified; the audit trail says so
// wherever it is shown.
ipcMain.handle('identity:get', () => {
  let user = '';
  try { user = os.userInfo().username || ''; } catch { /* no account info */ }
  return {
    user: user || process.env.USERNAME || process.env.USER || 'unknown',
    host: os.hostname() || ''
  };
});

ipcMain.handle('sidecar:publish', (_event, entry) => publishSidecar(entry));

// The fork check at save time: only the index and the filesystem can answer it.
ipcMain.handle('index:id-taken', (_event, { packageId, file }) =>
  idTakenElsewhere(packageId, file));

ipcMain.handle('index:stats', async () => {
  const root = indexRoot();
  if (!root) return { root: null, packages: 0, hashes: 0, path: null };
  let packages = 0, hashes = 0;
  try {
    packages = (await fs.readdir(path.join(root, 'pkg'))).filter(f => f.endsWith('.json')).length;
  } catch { /* not built yet */ }
  try {
    hashes = (await fs.readdir(path.join(root, 'hash'))).length;
  } catch { /* not built yet */ }
  let sets = 0, missing = 0;
  try {
    sets = (await fs.readdir(path.join(root, 'set'))).length;
  } catch { /* none yet */ }
  try {
    for (const n of await fs.readdir(path.join(root, 'pkg'))) {
      if (!n.endsWith('.json')) continue;
      const rec = await readJson(path.join(root, 'pkg', n));
      if (rec?.missing) missing++;
    }
  } catch { /* none yet */ }
  return { root: config.NETWORK_PATH || config.SIDECAR_PATH,
           local: indexIsLocal(), packages, hashes, sets, missing, path: root };
});

// Reads a package's index entry. Only manifest.json is decompressed; the
// drawings are the bulk of the zip.
async function readPackage(file) {
  const buf = await withTimeout(fs.readFile(file), 8000, 'Package read');
  const files = fflate.unzipSync(new Uint8Array(buf),
    { filter: f => f.name === 'manifest.json' });
  const raw = files['manifest.json'];
  if (!raw) return null;
  const m = JSON.parse(Buffer.from(raw).toString('utf8'));
  const st = await fs.stat(file);
  return {
    file,
    dir: path.dirname(file),
    name: path.basename(file),
    mtimeMs: st.mtimeMs,
    size: st.size,
    schemaVersion: m.schemaVersion || null,
    packageId: m.package?.id || null,
    // Derived when absent, for packages written before the field existed.
    drawingSetHash: m.package?.drawingSetHash ||
      drawingSetHash((m.documents || []).map(d => d.sha256)),
    partNumber: m.part?.number || '',
    partRev: m.part?.revision || '',
    partName: m.part?.name || '',
    customer: m.part?.customer?.name || '',
    drawings: (m.documents || []).map(d => ({
      id: d.id, sha256: d.sha256, label: d.label, pages: d.pages
    })),
    sheets: (m.inspectionSheets || []).length,
    inspections: (m.inspections || []).length,
    scannedUtc: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Share crawl
// ---------------------------------------------------------------------------
const FANOUT_DEFAULT = 16;

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

// null means the folder could not be read; [] means it is empty. Keeping those
// apart is the point — see the deadline note in drain().
async function dirEntries(dir) {
  try {
    return await withTimeout(fs.readdir(dir, { withFileTypes: true }), 6000, `Read ${dir}`);
  } catch (err) {
    // Named, so a permissions problem can be told from a share problem.
    console.warn('[Index] Could not read', dir, '-', err.message);
    return null;
  }
}

// One queue for the whole crawl, fed by the workers as they find folders, so
// `limit` is the real number of reads in flight. Each read's deadline starts when
// it is CREATED: stacked-up reads would time out while queued and read as empty
// on a healthy share.
async function drain(seeds, limit, work) {
  const queue = [...seeds];
  let active = 0, failed = null;
  await new Promise(resolve => {
    const pump = () => {
      if (failed || (!queue.length && !active)) return resolve();
      while (active < limit && queue.length) {
        const task = queue.shift();
        active++;
        Promise.resolve(work(task, t => queue.push(t)))
          .catch(err => { failed = err; })
          .finally(() => { active--; pump(); });
      }
    };
    pump();
  });
  if (failed) throw failed;
}

// Walks the share for part folders. A folder holding a PACKAGE_DIR is a part
// folder: its packages are read and nothing below it is walked, except at the
// root, whose other folders are still walked. Any other folder is a container,
// and only its sub-folders are walked. One listing per folder, with file types,
// so files are never probed. Runs for a rebuild and from the source resolver.
//   opts.stopWhen       — called per package; truthy ends the crawl
//   opts.nameHint       — only open part folders whose name contains this
//   opts.customerHint   — narrows the top level
//   opts.includeArchive — also read each package folder's Archive
async function crawl(root, depth, onProgress, opts = {}) {
  const found = [];
  let listed = 0, unreadable = 0, done = false;
  // The paths, so markMissing() skips records inside them. Capped: it rides the
  // progress channel.
  const unreadablePaths = [];
  // Diagnostics: listings and part folders per depth, which show whether
  // SEARCH_DEPTH could come down.
  const listedAt = [], partsAt = [];
  const limit = Math.max(1, opts.fanout || config.CONCURRENCY || FANOUT_DEFAULT);
  // Archives double the round trips; a rebuild skips them, the resolver asks.
  const withArchive = opts.includeArchive === true;
  const hint = (opts.nameHint || '').toLowerCase();
  const custHint = (opts.customerHint || '').toLowerCase();
  // A part folder sits between depth 0 (the root) and SEARCH_DEPTH - 1.
  const maxPart = Math.max(1, (depth || 4) - 1);
  const pkgDir = (config.PACKAGE_DIR || 'QC').toLowerCase();

  // Progress per folder listed, throttled.
  let lastSent = 0;
  const report = label => {
    const now = Date.now();
    if (now - lastSent < 100) return;
    lastSent = now;
    onProgress({ phase: 'scan', label, count: found.length, scanned: listed, unreadable });
  };

  // Reads the .insp files in a listing already in hand.
  async function collect(dir, entries, archived) {
    for (const e of entries) {
      if (done) return;
      if (!e.isFile() || !/\.insp$/i.test(e.name)) continue;
      try {
        const rec = await readPackage(path.join(dir, e.name));
        if (!rec) continue;
        rec.archived = archived;
        found.push(rec);
        if (opts.stopWhen && opts.stopWhen(rec)) { done = true; return; }
      } catch (err) {
        console.warn('[Index] Skipped', e.name, '-', err.message);
      }
    }
  }

  // Reads a part folder's package folder, and its Archive if asked, found in the
  // listing already in hand.
  async function takeQC(qc) {
    const entries = await dirEntries(qc);
    if (!entries) {
      unreadable++;
      if (unreadablePaths.length < 50) unreadablePaths.push(qc);
      return;
    }
    listed++;
    await collect(qc, entries, false);
    if (!withArchive || done) return;
    const want = (config.ARCHIVE_DIR || 'Archive').toLowerCase();
    const a = entries.find(e => e.isDirectory() && e.name.toLowerCase() === want);
    if (!a) return;
    const dir = path.join(qc, a.name);
    const inner = await dirEntries(dir);
    if (!inner) { unreadable++; return; }
    listed++;
    await collect(dir, inner, true);
  }

  async function visit({ dir, level }, push) {
    if (done) return;
    const entries = await dirEntries(dir);
    // An unreadable folder is NOT an empty one: it is counted and reported.
    if (!entries) {
      unreadable++;
      if (unreadablePaths.length < 50) unreadablePaths.push(dir);
      return;
    }
    listed++;
    listedAt[level] = (listedAt[level] || 0) + 1;
    report(path.basename(dir));

    const dirs = entries.filter(e => e.isDirectory());
    const qc = dirs.find(e => e.name.toLowerCase() === pkgDir);
    if (qc) {
      // A part folder either way; the hint only decides whether to read it.
      partsAt[level] = (partsAt[level] || 0) + 1;
      if (!hint || path.basename(dir).toLowerCase().includes(hint)) {
        await takeQC(path.join(dir, qc.name));
      }
      // The root's package folder is read, and the root is still walked.
      if (level >= 1) return;
    }
    if (level >= maxPart) return;

    let names = dirs.map(e => e.name).filter(n => n.toLowerCase() !== pkgDir);
    // The customer hint narrows the top level, but never to nothing.
    if (level === 0 && custHint) {
      const narrowed = names.filter(n =>
        n.toLowerCase().includes(custHint) || custHint.includes(n.toLowerCase()));
      if (narrowed.length) names = narrowed;
    }
    for (const n of names) push({ dir: path.join(dir, n), level: level + 1 });
  }

  await drain([{ dir: root, level: 0 }], limit, visit);
  // Final totals, unthrottled. The progress channel is the only way they leave
  // the crawl, since a rebuild and the resolver can run at once.
  onProgress({ phase: 'scan', label: '', count: found.length, scanned: listed,
               unreadable, unreadablePaths });
  console.info('[Index] crawl shape (depth: folders listed / holding a QC) —',
    listedAt.map((n, i) => `${i}: ${n || 0}/${partsAt[i] || 0}`).join('  '),
    `| ${unreadable} unreadable, limit ${limit}, pool ${process.env.UV_THREADPOOL_SIZE}`);
  return found;
}

// Rebuilds every sidecar by crawling the share, for packages moved by hand,
// restored from backup, or written by an older build. Settings > Rebuild.
ipcMain.handle('index:rebuild', async (event) => {
  const root = config.NETWORK_PATH;
  // With no packages root there is only the local index: re-check the records it
  // holds, by reachability alone.
  if (!root) {
    const started = Date.now();
    const { missing, checked } = await markMissing(localRoot(), false, new Set());
    return { ok: true, checkOnly: true, packages: checked, written: 0, missing,
             folders: 0, unreadable: 0, duplicates: 0,
             seconds: (Date.now() - started) / 1000 };
  }
  // The crawl's totals arrive on the progress channel.
  let listed = 0, unreadable = 0, unreadablePaths = [];
  const send = p => {
    if (p.phase === 'scan') {
      listed = p.scanned; unreadable = p.unreadable;
      if (p.unreadablePaths) unreadablePaths = p.unreadablePaths;
    }
    try { event.sender.send('index-progress', p); } catch {}
  };
  const started = Date.now();
  try {
    send({ phase: 'start' });
    const entries = await crawl(root, config.SEARCH_DEPTH || 4, send,
      { includeArchive: false });

    // A package copied by hand gives two files one id. Settle it before writing,
    // the same way every run: the file the index already names if it still exists,
    // else the lowest path. Never mtime, which a copy changes.
    const byId = new Map();
    let duplicates = 0;
    for (const e of entries) {
      const prev = byId.get(e.packageId);
      if (!prev) { byId.set(e.packageId, e); continue; }
      duplicates++;
      const tr = targetRoot(e.file);
      const known = await readRecord(tr.root, tr.shared, e.packageId);
      const keep =
        known?.path && samePath(known.path, prev.file) ? prev
        : known?.path && samePath(known.path, e.file) ? e
        : (prev.file <= e.file ? prev : e);
      byId.set(e.packageId, keep);
      console.warn('[Index] Two packages share an id:', prev.file, 'and', e.file,
                   '- indexing', keep.file);
    }
    const unique = [...byId.values()];

    let written = 0;
    // Bounded like the crawl: each is a round trip to the index share.
    await mapLimit(unique, Math.max(1, config.CONCURRENCY || FANOUT_DEFAULT), async e => {
      const r = await publishSidecar(e);
      if (r.ok) written++;
    });

    // A full crawl is authoritative about the packages root: anything it didn't
    // find is flagged missing, not deleted, since a record PDF may still point at
    // it. On ids, never inside a folder the crawl couldn't read.
    const found = new Set(unique.map(e => e.packageId));
    // Every crawl entry is in-root, so all route to the same index.
    const crawled = sharedRoot()
      ? { root: sharedRoot(), shared: true }
      : { root: localRoot(), shared: false };
    const { missing } = await markMissing(crawled.root, crawled.shared, found, unreadablePaths);

    // The crawl only covers the packages root, so the local index gets the
    // reachability-only check too.
    let localMissing = 0;
    if (crawled.shared) {
      ({ missing: localMissing } = await markMissing(localRoot(), false, new Set()));
    }

    const out = { ok: true, packages: unique.length, written,
                  missing: missing + localMissing, duplicates,
                  folders: listed, unreadable,
                  seconds: (Date.now() - started) / 1000 };
    send({ phase: 'done', ...out });
    return out;
  } catch (err) {
    send({ phase: 'error', reason: err.message });
    return { ok: false, reason: err.message };
  }
});

// ---------------------------------------------------------------------------
// Source resolver
//
// Finds the package a record came from. The index first (a few path reads), then
// a crawl; anything the crawl finds is indexed, so the next lookup is instant.
// ---------------------------------------------------------------------------
ipcMain.handle('source:resolve', async (event, query) => {
  const send = p => { try { event.sender.send('index-progress', p); } catch {} };

  const hit = await lookupSidecar(query);
  if (hit.entries.length) return pickBest(hit.via, hit.entries);

  const root = config.NETWORK_PATH;
  if (!root) return { ok: false, reason: 'No share root set. Open Settings first.' };
  const depth = config.SEARCH_DEPTH || 4;
  const wanted = new Set((query.sha256List || []).filter(Boolean));
  const stopWhen = rec =>
    (query.drawingSetHash && rec.drawingSetHash === query.drawingSetHash) ||
    (query.packageId && rec.packageId === query.packageId) ||
    (rec.drawings || []).some(d => wanted.has(d.sha256));

  const publishAll = async found => {
    for (const e of found) await publishSidecar(e);
  };
  const matched = found => found.filter(stopWhen);

  try {
    // Narrow by customer, then part number, and stop at the first match.
    send({ phase: 'start', label: 'Searching' });
    let found = await crawl(root, depth, send, {
      stopWhen,
      nameHint: query.partNumber || '',
      customerHint: query.customer || '',
      includeArchive: true          // scoped to one part folder, so it's cheap
    });
    await publishAll(found);
    let hits = matched(found);
    if (hits.length) { send({ phase: 'done' }); return pickBest('scan', hits); }

    // Widen: drop the hints and sweep, still stopping at the first match.
    send({ phase: 'start', label: 'Widening search' });
    found = await crawl(root, depth, send, { stopWhen, includeArchive: true });
    await publishAll(found);
    hits = matched(found);
    send({ phase: 'done' });
    if (hits.length) return pickBest('scan', hits);
  } catch (err) {
    send({ phase: 'error', reason: err.message });
    return { ok: false, reason: err.message };
  }

  return { ok: false, reason: 'not-found' };
});

// Prefers a current revision over an archived copy. Crawl entries carry `file`
// and records carry `path`; both come back set.
function pickBest(via, entries) {
  const norm = entries.map(e => ({ ...e, file: e.file || e.path, path: e.path || e.file }));
  const sorted = norm.sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0));
  return { ok: true, via, entry: sorted[0], candidates: sorted };
}

// ---------------------------------------------------------------------------
// Package locks
//
// Advisory: the stamp check in dialog:save is what protects the work; this says
// early that someone else has the package open. The lock file sits BESIDE the
// package, the one place every machine agrees on. Created with 'wx' (CREATE_NEW
// on Windows), atomic over SMB2, so a race has exactly one winner.
//
// The holder rewrites `beat` every LOCK_BEAT_MS; a lock quiet for LOCK_STALE_MS
// is taken over without asking. A holder that finds its token replaced drops to
// read-only.
// ---------------------------------------------------------------------------
const LOCK_BEAT_MS = 30 * 1000;
const LOCK_STALE_MS = 3 * 60 * 1000;
const lockPathFor = file => `${file}.lock`;
let held = null;                     // { file, token, timer }

function stopHeartbeat() {
  if (held?.timer) clearInterval(held.timer);
  held = null;
}

async function writeLock(file, token) {
  let user = '', host = '';
  try { user = os.userInfo().username || ''; } catch { /* no account info */ }
  try { host = os.hostname() || ''; } catch { /* no hostname */ }
  await fs.writeFile(lockPathFor(file), JSON.stringify({
    token, user: user || 'unknown', host,
    since: held?.since || new Date().toISOString(),
    beat: Date.now()
  }, null, 2), 'utf8');
}

async function heartbeat() {
  if (!held) return;
  const cur = await readJson(lockPathFor(held.file));
  // Taken over while this session was quiet: let go, and tell the renderer so it
  // goes read-only.
  if (cur && cur.token !== held.token) {
    const file = held.file;
    stopHeartbeat();
    try { win?.webContents.send('lock-lost', file); } catch { /* window gone */ }
    return;
  }
  try { await writeLock(held.file, held.token); } catch { /* share hiccup; try again next beat */ }
}

// Who holds a live lock on this file, if it is anyone but this session. A stale
// lock answers null, the same threshold acquireLock() takes one over at.
async function lockHolder(file) {
  const cur = await readJson(lockPathFor(file));
  if (!cur) return null;
  if (held && samePath(held.file, file) && cur.token === held.token) return null;
  if (Date.now() - (cur.beat || 0) >= LOCK_STALE_MS) return null;
  return { user: cur.user, host: cur.host, since: cur.since };
}

// Runs from lock:acquire: when a package opens from a path, and after Save As.
async function acquireLock(file) {
  await releaseLock();
  const token = crypto.randomUUID();
  const lp = lockPathFor(file);
  // Twice: the first EEXIST may be a stale lock this call clears. A third would
  // be live contention, which is the answer.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fh = null;
    try {
      fh = await fs.open(lp, 'wx');
      await fh.close();
      held = { file, token, since: new Date().toISOString(), timer: null };
      await writeLock(file, token);
      held.timer = setInterval(heartbeat, LOCK_BEAT_MS);
      return { ok: true };
    } catch (err) {
      try { await fh?.close(); } catch { /* never opened */ }
      if (err.code !== 'EEXIST') {
        // Can't lock (read-only share, no permission): work unlocked.
        console.warn('[Lock] Could not lock', file, '-', err.message);
        return { ok: true, unlocked: true };
      }
      const cur = await readJson(lp);
      const age = Date.now() - (cur?.beat || 0);
      if (cur && age < LOCK_STALE_MS) {
        return { ok: false, by: { user: cur.user, host: cur.host, since: cur.since } };
      }
      console.info('[Lock] Taking over a stale lock on', file,
                   cur ? `(quiet ${Math.round(age / 1000)}s)` : '(unreadable)');
      try { await fs.unlink(lp); } catch { /* somebody beat us to it */ }
    }
  }
  return { ok: false, by: null };
}

async function releaseLock() {
  if (!held) return;
  const { file, token } = held;
  stopHeartbeat();
  const cur = await readJson(lockPathFor(file));
  if (cur && cur.token !== token) return;      // not ours any more
  try { await fs.unlink(lockPathFor(file)); } catch { /* already gone */ }
}

ipcMain.handle('lock:acquire', (_event, file) =>
  (typeof file === 'string' && file) ? acquireLock(file) : { ok: true, unlocked: true });
ipcMain.handle('lock:release', () => releaseLock());

// Quitting has no time for a promise to settle, so this one is synchronous.
app.on('before-quit', () => {
  if (!held) return;
  try {
    const cur = JSON.parse(fsSync.readFileSync(lockPathFor(held.file), 'utf8'));
    if (cur.token === held.token) fsSync.unlinkSync(lockPathFor(held.file));
  } catch { /* gone, or never ours */ }
  stopHeartbeat();
});

// ---------------------------------------------------------------------------
// Package files
// ---------------------------------------------------------------------------
// A stat only, so a viewer holding bytes from an earlier read can ask whether
// they are still current.
ipcMain.handle('package:stamp', async (_event, file) => {
  if (typeof file !== 'string' || !file) return null;
  return await fileStamp(file);
});

// Raw .insp bytes and their stamp, for the renderer to unzip.
ipcMain.handle('package:read', async (_event, file) => {
  if (typeof file !== 'string' || !file) throw new Error('No package path given');
  const buf = await withTimeout(fs.readFile(file), 15000, 'Package read');
  return { bytes: new Uint8Array(buf), stamp: await fileStamp(file) };
});

// ---------------------------------------------------------------------------
// Package search (the Library)
//
// Reads the index records, never the packages: a query never touches a .insp.
// ---------------------------------------------------------------------------
ipcMain.handle('index:search', async (_event, query, opts = {}) => {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  // `total` counts every record held, matching or not, so the Library can tell
  // "nothing matched" from "nothing indexed".
  let total = 0;
  const byId = new Map();

  // Shared first, so an id in both (from before routing kept them disjoint)
  // resolves the same way every time.
  for (const { root, shared } of indexRoots()) {
    const dir = path.join(root, 'pkg');
    let names = [];
    try {
      names = await withTimeout(fs.readdir(dir), 6000, 'Index read');
    } catch {
      continue;                                // this one has nothing yet
    }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const rec = await readRecord(root, shared, n.replace(/\.json$/, ''));
      if (!rec) continue;
      if (byId.has(rec.packageId)) continue;
      total++;
      // Missing packages are left out unless asked for.
      if (rec.missing && !opts.includeMissing) { byId.set(rec.packageId, null); continue; }
      // The file name too: it tells Part1_plated.insp from Part1_unplated.insp.
      const hay = [rec.partNumber, rec.partRev, rec.partName, rec.customer,
                   rec.path && path.basename(rec.path)]
        .filter(Boolean).join(' ').toLowerCase();
      // Every term must appear somewhere.
      if (terms.length && !terms.every(t => hay.includes(t))) { byId.set(rec.packageId, null); continue; }
      byId.set(rec.packageId, rec);
    }
  }

  const out = [...byId.values()].filter(Boolean);
  out.sort((a, b) => (a.partNumber || '').localeCompare(b.partNumber || '') ||
                     (a.partRev || '').localeCompare(b.partRev || ''));
  // Index totals ride along for the Library's empty state.
  return { ok: true, results: out.slice(0, 200), total,
           hasRoot: !!config.NETWORK_PATH, local: indexIsLocal() };
});

// ---------------------------------------------------------------------------
// Missing packages
// ---------------------------------------------------------------------------
// Flags a package missing when an open from the Library fails; the Library
// never stats on search.
ipcMain.handle('index:flag-missing', async (_event, packageId) => {
  for (const { root, shared } of indexRoots()) {
    const rec = await readRecord(root, shared, packageId);
    if (!rec || rec.missing) continue;
    // The failed open is the answer; no second check.
    await writeJson(pkgFileIn(root, packageId), {
      ...rec, path: toStored(rec.path, shared), sharedIndex: undefined,
      missing: true, missingSince: new Date().toISOString()
    });
    return { ok: true };
  }
  return { ok: false };
});

// Deletes every record flagged missing, with its pointers, from both indexes.
// No package file is touched. A record whose package is reachable again is kept
// and un-flagged instead. Settings > Remove missing.
ipcMain.handle('index:purge-missing', async () => {
  let removed = 0, kept = 0;
  for (const { root, shared } of indexRoots()) {
    let names = [];
    try {
      names = await withTimeout(fs.readdir(path.join(root, 'pkg')), 6000, 'Index read');
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const rec = await readRecord(root, shared, n.replace(/\.json$/, ''));
      if (!rec?.missing) continue;
      if (rec.path && await reachable(rec.path)) {
        const { missing: _m, missingSince: _s, ...back } =
          { ...rec, path: toStored(rec.path, shared), sharedIndex: undefined };
        await writeJson(pkgFileIn(root, rec.packageId), back);
        kept++;
        continue;
      }
      if (await unpublish(root, shared, rec.packageId)) removed++;
    }
  }
  return { ok: true, removed, kept };
});

// Flags every record whose package id the crawl didn't find, and un-flags any
// that came back. Per index: the shared one against the crawl, the local one
// against an empty set (reachability only). Matched on id, never path, since
// machines spell the share differently. Runs from index:rebuild.
async function markMissing(root, shared, foundIds, skipUnder = []) {
  const dir = path.join(root, 'pkg');
  let names = [];
  try {
    names = await withTimeout(fs.readdir(dir), 6000, 'Index read');
  } catch {
    return { missing: 0, checked: 0, skipped: 0 };
  }
  let missing = 0, checked = 0, skipped = 0;
  const now = new Date().toISOString();
  // Records under a folder the crawl couldn't open are skipped: "can't tell" never
  // means "gone".
  const blocked = (skipUnder || []).map(p => path.resolve(p));
  const under = file => blocked.some(b => {
    const r = path.relative(b, path.resolve(file));
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  });
  // Bounded parallel, like the crawl: one round trip per record.
  await mapLimit(names, Math.max(1, config.CONCURRENCY || FANOUT_DEFAULT), async n => {
    if (!n.endsWith('.json')) return;
    const file = path.join(dir, n);
    const rec = await readRecord(root, shared, n.replace(/\.json$/, ''));
    if (!rec) return;
    checked++;
    if (rec.path && under(rec.path)) { skipped++; return; }
    let gone = !foundIds.has(rec.packageId);
    // Not found by the crawl isn't gone: a package outside the root never would
    // be. A stat decides.
    if (gone && rec.path && await reachable(rec.path)) gone = false;
    if (gone) missing++;
    // Rewritten only when the flag changes, in stored form: relative on the shared
    // side, without the read-time `sharedIndex` marker.
    const base = { ...rec, path: toStored(rec.path, shared), sharedIndex: undefined };
    if (gone && !rec.missing) {
      await writeJson(file, { ...base, missing: true, missingSince: now });
    } else if (!gone && rec.missing) {
      const { missing: _m, missingSince: _s, ...back } = base;
      await writeJson(file, back);
    }
  });
  return { missing, checked, skipped };
}

// Does the file still exist where the record says? A short deadline: an
// unanswerable path counts as gone, so an offline share can't hold a rebuild.
async function reachable(file) {
  try {
    await withTimeout(fs.access(file), 4000, 'Package check');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Crash recovery
//
// A separate file in the data folder, never the user's own package. Written
// while there are unsaved changes, removed on a real save or clean exit, and
// offered back at startup if one survives.
// ---------------------------------------------------------------------------
const recoveryFile = () => path.join(appDir(), 'recovery.insp');
const recoveryMeta = () => path.join(appDir(), 'recovery.json');

ipcMain.handle('recovery:save', async (_event, { data, meta }) => {
  try {
    await fs.writeFile(recoveryFile(), Buffer.from(data));
    await fs.writeFile(recoveryMeta(), JSON.stringify(meta, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[Recovery] Could not write:', err.message);
    return false;
  }
});

ipcMain.handle('recovery:check', async () => {
  try {
    const meta = JSON.parse(await fs.readFile(recoveryMeta(), 'utf8'));
    await fs.stat(recoveryFile());        // metadata without the package is useless
    return meta;
  } catch {
    return null;
  }
});

ipcMain.handle('recovery:load', async () => {
  const buf = await fs.readFile(recoveryFile());
  return new Uint8Array(buf);
});

ipcMain.handle('recovery:clear', async () => {
  for (const f of [recoveryFile(), recoveryMeta()]) {
    try { await fs.unlink(f); } catch { /* already gone */ }
  }
  return true;
});

// ---------------------------------------------------------------------------
// Recent packages
//
// Paths only, in the data folder: this machine's history, not the part's. Most
// recent first, capped. Whether a file still exists is checked at read time,
// never stored, so an offline share leaves no tombstone.
// ---------------------------------------------------------------------------
const RECENTS_MAX = 20;
const recentsPath = () => path.join(appDir(), 'recents.json');

async function readRecents() {
  try {
    const list = JSON.parse(await fs.readFile(recentsPath(), 'utf8'));
    return Array.isArray(list) ? list.filter(e => e && typeof e.file === 'string') : [];
  } catch {
    return [];                          // absent or corrupt: start clean
  }
}

async function writeRecents(list) {
  try {
    await fs.writeFile(recentsPath(), JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[Recents] Could not write recents.json:', err.message);
    return false;
  }
}

ipcMain.handle('recents:list', async () => {
  const list = await readRecents();
  // Missing entries are greyed, not dropped: a share being down isn't a deletion.
  return await Promise.all(list.map(async e => {
    let exists = false;
    try { await withTimeout(fs.stat(e.file), 1500, 'stat'); exists = true; } catch {}
    return { ...e, exists };
  }));
});

ipcMain.handle('recents:add', async (_event, entry) => {
  if (!entry?.file) return false;
  const list = await readRecents();
  const next = [{ ...entry, openedUtc: new Date().toISOString() },
                ...list.filter(e => e.file !== entry.file)].slice(0, RECENTS_MAX);
  return await writeRecents(next);
});

ipcMain.handle('recents:remove', async (_event, file) => {
  const list = await readRecents();
  return await writeRecents(list.filter(e => e.file !== file));
});

ipcMain.handle('recents:clear', async () => writeRecents([]));

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New…', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('saveas') },
        { label: 'Export\u2026', accelerator: 'CmdOrCtrl+E', click: () => send('export') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('redo') },
        { type: 'separator' },
        { label: 'Clear Annotations', click: () => send('clear') },
        { type: 'separator' },
        { label: 'Drawing Info…', click: () => send('docinfo') },
        { type: 'separator' },
        { label: 'Settings…', click: () => send('settings') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'History…', click: () => send('history') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for Updates\u2026', click: () => send('checkupdate') }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Updates
//
// electron-updater against this repo's GitHub releases. It only checks:
// autoDownload and autoInstallOnAppQuit are off, and everything else waits for
// a click. Nothing runs unpackaged.
// ---------------------------------------------------------------------------
let updaterApi = null;
function updater() {
  if (!app.isPackaged) return null;
  if (!updaterApi) {
    ({ autoUpdater: updaterApi } = require('electron-updater'));
    updaterApi.autoDownload = false;
    updaterApi.autoInstallOnAppQuit = false;
    updaterApi.logger = { info: console.info, warn: console.warn, error: console.error, debug: () => {} };
    updaterApi.on('download-progress', p => {
      try { win?.webContents.send('update-progress', { percent: p.percent, bytesPerSecond: p.bytesPerSecond }); }
      catch { /* window gone */ }
    });
  }
  return updaterApi;
}

// Release notes arrive as HTML; flattened to plain text for a dialog.
function plainNotes(notes) {
  const html = typeof notes === 'string' ? notes
    : Array.isArray(notes) ? notes.map(n => n?.note || '').join('\n') : '';
  return html
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\u2022 ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, m =>
      ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[m])
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1200);
}

ipcMain.handle('update:check', async () => {
  const up = updater();
  if (!up) return { status: 'dev', version: app.getVersion() };
  try {
    const r = await up.checkForUpdates();
    if (!r?.isUpdateAvailable) return { status: 'none', version: app.getVersion() };
    return {
      status: 'available',
      version: r.updateInfo.version,
      current: app.getVersion(),
      date: r.updateInfo.releaseDate || null,
      notes: plainNotes(r.updateInfo.releaseNotes)
    };
  } catch (err) {
    // Offline, GitHub unreachable, no latest.yml: never fatal.
    return { status: 'error', error: err.message };
  }
});

ipcMain.handle('update:download', async () => {
  const up = updater();
  if (!up) return { ok: false, error: 'Updates are only available in an installed copy.' };
  try {
    await up.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:install', () => {
  const up = updater();
  if (!up) return { ok: false, error: 'Updates are only available in an installed copy.' };
  // The renderer has checked there's nothing unsaved, and quitAndInstall() closes
  // windows before the close guard could be answered.
  allowClose = true;
  setImmediate(() => up.quitAndInstall(false, true));
  return { ok: true };
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 980,
    backgroundColor: '#2b2b2b',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.loadFile('index.html');
  win.on('close', e => {
    if (allowClose) return;
    e.preventDefault();
    // Second attempt while already asking: the renderer is wedged, let it go.
    if (closePending) { allowClose = true; win.destroy(); return; }
    closePending = true;
    win.webContents.send('app-close-request');
  });

  win.on('closed', () => { win = null; allowClose = false; closePending = false; });
}

app.whenReady().then(() => {
  loadConfig();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
