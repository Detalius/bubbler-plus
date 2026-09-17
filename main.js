const path = require('path');
const fsSync = require('fs');

// ---------------------------------------------------------------------------
// Thread pool size — MUST be settled before anything does asynchronous I/O.
//
// Node has no asynchronous filesystem calls. It has a pool of worker threads
// that make blocking ones, and `fs.readdir` waits its turn in that pool along
// with dns and crypto. The pool is sized ONCE, from this variable, the first
// time anything uses it, and the default is FOUR. That was the real ceiling on
// the share crawl: CONCURRENCY could say 16 or 1600 and only four readdir calls
// would ever be in flight, with every other one queued behind those four
// threads. On a share the threads are asleep waiting on the network, so four is
// not four workers — it is four round trips of latency at a time.
//
// Read straight out of config.json with a synchronous read rather than through
// loadConfig(), which needs app.isPackaged and therefore `electron` — and by the
// time that has loaded the pool may already exist. require() and readFileSync
// are synchronous and never touch the pool, so they are safe above this line.
// NOTHING else may go above it.
//
// If a future Electron ever initialises the pool before this file runs, the
// fallback is a real environment variable set by the launcher; the check below
// leaves one already in the environment alone so that keeps working.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// The data folder — config, recents, crash recovery and the local index.
//
// ALWAYS the per-user app data folder, in development and packaged alike
// (%APPDATA%\Bubbler+ on Windows). It used to be beside the executable whenever
// that was writable, and the default per-user install folder IS writable — but
// an installer update removes the old version's folder before laying down the
// new one, so every update would have silently erased settings, recents,
// recovery and the local index. No migration from the old location, by rule:
// moving the files is a one-time copy by hand (Settings > Open data folder).
//
// Worked out HERE, by hand, rather than from app.getPath('userData'): the pool
// sizing below needs config.json before `electron` may be required. The same
// rule Electron uses — productName, else name — and then pinned with
// app.setPath() right after electron loads, so the two can never disagree.
// require() of os and package.json is synchronous and safe above the pool.
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
// config.json sits beside the executable when packaged, or beside main.js in
// development. It holds the share root the package search will walk. Missing or
// malformed config is not fatal — the app runs, the search just has nowhere to
// look until a folder is set.
// ---------------------------------------------------------------------------
const CONFIG_DEFAULTS = {
  NETWORK_PATH: '',        // share root to crawl, e.g. //app01/Public/Master Files
  // Where the sidecar index lives. Kept separate from NETWORK_PATH so the index
  // doesn't have to sit inside the jobs tree — e.g. //app01/Public/QC Dept/.bubbler-index
  SIDECAR_PATH: '',
  // The folder inside a part folder that holds the .insp packages. 'QC' is what
  // this shop calls it; it is a name, not a rule, and a shop that files under
  // 'Inspection' or 'CMM' sets it here. Everything downstream reads this rather
  // than assuming — the crawl has no other way to recognise a part folder.
  PACKAGE_DIR: 'QC',
  ARCHIVE_DIR: 'Archive',  // sub-folder inside the package folder, superseded revisions
  // How far below the root a package folder may sit, counting the root's
  // children as level 1. Here it is level 3 in ROOT/CUSTOMER/PART/QC and level 4
  // in ROOT/CUSTOMER/FAMILY/PART/QC, so 4 reaches both shapes. Other shops nest
  // differently — a flat ROOT/PART/QC is 2 — so the only floor is 2, which is
  // the shallowest a package folder can sit while something still holds it.
  SEARCH_DEPTH: 4,
  // Directory reads genuinely in flight at once, and the number the libuv
  // thread pool is sized from at startup. It used to be decorative: the pool
  // defaulted to four, so four was the real number whatever this said.
  //
  // Eight because that is where a real share stopped improving. Measured on a
  // 9,240-folder tree: 1 read at a time gave 14 folders/sec, 4 gave 50, 16 gave
  // 112 — and 32 gave 110, so 16 was already past the knee. Whatever saturates
  // is on the far end, not here. Eight buys most of that and leaves half the
  // pool for everything else in the app; sixteen hogged the lot to finish about
  // 15% sooner. Changing it takes effect on the next launch, not the next
  // rebuild, because the pool is sized once.
  CONCURRENCY: 8,
  // Inches of margin when PRINTING A DRAWING. Sheets get none and never will:
  // their geometry is measured against a full page, so a margin would only push
  // the last row onto a page of its own. A drawing is a foreign PDF with
  // whatever border its author chose, which is often none, so it is the one
  // thing that needs the printer's unprintable edge given back to it.
  PRINT_MARGIN_IN: 0.25
};
let config = { ...CONFIG_DEFAULTS };

