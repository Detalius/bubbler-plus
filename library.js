// ---------------------------------------------------------------------------
// Library
//
// Search over the whole share, with a preview and two things you can do with
// what you find: print it, or open it for editing.
//
// This file itself is still strictly read-only and still writes nothing. "Open
// for editing" does not load anything here — it hands the path up to the shell
// and lets renderer.js do what it already does for a recent or a file pick.
// Keeping the mutation on one side of that line is what makes this file safe to
// reason about.
//
// Search reads the sidecar index rather than the packages, so a query costs one
// directory read. Only when a part is opened is its .insp actually fetched.
//
// Sheet rendering is borrowed from renderer.js via window.BubblerSheets. That is
// a seam, not a permanent arrangement — the page builder wants to live in a
// shared module that both files import, and this keeps that a rename rather than
// a rewrite.
// ---------------------------------------------------------------------------
import * as pdfjsLib from './node_modules/pdfjs-dist/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './node_modules/pdfjs-dist/build/pdf.worker.mjs';

const $ = id => document.getElementById(id);
const api = () => window.api;
const sheets = () => window.BubblerSheets;

let results = [];          // sidecar records from the last search
let openPkg = null;        // { record, manifest, files, stamp }
let items = [];            // documents + sheets of the open package
let activeItem = null;
let pdfDoc = null;         // pdf.js proxy when a drawing is showing
let page = 1, pageCount = 1;
let zoom = 0.7;
let searchTimer = null;
let lastQuery = '';

// The document pane pans on middle-drag like every other preview surface.
// sheets(), not a bare S: S is a local inside the render functions, so naming
// it out here would have thrown on load.
sheets().enablePan?.(document.getElementById('libScroll'));
// And Ctrl+scroll zooms it, through the same slider, like every other pane.
sheets().wheelZoom?.(document.getElementById('libScroll'), document.getElementById('libZoom'));

// ---- entry ----
// The shell owns which screen is showing; this file only asks to be shown.
// It used to reach up and toggle the mode screens itself, which meant the
// viewer was driving the app. renderer.js calls in, and gets a way back out.
window.BubblerLibrary = {
  show() {
    syncActions();
    $('library').hidden = false;
    $('libSearch').focus();
    if (!results.length) runSearch('');
    // Coming back here is the usual moment a package has just been saved from
    // Bubbler, so this is where a stale preview gets caught.
    freshen();
  },
  // Called after the shell flags a package missing because opening it failed,
  // so the row that just failed stops being offered without a round trip
  // through Settings.
  refresh() { runSearch(lastQuery); }
};

$('libBack').onclick = () => {
  $('library').hidden = true;
  window.showLauncher?.();
};

// ---- search ----
$('libSearch').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value;
  searchTimer = setTimeout(() => runSearch(q), 200);   // typing shouldn't hammer the share
});

// How many records the index holds at all, matching or not. Without it there is
// no way to tell "nothing matched that search" from "nothing has ever been
// indexed", and the second one used to read as "Nothing found." beside a fully
// configured share.
let indexTotal = 0;
let hasPackagesRoot = false;

// Searches can overlap — typing, the missing toggle, a refresh after a rebuild —
// and a slow share can answer them out of order. Only the newest one renders,
// or an older answer lands last and the list shows a state from before.
let searchSeq = 0;
async function runSearch(q) {
  if (!api()?.searchPackages) return;
  lastQuery = q;
  const seq = ++searchSeq;
  const includeMissing = $('libMissing').checked;
  const r = await api().searchPackages(q, { includeMissing });
  if (seq !== searchSeq) return;
  if (!r?.ok) {
    $('libCount').textContent = r?.reason || 'Search unavailable';
    results = [];
    renderResults();
    return;
  }
  results = r.results || [];
  indexTotal = r.total || 0;
  hasPackagesRoot = !!r.hasRoot;
  const gone = results.filter(x => x.missing).length;
  $('libCount').textContent =
    `${results.length} package${results.length === 1 ? '' : 's'}` +
    (gone ? ` \u00b7 ${gone} missing` : '') +
    (results.length === 200 ? ' (first 200)' : '');
  // Only worth offering once there's something to reveal.
  $('libMissingWrap').hidden = false;
  renderResults();
}