// The data folder (see DATA_DIR at the top), created on first use. Kept as a
// function so every caller still reads as "where this app keeps its own files".
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

// `filePath` set  -> write straight there (Save).
// `filePath` unset -> ask where to put it (Save As / first save).
// The stamp rides along with the bytes so the renderer can hand it back at save
// time. Size AND mtime: mtime alone has coarse resolution on some filesystems
// and two saves inside one tick would look identical.
async function fileStamp(file) {
  try {
    const st = await withTimeout(fs.stat(file), 5000, 'stat');
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;                     // not there yet, which is its own answer
  }
}

const sameStamp = (a, b) =>
  !!a && !!b && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2;

ipcMain.handle('dialog:save', async (_event, { filePath, defaultPath, data, filters, expect }) => {
  let target = filePath;
  let chosen = false;
  if (!target) {
    const result = await dialog.showSaveDialog(win, { defaultPath, filters });
    if (win) win.focus();
    if (result.canceled || !result.filePath) return null;
    target = result.filePath;
    chosen = true;
  }
  // The guard that actually protects the work. A lock is advisory and has holes
  // — a crash outlives it, a network drop orphans it, somebody edits the file
  // with the app closed — but the file on disk cannot lie about having changed.
  // Only when overwriting a path we were already bound to: a path just picked in
  // the Save dialog has had its own overwrite prompt, and that answer stands.
  if (expect && !chosen) {
    const now = await fileStamp(target);
    if (now && !sameStamp(now, expect)) {
      return { conflict: true, path: target, name: path.basename(target) };
    }
  }
  // Save As onto a package somebody else has open. The OS overwrite prompt only
  // asks whether the file may be replaced; it cannot know the file is live in
  // another session, which then kept editing a package whose bytes were no
  // longer its own until a stamp check finally caught it. Refused before
  // writing, and only for a picked path — a bound path is this session's own.
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
// The renderer never sees workbook bytes. It sends a path and a set of columns;
// main reads, appends and writes. Keeping it here is not only tidiness — a
// large package would block the renderer for as long as the zip takes.
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

    // Written beside the target and renamed over it. rename is atomic within a
    // filesystem, so a crash mid-write leaves the original workbook intact
    // rather than half of a new one.
    const tmp = `${file}.bubbler-tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, file);
    return { ok: true, added };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Font bytes for pdf-lib. fetch() on a file:// origin is unreliable, so the
// renderer asks main for the file instead.
ipcMain.handle('asset:read', async (_event, name) => {
  if (!/^[\w.-]+$/.test(name)) throw new Error('Bad asset name');
  const buf = await fs.readFile(path.join(__dirname, 'assets', name));
  return new Uint8Array(buf);
});

// Render a standalone HTML document to PDF in an offscreen window. Using the
// same markup the preview shows means the two cannot drift apart.
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

ipcMain.handle('window:title', (_event, title) => {
  if (win) win.setTitle(title);
});

// Closing has to round-trip to the renderer (only it knows the dirty state and
// can run a save), but 'close' is synchronous. So: cancel the close, ask, then
// re-issue it once the renderer answers.
let allowClose = false;
let closePending = false;

// Renderer's verdict on a pending close.
ipcMain.handle('window:close-confirmed', (_event, ok) => {
  closePending = false;
  if (!ok || !win) return;
  allowClose = true;
  win.close();
});

// Replaces window.alert / confirm, which leave the window without the focus
// state native popups (colour pickers, select dropdowns) need in order to open.
ipcMain.handle('dialog:message', async (_event, opts = {}) => {
  const result = await dialog.showMessageBox(win, {
    type: opts.type || 'info',
    title: opts.title || 'Bubbler+',
    message: opts.message || '',
    detail: opts.detail || undefined,
    buttons: opts.buttons || ['OK'],
    defaultId: opts.defaultId ?? 0,
    cancelId: opts.cancelId ?? 0,
    noLink: true
  });
  if (win) win.focus();          // the bit that actually fixes the stuck popups
  return result.response;
});

// ---------------------------------------------------------------------------
// Package index
//
// A disposable local cache: the .insp files on the share stay the system of
// record, and this can always be rebuilt by rescanning. Stored per machine in
// userData, so three QC boxes each keep their own and nothing is shared over SMB
// (a multi-writer database on a share is a known way to lose data).
//
// JSON rather than SQLite deliberately — a few thousand entries is well under a
// megabyte, loads in milliseconds and queries as a Map. SQLite would mean a
// native module, electron-rebuild and Windows build tools for no measurable win
// at this size. The interface below is narrow enough to swap if that changes.
//
// Folder shapes seen in the wild:
//   ROOT/CUSTOMER/PART/QC/
//   ROOT/CUSTOMER/FAMILY/PART/QC/
// so the crawl descends up to SEARCH_DEPTH levels looking for a QC folder.
// ---------------------------------------------------------------------------
const fflate = require('fflate');
const crypto = require('crypto');

// Identifies the exact set of drawings a package holds. Must match
// drawingSetString() in the renderer byte for byte: non-empty hashes, deduped,
// sorted, newline-joined — the renderer writes this value and main derives it
// when rebuilding, so a disagreement would split the index in two.
function drawingSetHash(list) {
  const canon = [...new Set((list || []).filter(Boolean))].sort().join('\n');
  if (!canon) return null;
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Share index — sidecars
//
// There is no local index file. The index IS a folder of tiny JSON files on the
// share, written whenever a package is saved:
//
//   <root>/pkg/<packageId>.json        the record: path, part, drawing hashes
//   <root>/hash/<sha256>/<pkgId>.json  a pointer, one per drawing
//
// Resolution is a path read rather than a search — no scanning, no local cache
// to fall out of step. Packages stay exactly where they are and stay
// self-contained, so a .insp is still emailable and works with no share at all.
//
// A directory per hash rather than a single file, because the same drawing can
// legitimately appear in more than one package, and because one file per package
// means no two machines ever write the same file.
// ---------------------------------------------------------------------------
const SIDECAR_DIR = '.bubbler-index';

// TWO indexes, and the routing rule below keeps them DISJOINT.
//
//   shared — everything under the packages root
//   local  — everything else, beside the app
//
// No package is a candidate for both, so there is never a tie to award and the
// union is a concatenation rather than a negotiation. It also buys the property
// that makes markMissing trustworthy on the shared side: everything in there is
// under the root, so every machine can reach it and every machine's reachability
// check means the same thing. A package on somebody's desktop is not absent from
// the share — it was never going to be there — so it stays local and no other
// machine is ever told it is missing.
//
// It used to require a PACKAGE_DIR as well, on the stricter invariant that a
// crawl must be able to find everything in the shared index. Relative paths
// retired that: an in-root file resolves on every machine, so reachable() speaks
// for it whether a crawl reached it or not, and the extra condition only meant
// that moving a package one folder out of its QC silently moved its record to a
// different index.
//
// The shared index needs a packages root to exist at all (see sharedRoot), which
// is what makes the relative paths below total rather than partial.
const localRoot = () => path.join(appDir(), SIDECAR_DIR);

// An index folder is only honoured when a packages root is set. Without one
// there is nothing to crawl, no reliable way to mark anything missing, and
// nothing for a relative path to resolve against — so the setting is refused
// rather than half-obeyed. Sidecar filenames are ids and hashes; the folder was
// never meant to be browsed by hand, only reached from several machines.
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

// Windows is case-insensitive and tolerates either separator, so two spellings
// of one file must compare equal or every identity check below misfires.
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

// Shared records store the path relative to the packages root, so two machines
// reaching the same share by different names — Z:\Jobs and \\srv\jobs — write
// identical bytes and each reads the other's records without translation.
// Resolved on the way out, so nothing downstream ever handles a relative path.
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
// exists? That single question separates a move from a copy: a package moved by
// hand leaves its old path dead, while a copy leaves it very much alive. The
// answer drives both the repoint rule in publishSidecar and the fork mint on
// save, which is why it is one function and not two nearly-identical ones.
async function idTakenElsewhere(packageId, file) {
  if (!packageId) return { taken: false, at: null };
  for (const { root, shared } of indexRoots()) {
    const rec = await readRecord(root, shared, packageId);
    if (!rec?.path || samePath(rec.path, file)) continue;
    if (await reachable(rec.path)) return { taken: true, at: rec.path };
  }
  return { taken: false, at: null };
}

// Removes a record and every pointer to it from ONE index. Not a delete in the
// user-facing sense — the package is untouched — only a retraction of a claim
// this index no longer has any business making.
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

// Called after a package is saved, and after one is opened. Writes the record
// and one pointer per drawing, and clears pointers for drawings the package no
// longer contains.
async function publishSidecar(entry) {
  if (!entry?.packageId || !entry?.file) return { ok: false, reason: 'no-package' };

  // Opening must never steal another file's record. §4 says republish-on-open
  // exists to repair a path that has gone dead; repointing unconditionally made
  // a copy indistinguishable from a move, so opening a copy quietly removed the
  // ORIGINAL from the index. `forked` tells the renderer this file needs its own
  // identity before it can be indexed — minted on save, never here, because
  // opening must not write the file (§3).
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
    // A package can change which index it belongs to: dragged into the share, or
    // out of it. The routing rule keeps the two disjoint by FILE, but nothing
    // stops the same id having a record in the index it used to live in — and a
    // stale one is worse than none, because the Library lists it twice and the
    // next rebuild flags the old one missing while the new one sits there fine.
    // Same id means the same package, and publishSidecar has already settled
    // that this file owns it: the fork check refuses on open, and by save the id
    // has been re-minted if it needed to be.
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

// Direct reads, no listing of the whole index. Both roots, shared first: they
// are disjoint by routing, so a hit in one is the answer, and checking the
// shared one first keeps the site's own packages cheapest to find.
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

// Who the OS says is at the keyboard. Unverified by design — the app cannot
// attest to it, and the audit trail says so wherever it is shown.
ipcMain.handle('identity:get', () => {
  let user = '';
  try { user = os.userInfo().username || ''; } catch { /* no account info */ }
  return {
    user: user || process.env.USERNAME || process.env.USER || 'unknown',
    host: os.hostname() || ''
  };
});

ipcMain.handle('sidecar:publish', (_event, entry) => publishSidecar(entry));

// Asked again at save time. The renderer cannot answer it — only the index
// knows, and only the filesystem knows whether the other file is still there.
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

// Only manifest.json is decompressed — the drawings are the bulk of the zip and
// nothing here needs them, so a package reads in milliseconds.
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
    // Derived when absent, so packages written before the field existed still
    // get a set pointer on a rebuild.
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

// Walks the share looking for QC folders.
//
//   ROOT/CUSTOMER/PART/QC          -> QC at depth 3
//   ROOT/CUSTOMER/FAMILY/PART/QC   -> depth 4
//
// Three rules make it cheap, and the first replaced one that was making it
// expensive:
//
//   1. ONE listing per folder, taken WITH FILE TYPES, and every decision made
//      out of it. The old rule was the opposite — never list a candidate, just
//      try to open PART/QC directly, on the theory that a miss costs one round
//      trip where a listing costs many. It does not: SMB enumerates a directory
//      in batches, so a listing is about one round trip too, and skipping it
//      cost far more than it saved. Without types the walker could not tell a
//      folder from a file, so a part folder with no QC was listed and then
//      every CAM file inside it got its own PART/job01.nc/QC probe. On a tree
//      of twenty customers that was 12,861 round trips where 2,301 will do.
//   2. A folder holding a QC is a part folder: index it and stop. Nothing below
//      a part folder is indexed, and a folder holding no QC is a container, so
//      descend into its SUB-FOLDERS and never into its files.
//   3. ONE queue for the whole crawl. See drain() for why that is not the same
//      as the mapLimit-per-level it replaced.
//
// SEARCH_DEPTH is the deepest a QC may sit, so the folder holding one sits
// between depth 2 and SEARCH_DEPTH - 1, and there is no reason to look anywhere
// else.
//
// opts.stopWhen  — called per package; truthy ends the crawl immediately
// opts.nameHint  — only take QC under folders whose name contains this
// opts.customerHint — narrows the customer list at the top level
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
    // Named, not just counted. "1 could not be read" is a number to worry
    // about; knowing WHICH folder, and whether it said access-denied or timed
    // out, is the difference between a permissions job and a share problem.
    console.warn('[Index] Could not read', dir, '-', err.message);
    return null;
  }
}

// One queue for the whole crawl, seeded with the root and fed by the workers as
// they discover folders. A mapLimit per level does not cap anything: sixteen
// customers each running sixteen children is 256 requests in flight, not
// sixteen, and it multiplies again at every level below.
//
// That matters for more than politeness to the file server. Every one of those
// requests is holding a withTimeout deadline that started ticking when the
// promise was CREATED, not when the share got round to it — so with enough of
// them stacked behind each other, folders begin timing out and reading as
// EMPTY while the share is perfectly healthy, and a rebuild quietly skips whole
// customers. Bounding the real number in flight is what keeps a queued read
// from spending its deadline waiting for a thread.
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

async function crawl(root, depth, onProgress, opts = {}) {
  const found = [];
  let listed = 0, unreadable = 0, done = false;
  // The paths, not just the count. markMissing needs them to know which records
  // it has no business judging — a folder it could not open says nothing about
  // what is inside. Capped because this rides the progress channel and a share
  // with a thousand locked folders has a different problem.
  const unreadablePaths = [];
  // Diagnostics only. The crawl cannot know whether SEARCH_DEPTH is earning its
  // keep, but the shape of the tree answers it: if no part folder ever turns up
  // below the shallowest depth, every listing at the level under it was a sweep
  // for something that was never there, and the setting can come down a notch.
  const listedAt = [], partsAt = [];
  const limit = Math.max(1, opts.fanout || config.CONCURRENCY || FANOUT_DEFAULT);
  // Archives double the round trips for something rarely needed. A full rebuild
  // skips them; the resolver turns them on, by which point it is looking at one
  // part folder rather than three thousand.
  const withArchive = opts.includeArchive === true;
  const hint = (opts.nameHint || '').toLowerCase();
  const custHint = (opts.customerHint || '').toLowerCase();
  // A part folder sits between depth 1 and SEARCH_DEPTH - 1. The floor used to
  // be 2, which quietly assumed a customer level above every part folder — true
  // of this shop's tree, not of anyone else's, and it made SEARCH_DEPTH 1, 2 and
  // 3 all mean the same thing. The root itself is never treated as a part
  // folder: a share with a 'QC' department folder at the top would otherwise
  // end the whole crawl on its first listing.
  const maxPart = Math.max(1, (depth || 4) - 1);
  const pkgDir = (config.PACKAGE_DIR || 'QC').toLowerCase();

  // Progress is per folder now, not per QC found, so an empty share shows
  // movement instead of sitting on "Walking the share…" for three minutes.
  // Throttled because a big tree would otherwise send thousands of IPC
  // messages that nobody can read anyway.
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

  // A part folder: take its package folder, and the Archive inside it if this
  // caller wants one. The Archive is looked up in the listing already in hand
  // rather than probed, so a package folder without one costs nothing.
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
    // An unreadable folder is NOT an empty one. It is counted and surfaced
    // rather than pruned in silence, because pruning it silently is how a
    // rebuild loses a customer without ever saying so.
    if (!entries) {
      unreadable++;
      if (unreadablePaths.length < 50) unreadablePaths.push(dir);
      return;
    }
    listed++;
    listedAt[level] = (listedAt[level] || 0) + 1;
    report(path.basename(dir));

    const dirs = entries.filter(e => e.isDirectory());
    if (level >= 1) {
      const qc = dirs.find(e => e.name.toLowerCase() === pkgDir);
      if (qc) {
        // A part folder either way. The hint only decides whether to open its
        // QC — descending into it would be wrong regardless.
        partsAt[level] = (partsAt[level] || 0) + 1;
        if (!hint || path.basename(dir).toLowerCase().includes(hint)) {
          await takeQC(path.join(dir, qc.name));
        }
        return;
      }
    }
    if (level >= maxPart) return;

    let names = dirs.map(e => e.name).filter(n => n.toLowerCase() !== pkgDir);
    // The customer hint narrows the top level, but never to nothing: a share
    // whose folder names do not match how the package spells the customer
    // should still be searched rather than silently skipped.
    if (level === 0 && custHint) {
      const narrowed = names.filter(n =>
        n.toLowerCase().includes(custHint) || custHint.includes(n.toLowerCase()));
      if (narrowed.length) names = narrowed;
    }
    for (const n of names) push({ dir: path.join(dir, n), level: level + 1 });
  }

  await drain([{ dir: root, level: 0 }], limit, visit);
  // Unthrottled, so the totals a caller reads are the real ones rather than
  // whichever update happened to win the last 100ms window. The progress
  // channel is the only way these leave the crawl: a property hung off the
  // function would be shared by every caller, and the resolver can be crawling
  // while a rebuild is.
  onProgress({ phase: 'scan', label: '', count: found.length, scanned: listed,
               unreadable, unreadablePaths });
  console.info('[Index] crawl shape (depth: folders listed / holding a QC) —',
    listedAt.map((n, i) => `${i}: ${n || 0}/${partsAt[i] || 0}`).join('  '),
    `| ${unreadable} unreadable, limit ${limit}, pool ${process.env.UV_THREADPOOL_SIZE}`);
  return found;
}

// Rebuild every sidecar by crawling the share. This is the repair tool, not the
// normal path — sidecars are written on save, so this only matters after packages
// have been moved by hand, restored from backup, or created by an older build.
ipcMain.handle('index:rebuild', async (event) => {
  const root = config.NETWORK_PATH;
  // With no packages root there is nothing to crawl, but there is still an index
  // — the local one, holding whatever this machine has saved or opened. Refusing
  // outright left the only repair tool unavailable to exactly the people with no
  // share. Re-checking every record it already holds is the honest subset of a
  // rebuild: it cannot discover anything new, but it can tell you what has since
  // gone and what has come back.
  if (!root) {
    // No packages root means no shared index either (sharedRoot needs one), so
    // this is the local index and an empty found set is the whole truth: nothing
    // was crawled, so only reachability may speak.
    const started = Date.now();
    const { missing, checked } = await markMissing(localRoot(), false, new Set());
    return { ok: true, checkOnly: true, packages: checked, written: 0, missing,
             folders: 0, unreadable: 0, duplicates: 0,
             seconds: (Date.now() - started) / 1000 };
  }
  // The crawl's own totals arrive on the progress channel, so they are read on
  // the way past rather than fetched from anywhere afterwards.
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

    // Copy a package without opening and saving it and two files carry one id,
    // so the crawl hands back two entries for one record. Publishing both means
    // whichever finishes last wins, and it can differ run to run. Settle it
    // once, before writing: keep whichever the index already names if that file
    // is still there, otherwise lowest path. Neither copy is more legitimate —
    // what matters is that the same rebuild picks the same one every time, so a
    // record PDF does not resolve somewhere new after a rescan. Not mtime: the
    // copy sets it, so it can flip the winner between runs.
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
    // Same latency argument as the crawl: these are round trips to the index
    // share, and doing three thousand of them one at a time undoes the walk.
    await mapLimit(unique, Math.max(1, config.CONCURRENCY || FANOUT_DEFAULT), async e => {
      const r = await publishSidecar(e);
      if (r.ok) written++;
    });

    // A full crawl is authoritative about the packages root, so anything it
    // didn't find there is gone. The sidecar is flagged rather than deleted: an
    // inspection record may still point at that package, and "this used to exist
    // and no longer does" is a more useful answer than a lookup that misses.
    //
    // On ids, not paths, and never inside a folder the crawl could not read.
    const found = new Set(unique.map(e => e.packageId));
    // Every crawl entry is in-root and inside a PACKAGE_DIR by construction, so
    // they all route the same way and the destination does not depend on which
    // one is asked — or on there being any.
    const crawled = sharedRoot()
      ? { root: sharedRoot(), shared: true }
      : { root: localRoot(), shared: false };
    const { missing } = await markMissing(crawled.root, crawled.shared, found, unreadablePaths);

    // The crawl only speaks for the packages root, so with a shared index the
    // local one would never be checked at all and its records would rot. Same
    // empty-found-set pass the no-root rebuild runs: reachability only.
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
// Sidecar first — a couple of path reads. Only if that misses does it fall back
// to walking the share, and anything found that way gets a sidecar so the next
// lookup is instant.
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

// Prefer a current revision over an archived copy of the same drawing.
//
// Also normalises the path field: a crawl produces entries keyed `file`, while a
// sidecar record stores the same value as `path`. Callers see both, always.
function pickBest(via, entries) {
  const norm = entries.map(e => ({ ...e, file: e.file || e.path, path: e.path || e.file }));
  const sorted = norm.sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0));
  return { ok: true, via, entry: sorted[0], candidates: sorted };
}

// Raw .insp bytes, so the renderer can unzip it with the code it already has.
// ---------------------------------------------------------------------------
// Package locks
//
// Advisory, and deliberately so: the guard that protects the work is the stamp
// check in dialog:save. This layer exists to stop the wasted hour — finding out
// at 4pm that somebody else has had the same package open since lunch.
//
// The lock lives BESIDE the package, not in the index, because with local
// indexes two machines share no index at all; the package's own folder is the
// only place every machine agrees on. Created with 'wx', which is O_EXCL and
// becomes CREATE_NEW on Windows — atomic over SMB2, so two machines racing
// produce exactly one winner and one EEXIST.
//
// A heartbeat is what makes a crash survivable: the holder rewrites `beat`
// every LOCK_BEAT_MS, and a lock that has gone quiet for LOCK_STALE_MS is taken
// over without asking. The token is what makes that safe in the other
// direction — a holder that comes back to find its lock reissued discovers the
// token no longer matches and drops to read-only rather than carrying on.
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
  // Somebody decided we were dead and took it. They are not wrong to have — we
  // went quiet. Let go rather than fight over it, and tell the renderer so the
  // session it is running stops believing it can save.
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

async function acquireLock(file) {
  await releaseLock();
  const token = crypto.randomUUID();
  const lp = lockPathFor(file);
  // Twice: the first EEXIST may be a stale lock this call then clears, and the
  // retry is what claims it. A third would mean live contention, which is the
  // answer rather than something to keep hammering.
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
        // Read-only share, no permission, a path that cannot take a sibling
        // file. Not being able to lock is not a reason to refuse to work.
        console.warn('[Lock] Could not lock', file, '-', err.message);
        return { ok: true, unlocked: true };
      }
      const cur = await readJson(lp);
      const age = Date.now() - (cur?.beat || 0);
      if (cur && age < LOCK_STALE_MS) {
        return { ok: false, by: { user: cur.user, host: cur.host, since: cur.since } };
      }
      // Quiet for longer than a crashed session could plausibly be alive.
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

// A stat and nothing else, so a viewer holding bytes from an earlier read can ask
// whether they are still the file's without reading it again.
ipcMain.handle('package:stamp', async (_event, file) => {
  if (typeof file !== 'string' || !file) return null;
  return await fileStamp(file);
});

ipcMain.handle('package:read', async (_event, file) => {
  if (typeof file !== 'string' || !file) throw new Error('No package path given');
  const buf = await withTimeout(fs.readFile(file), 15000, 'Package read');
  return { bytes: new Uint8Array(buf), stamp: await fileStamp(file) };
});

// ---------------------------------------------------------------------------
// Package search (Print mode)
//
// Reads the sidecar records rather than the packages themselves: everything the
// search needs is already in the index, so a query never touches a .insp.
// ---------------------------------------------------------------------------
ipcMain.handle('index:search', async (_event, query, opts = {}) => {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  // `total` counts every record either index holds, matching or not. Without it
  // the Library cannot tell "nothing matched that search" from "nothing has ever
  // been indexed", and says "Nothing found." next to a fully configured share.
  let total = 0;
  const byId = new Map();

  // Shared first: the two are disjoint by routing, so a duplicate id is a
  // leftover from before that rule, and shared wins because it is the copy every
  // machine can see. Deterministic matters more than which copy is "right".
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
      // Packages the last full scan couldn't find stay in the index but out of
      // the way, so a deleted part doesn't keep showing up on the floor.
      if (rec.missing && !opts.includeMissing) { byId.set(rec.packageId, null); continue; }
      // The file name too: it is the only thing telling Part1_plated.insp from
      // Part1_unplated.insp when both carry the same part number.
      const hay = [rec.partNumber, rec.partRev, rec.partName, rec.customer,
                   rec.path && path.basename(rec.path)]
        .filter(Boolean).join(' ').toLowerCase();
      // Every term must appear somewhere, so "acme 482" narrows as you'd expect.
      if (terms.length && !terms.every(t => hay.includes(t))) { byId.set(rec.packageId, null); continue; }
      byId.set(rec.packageId, rec);
    }
  }

  const out = [...byId.values()].filter(Boolean);
  out.sort((a, b) => (a.partNumber || '').localeCompare(b.partNumber || '') ||
                     (a.partRev || '').localeCompare(b.partRev || ''));
  // Carried on the search rather than fetched separately: the empty state needs
  // it at exactly the moment a search comes back with nothing, and one round
  // trip beats two.
  return { ok: true, results: out.slice(0, 200), total,
           hasRoot: !!config.NETWORK_PATH, local: indexIsLocal() };
});

// The Library never stats — hundreds of round trips per keystroke — so the one
// cheap moment to learn a package is gone is when someone tries to open it and
// the open fails. Flags it there rather than waiting for the next rebuild.
ipcMain.handle('index:flag-missing', async (_event, packageId) => {
  for (const { root, shared } of indexRoots()) {
    const rec = await readRecord(root, shared, packageId);
    if (!rec || rec.missing) continue;
    // Believe the failed open over a second opinion: if it were reachable the
    // open would have worked.
    await writeJson(pkgFileIn(root, packageId), {
      ...rec, path: toStored(rec.path, shared), sharedIndex: undefined,
      missing: true, missingSince: new Date().toISOString()
    });
    return { ok: true };
  }
  return { ok: false };
});

// Deletes every record flagged missing, with its drawing and set pointers, from
// both indexes. Only the index forgets: no package file is touched, because by
// definition there is none where the record points. One last reachability check
// per record, so a package that came back since the last rebuild is kept rather
// than purged on the strength of a stale flag. Nothing is lost for good either
// way: a purged package that turns up again is re-published the next time it is
// opened, saved or crawled.
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
      // Back since the flag was set: keep it, and clear the flag while here, so
      // it stops counting as missing without waiting for a rebuild.
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

// Flags every sidecar whose package the crawl didn't see, and un-flags any that
// have come back. One root at a time, because the two indexes answer to
// different crawls: the shared one to the packages root, the local one to
// nothing at all (an empty found set, where only reachability speaks).
//
// Matched on packageId, not path. Identity has no spelling — two machines
// reaching one share as Z:\Jobs and \\srv\jobs wrote paths the other's crawl
// could never match, and every one of those records got flagged.
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
  // A folder the crawl could not open says nothing about what is inside it, and
  // "cannot tell" must never mean "gone". Scoped to the subtree rather than
  // skipping the whole pass: one permanently locked folder would otherwise mean
  // nothing anywhere is ever reportable. reachable() cannot rescue these either
  // — EACCES on the folder is EACCES on the files in it.
  const blocked = (skipUnder || []).map(p => path.resolve(p));
  const under = file => blocked.some(b => {
    const r = path.relative(b, path.resolve(file));
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  });
  // Parallel for the same reason the crawl is: one round trip per record, and
  // an index of a few thousand done one at a time costs minutes on a share.
  await mapLimit(names, Math.max(1, config.CONCURRENCY || FANOUT_DEFAULT), async n => {
    if (!n.endsWith('.json')) return;
    const file = path.join(dir, n);
    const rec = await readRecord(root, shared, n.replace(/\.json$/, ''));
    if (!rec) return;
    checked++;
    if (rec.path && under(rec.path)) { skipped++; return; }
    let gone = !foundIds.has(rec.packageId);
    // The crawl only ever looks inside the packages root, so "the crawl did not
    // see it" is not the same as "it is not there". A working copy on someone's
    // desktop, a package on a second share, one opened from a mail attachment —
    // none of those were ever going to turn up in a crawl of the jobs tree, and
    // flagging them missing loses them from Print mode for no reason. Ask the
    // filesystem before believing the crawl's silence. One stat is cheap, and
    // it only runs for records the crawl did not account for.
    if (gone && rec.path && await reachable(rec.path)) gone = false;
    if (gone) missing++;
    // Only rewrite when the flag actually changes. Written back in the form it
    // was stored in — relative on the shared side — and without the read-time
    // marker, or the next read would resolve an already-absolute path again.
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

// Does this file still exist where the record says it does? A short deadline on
// purpose: an offline share should not hold a rebuild open, and a path that
// cannot be answered for is treated the same as one that is gone — which is the
// behaviour this had for every path before, so nothing gets worse on a timeout.
async function reachable(file) {
  try {
    await withTimeout(fs.access(file), 4000, 'Package check');
    return true;
  } catch {
    return false;
  }
}

// Prints a PDF the renderer has already produced. Goes through a temp file
// rather than a data URL: base64-ing a multi-megabyte PDF means building a
// string longer than the whole drawing, and the usual one-liner for it
// (String.fromCharCode(...bytes)) overflows the stack past ~128KB.
// 'none' on purpose, for both print paths in this file.
//
// Sheets are drawn to fill the page, so any margin pushes the bottom row off it.
// Drawings DO get a margin — but it is baked into the PDF before it arrives
// here, because this option only lays out HTML: a PDF is drawn by Chromium's
// PDF viewer, which prints the pages as they are and ignores it entirely.
// Asking for a margin here as well would either do nothing or, if a future
// Electron starts honouring it, apply the margin twice.
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

// Renders HTML in a hidden window and opens the system print dialog on it.
// Separate from print:pdf, which returns bytes instead of printing.
// Sheets, printed rather than exported. marginType 'none' is not a preference:
// this used to pass no margins, so Electron applied its ~1cm default while
// print:pdf forced zero for the very same HTML. One sheet, two paths, two
// layouts. Sheet geometry is measured against the whole page; anything but none
// pushes the bottom row off it.
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
// Crash recovery
//
// A separate file beside the executable, never the user's own package: an
// autosave that overwrote the real file would be worse than losing a session.
// Written while there are unsaved changes, removed on a real save or clean exit,
// and offered back at startup if one survives.
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
// Paths only, beside the executable like config.json. Deliberately not inside a
// package: it describes this machine's history, not the part. Entries are
// keyed on the path, most recent first, capped so the file can't grow forever.
// Whether a file still exists is answered at read time, not stored — a share
// that was offline yesterday should not leave a permanent tombstone.
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
  // stat every entry so the list can grey out what has gone missing without
  // dropping it — a network share being down is not the same as a deletion.
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
// electron-updater against the GitHub releases of this repo, turned all the way
// down: it checks, and does nothing else without a click. autoDownload off means
// a check never spends someone's bandwidth; autoInstallOnAppQuit off means a
// quit never becomes an install nobody asked for. The renderer owns the rest —
// it is the only side that knows whether a package is open and dirty.
//
// Nothing here runs unpackaged: there is no installed app to replace, and
// electron-updater would only complain about a missing dev-app-update.yml.
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

// Release notes arrive as HTML from the GitHub release body. Flattened to plain
// text rather than rendered: this goes into a dialog, not a browser.
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
    // Offline, GitHub unreachable, a release with no latest.yml. Never fatal:
    // the app works exactly as well as it did a minute ago.
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
  // The renderer has already checked there is nothing unsaved, so the close
  // guard has nothing left to ask about — and quitAndInstall() closes windows
  // before anything can answer it.
  allowClose = true;
  setImmediate(() => up.quitAndInstall(false, true));
  return { ok: true };
});

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