function renderResults() {
  const host = $('libResults');
  host.innerHTML = '';
  if (!results.length) {
    const p = document.createElement('div');
    p.className = 'lib-empty';
    p.style.padding = '20px 4px';
    // Three different situations, and only the first is the user's search.
    // State the fact and where to go; no inline button, because building an
    // index is a Settings-sized decision, not a stray click in a search box.
    p.textContent =
      indexTotal ? 'Nothing found.'
      : hasPackagesRoot
        ? 'Nothing indexed yet. Settings can rebuild the index from the packages root.'
        : 'Only packages you have saved or opened appear here. '
          + 'Set a packages root in Settings to index a whole share.';
    host.appendChild(p);
    return;
  }
  for (const rec of results) {
    const card = document.createElement('div');
    card.className = 'lib-card'
      + (openPkg?.record?.packageId === rec.packageId ? ' on' : '')
      + (rec.missing ? ' gone' : '');
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = `${rec.partNumber || '(no number)'}${rec.partRev ? ' Rev ' + rec.partRev : ''}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [rec.customer, rec.partName].filter(Boolean).join(' \u00b7 ') || '\u2014';
    // The file name, because two packages can share every field above it —
    // Part1_plated.insp and Part1_unplated.insp are one part number.
    const file = document.createElement('div');
    file.className = 'file';
    const p = rec.path || rec.file || '';
    file.textContent = p.split(/[\\/]/).pop() || '';
    file.title = p;
    card.append(nm, meta, file);
    card.onclick = () => openPackage(rec);
    host.appendChild(card);
  }
}

// ---- opening a package ----
// keepId: after a re-read, reselect the item that was showing rather than
// jumping back to the first drawing.
async function openPackage(rec, keepId = null) {
  setStatus('Opening\u2026');
  try {
    // {bytes, stamp} since file locking. The stamp is what freshen() compares
    // against: the package is read once and held, so without it a save from
    // Bubbler never reached this preview until another package was opened.
    const { bytes, stamp } = await api().readPackage(rec.path || rec.file);
    const files = fflate.unzipSync(new Uint8Array(bytes));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    openPkg = { record: rec, manifest, files, stamp: stamp || null };
    activeItem = null;                 // the previous package's item is gone
    syncActions();

    // Drawings first — that's what most people are after — then the sheets.
    items = [
      ...(manifest.documents || []).map(d => ({ kind: 'drawing', id: d.id, label: d.label || d.file, doc: d })),
      ...(manifest.inspectionSheets || []).map(sh => ({ kind: 'sheet', id: sh.id, label: sh.name, sheet: sh }))
    ];
    renderResults();
    renderDocs();
    $('libDocs').hidden = false;
    const keep = keepId && items.find(x => x.id === keepId);
    if (items.length) selectItem(keep || items[0], { fresh: true });
    else setStatus('This package has no drawings or sheets.');
  } catch (err) {
    // A failed open leaves NOTHING open. It used to keep the previous package:
    // its card stayed highlighted, its drawings stayed listed, and Open and
    // Inspect still pointed at it under a message about a different package.
    openPkg = null;
    items = [];
    activeItem = null;
    $('libDocs').hidden = true;
    setStatus(`Could not open: ${err.message}`);
    // Same rule as opening for edit: a failed open is the one cheap moment to
    // learn a package is gone, so flag it now rather than at the next rebuild.
    // The refresh re-searches, which also re-renders the list without a stale
    // highlight.
    if (rec?.packageId && /ENOENT|no such file|cannot find/i.test(err.message || '')) {
      try { await api().indexFlagMissing?.(rec.packageId); } catch { /* the index can wait */ }
    }
    runSearch(lastQuery);
  }
}

function renderDocs() {
  const host = $('libDocs');
  host.innerHTML = '';
  const groups = [['Drawings', 'drawing'], ['Sheets', 'sheet']];
  for (const [title, kind] of groups) {
    const list = items.filter(i => i.kind === kind);
    if (!list.length) continue;
    const h = document.createElement('div');
    h.className = 'lib-group';
    h.textContent = title;
    host.appendChild(h);
    for (const it of list) {
      const card = document.createElement('div');
      card.className = 'lib-card' + (activeItem === it ? ' on' : '');
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = it.label;
      card.appendChild(nm);
      if (it.kind === 'drawing') {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = `${it.doc.pages || '?'} page${it.doc.pages === 1 ? '' : 's'}`;
        card.appendChild(meta);
      }
      card.onclick = () => selectItem(it);
      host.appendChild(card);
    }
  }
}

// Open needs a package; Print needs something selected to print. They used to
// live in the footer and inherit its hidden/shown state for free — in the bar
// they are always visible, so they say for themselves when they are usable.
function syncActions() {
  $('libOpen').disabled = !openPkg;
  // Same gate as Open: both need a real package behind the selection, where
  // Print only needs something on screen — a loose drawing prints fine.
  $('libInspect').disabled = !openPkg;
  $('libPrint').disabled = !activeItem;
}

// Re-reads the open package if the file changed since it was read. A stat per
// check, never a read: the bytes are only fetched again when they are stale.
// Returns true if it reloaded (which reselects on its own).
let freshening = false;
async function freshen(keepId = activeItem?.id) {
  if (!openPkg || freshening || !api()?.packageStamp) return false;
  freshening = true;
  try {
    const rec = openPkg.record, was = openPkg.stamp;
    const now = await api().packageStamp(rec.path || rec.file);
    const moved = now && (!was || now.size !== was.size || Math.abs(now.mtimeMs - was.mtimeMs) >= 2);
    if (!moved) return false;
    await openPackage(rec, keepId);
    return true;
  } catch {
    return false;          // a share that is down is openPackage's problem, not a preview's
  } finally {
    freshening = false;
  }
}

async function selectItem(it, { fresh = false } = {}) {
  // Items belong to the package they were built from; a reload builds new ones.
  if (!fresh && await freshen(it.id)) return;
  activeItem = it;
  page = 1;
  renderDocs();
  syncActions();
  $('libEmpty').hidden = true;
  $('libScroll').hidden = false;
  $('libFoot').hidden = false;
  if (it.kind === 'drawing') await showDrawing(it);
  else await showSheet(it);
}

// ---- drawing preview: the stored PDF, bubbles stamped as they were placed ----
async function showDrawing(it) {
  const raw = openPkg.files[it.doc.file];
  if (!raw) { setStatus(`Missing ${it.doc.file} inside the package.`); return; }
  const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  try { await pdfDoc?.destroy(); } catch { /* ignore */ }
  pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  pageCount = pdfDoc.numPages;
  await paintDrawing();
}

async function paintDrawing() {
  const host = $('libPaper');
  host.innerHTML = '';
  host.style.zoom = 1;                    // canvases scale themselves
  const p = await pdfDoc.getPage(page);
  const vp = p.getViewport({ scale: zoom * 1.5 });
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = `${vp.width}px`;
  canvas.style.height = `${vp.height}px`;
  canvas.style.boxShadow = '0 1px 12px rgba(0,0,0,.5)';
  host.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  await p.render({
    canvasContext: ctx, viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
  }).promise;

  // Annotations live in the manifest, not the PDF, so they are painted on top —
  // the same arrangement the Dimensions preview uses, and now literally the
  // same painter. The bubble-only copy that used to live here meant a rectangle
  // or a note was missing from the preview even after printing learned to draw
  // them.
  //
  // dpr, not identity: the backing store is devicePixelRatio times the CSS size
  // and pdf.js rendered the page through that same scale. The old local painter
  // reset to identity, which drew annotations at 1/dpr on any HiDPI screen.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const S = sheets();
  S.paintElements(ctx, vp, vp.scale,
    S.elementsFromManifest(openPkg.manifest, activeItem.id)
      .filter(e => e.pdfPage === page - 1));
  updateFoot(`${activeItem.label}`);
}

// ---- sheet preview: rebuilt from the manifest, same builder the editor uses ----
async function showSheet(it) {
  const S = sheets();
  if (!S) { setStatus('Sheet rendering unavailable.'); return; }
  const host = $('libPaper');
  host.innerHTML = '';
  host.style.zoom = zoom;

  const pages = sheetPages(it.sheet);
  pageCount = pages.length;
  page = Math.min(page, pageCount);
  const ctx = S.sheetCtx(it.sheet, pages.reduce((n, p) => n + p.length, 0));
  pages.forEach((rows, i) => {
    if (i + 1 !== page) return;          // one page at a time, like the drawing view
    host.appendChild(S.buildPage(ctx, rows, i + 1, pages.length));
  });
  updateFoot(`${it.label} \u00b7 ${it.sheet.stage} \u00b7 ${it.sheet.orientation}`);
}

// Rebuilds the printable rows from the stored manifest. The editor works from
// live objects; here everything comes out of the package as saved.
function sheetPages(sh) {
  const S = sheets();
  const m = openPkg.manifest;
  const byId = new Map((m.characteristics || []).map(c => [c.id, c]));
  const rows = [];
  for (const it of (sh.items || [])) {
    if (it.type === 'header') { rows.push({ type: 'header', text: it.text }); continue; }
    if (!it.include) continue;
    const [id, sub] = String(it.ref).split('#');
    const c = byId.get(id);
    if (!c) continue;
    const src = sub === undefined ? c : (c.subs || [])[+sub];
    if (!src) continue;
    // Same unit rule as Create mode, from the same function: a sheet printed
    // here and printed there must not disagree about which spec it shows.
    const shown = S.specSource(src, sh.units);
    rows.push({
      type: 'characteristic',
      number: sub === undefined ? c.number : '',
      isSub: sub !== undefined,
      spec: it.override?.spec || (shown ? S.renderSpec(shown) : ''),
      method: it.override?.method || src.method || '',
      bands: []
    });
  }
  return S.paginateRows(rows, sh.orientation, sh.stage);
}

// ---- footer controls ----
function updateFoot(info) {
  $('libInfo').textContent = info;
  $('libPage').textContent = `${page} / ${pageCount}`;
  $('libZoomPct').textContent = `${Math.round(zoom * 100)}%`;
}

// Returns the render's promise: a drawing repaints through pdf.js and a sheet
// through the page builder, and the zoom slider has to wait for whichever it is
// before it can put the view back where it was.
function repaint() {
  if (!activeItem) return Promise.resolve();
  return activeItem.kind === 'drawing' ? paintDrawing() : showSheet(activeItem);
}

$('libPrev').onclick = () => { if (page > 1) { page--; repaint(); } };
$('libNext').onclick = () => { if (page < pageCount) { page++; repaint(); } };
$('libZoom').oninput = e => {
  // Same anchor every other zoom in the app uses, borrowed over the same seam
  // as enablePan. #libPaper is the constant here — the drawing view throws its
  // canvas away and builds a new one each repaint.
  const hold = sheets().holdCentre?.($('libScroll'), $('libPaper')) || (() => {});
  zoom = +e.target.value / 100;
  repaint().then(hold);
};
$('libMissing').onchange = () => runSearch(lastQuery);

function setStatus(text) {
  syncActions();
  $('libEmpty').hidden = false;
  $('libEmpty').textContent = text;
  $('libScroll').hidden = true;
  $('libFoot').hidden = true;
}

// ---- printing ----
// The package, not the item: you open a package for editing, and which sheet
// happened to be previewed is not part of that.
// Neither of these touches screen state. The shell owns that, and it is the
// only side that knows whether the load actually happened — hiding this screen
// first meant a cancelled file picker left nothing on screen at all.
const pkgPath = () => openPkg?.record?.path || openPkg?.record?.file;

$('libOpen').onclick = () => {
  const path = pkgPath();
  if (path) window.openPackageForEdit?.(path, openPkg?.record?.packageId);
};

// Same package, same load, different rail on the other side. The shell decides
// what happens on screen, as with Open — this side only names the file.
$('libInspect').onclick = () => {
  const path = pkgPath();
  if (path) window.openPackageForInspect?.(path, openPkg?.record?.packageId);
};

$('libPick').onclick = () => window.pickPackageFile?.();

$('libPrint').onclick = async () => {
  if (!activeItem) return;
  const S = sheets();
  try {
    if (activeItem.kind === 'sheet') {
      const sh = activeItem.sheet;
      const pages = sheetPages(sh);
      const holder = document.createElement('div');
      const ctx = S.sheetCtx(sh, pages.reduce((n, p) => n + p.length, 0));
      pages.forEach((rows, i) => holder.appendChild(S.buildPage(ctx, rows, i + 1, pages.length)));
      const html = `<!doctype html><html><head><meta charset="utf-8">
        <style>${S.printCss(await S.symbolFontDataUri())}</style></head>
        <body>${holder.innerHTML}</body></html>`;
      await api().printDialog({ html, landscape: sh.orientation === 'landscape' });
    } else {
      // A drawing is already a PDF, so the bytes go straight to the print
      // service. Never base64 it here: a multi-megabyte drawing overflows the
      // stack the moment you spread it into String.fromCharCode.
      const bytes = await stampedDrawing(activeItem);
      await api().printPdfBytes({ data: bytes, landscape: false });
    }
  } catch (err) {
    setStatus(`Could not print: ${err.message}`);
  }
};

// Bubbles are stamped onto a copy for printing, exactly as Create mode exports.
async function stampedDrawing(it) {
  const raw = openPkg.files[it.doc.file];
  const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const { PDFDocument, StandardFonts } = PDFLib;
  const out = await PDFDocument.load(bytes.slice(0));
  const pages = out.getPages();

  // The same stamper the export path uses, so a printed drawing and an exported
  // one cannot disagree. This file used to carry its own bubble-only copy, and
  // rectangles, lines and notes were silently dropped from every print.
  //
  // pdf-lib fonts cannot cross documents, so the faces are embedded here and
  // handed over. No Verisurf: the library has no access to the font bytes, and
  // Helvetica is what the previous implementation used anyway.
  const S = sheets();
  const base = await out.embedFont(StandardFonts.Helvetica);
  const fonts = {
    '':   base,
    'b':  await out.embedFont(StandardFonts.HelveticaBold),
    'i':  await out.embedFont(StandardFonts.HelveticaOblique),
    'bi': await out.embedFont(StandardFonts.HelveticaBoldOblique)
  };
  S.stampElements(pages, S.elementsFromManifest(openPkg.manifest, it.id), fonts);

  // Margins are baked into the BYTES, not asked for at print time.
  //
  // webContents.print()'s margins option lays out HTML. A PDF loaded into a
  // window is drawn by Chromium's PDF viewer, which prints the pages as they
  // are and never sees that option — which is why 0" and 1" produced identical
  // paper. Scaling the content here instead is deterministic and survives the
  // trip through any printer, driver or dialog.
  //
  // After the stamping, deliberately: the bubbles have to shrink with the
  // drawing or they stop pointing at anything.
  let marginIn = 0;
  try { marginIn = Number((await api().getConfig())?.PRINT_MARGIN_IN ?? 0); } catch {}
  const m = Math.max(0, Math.min(1, marginIn || 0)) * 72;        // inches -> points
  if (m) {
    for (const p of pages) {
      // The CROP box, not getSize()'s media box. Viewers and printers show the
      // crop box, and CAD exports very often inset it from the media box —
      // centring against the wrong one puts the drawing off centre and eats
      // most of the margin on two sides. That is what made a 0.5" setting print
      // as roughly a quarter inch, tighter at the left and top.
      const b = p.getCropBox() || p.getMediaBox();
      // One scale for both axes: fitting each independently would hit the
      // margin exactly on all four sides and stretch the drawing to do it.
      // The tighter axis gets the margin asked for, the other gets more.
      const s = Math.min((b.width - 2 * m) / b.width, (b.height - 2 * m) / b.height);
      if (s <= 0 || s >= 1) continue;                    // margin bigger than the page
      // Scaling is about (0,0), so an offset box has to have its own origin
      // taken back out before re-centring: b.x * s is where the left edge lands
      // on its own, and it needs to land at b.x + half the slack instead.
      p.scaleContent(s, s);
      p.translateContent(b.x + (b.width  - b.width  * s) / 2 - b.x * s,
                         b.y + (b.height - b.height * s) / 2 - b.y * s);
    }
  }
  return await out.save();
}
