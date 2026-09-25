// ---------------------------------------------------------------------------
// Library
//
// Search the share, preview what you find, print it, or hand it to the editor.
// Nothing here writes a package: Open and Inspect pass the path up to the shell,
// which loads it the same way it loads a recent or a file pick.
//
// Search reads the sidecar index, not the packages, so a query costs one
// directory read. The .insp itself is only fetched when a package is opened.
//
// Sheet rendering is borrowed from renderer.js through window.BubblerSheets.
// ---------------------------------------------------------------------------
import * as pdfjsLib from './node_modules/pdfjs-dist/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './node_modules/pdfjs-dist/build/pdf.worker.mjs';

const $ = id => document.getElementById(id);
const api = () => window.api;
const sheets = () => window.BubblerSheets;
const pkgPath = () => openPkg?.record?.path || openPkg?.record?.file;

let results = [];          // sidecar records from the last search
let openPkg = null;        // { record, manifest, files, stamp }
let items = [];            // documents + sheets of the open package
let activeItem = null;
let pdfDoc = null;         // pdf.js proxy when a drawing is showing
let page = 1, pageCount = 1;
let zoom = 0.7;
let searchTimer = null;
let lastQuery = '';
let searchSeq = 0;
let indexTotal = 0;
let hasPackagesRoot = false;
let freshening = false;

// Middle-drag pans and Ctrl+scroll zooms, same as every other preview pane.
// sheets() rather than a bare S: S only exists inside the render functions.
sheets().enablePan?.(document.getElementById('libScroll'));
sheets().wheelZoom?.(document.getElementById('libScroll'), document.getElementById('libZoom'));

// ---- Entry ----
// The shell owns which screen is showing; this file only asks to be shown.
window.BubblerLibrary = {
  show() {
    syncActions();
    $('library').hidden = false;
    $('libSearch').focus();
    if (!results.length) runSearch('');
    // Coming back from the editor is the usual moment a preview goes stale.
    freshen();
  },
  // Called by the shell after it flags a package missing, so the failed row
  // stops being offered without a trip through Settings.
  refresh() { runSearch(lastQuery); }
};

$('libBack').onclick = () => {
  $('library').hidden = true;
  window.showLauncher?.();
};

// ---- Search ----
$('libSearch').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value;
  searchTimer = setTimeout(() => runSearch(q), 200);   // typing shouldn't hammer the share
});

// Runs on typing (debounced), the missing toggle, refresh(), and a failed open.
// Searches can overlap on a slow share, so only the newest one renders.
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
  // The missing toggle appears once a search has come back.
  $('libMissingWrap').hidden = false;
  renderResults();
}

// Creates each card in the library list with part number, revision, customer,
// part name and file name. File name is needed because two packages can share
// all the other information.
function renderResults() {
  const host = $('libResults');
  host.innerHTML = '';
  if (!results.length) {
    const p = document.createElement('div');
    p.className = 'lib-empty';
    p.style.padding = '20px 4px';
    // Three cases: nothing matched, nothing indexed, or no packages root set.
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
    const file = document.createElement('div');
    file.className = 'file';
    const p = rec.path || rec.file || '';
    file.textContent = p.split(/[\\/]/).pop() || '';
    file.title = p;
    card.append(nm, meta, file);
    card.onclick = () => readPackage(rec);
    host.appendChild(card);
  }
}

// ---- Opening a package ----
// Reads a package's manifest to list its drawings and sheets in the Library.
// Not the editor's open. Runs when a card in the results list is clicked, and
// from freshen() when the file has changed. keepId: after a re-read, reselect
// the item that was showing instead of jumping back to the first drawing.
async function readPackage(rec, keepId = null) {
  setStatus('Opening\u2026');
  try {
    // api().readPackage returns {bytes, stamp}. The package is read once and held,
    // and the stamp is what freshen() compares against later.
    const { bytes, stamp } = await api().readPackage(rec.path || rec.file);
    const files = fflate.unzipSync(new Uint8Array(bytes));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    openPkg = { record: rec, manifest, files, stamp: stamp || null };
    activeItem = null;                 // the previous package's item is gone
    syncActions();

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
    // When a package fails to open: clear the previously open package so its
    // card, drawing list and action buttons don't stay live under the error.
    // If the file is gone, flag it missing now, then re-search so the list
    // drops the stale highlight.
    openPkg = null;
    items = [];
    activeItem = null;
    $('libDocs').hidden = true;
    setStatus(`Could not open: ${err.message}`);
    if (rec?.packageId && /ENOENT|no such file|cannot find/i.test(err.message || '')) {
      try { await api().indexFlagMissing?.(rec.packageId); } catch { /* the index can wait */ }
    }
    runSearch(lastQuery);
  }
}

// Lists the open package's drawings and sheets under their group headings.
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

// Action buttons are only enabled when usable: when a package is selected, or
// when a list item is selected (no item is selected while reading a package).
function syncActions() {
  $('libOpen').disabled = !openPkg;
  $('libInspect').disabled = !openPkg;
  $('libPrint').disabled = !activeItem;
}

// When returning to the Library, and before selecting a drawing or sheet,
// checks whether the open package's file has changed since it was read and
// re-reads it if so. Returns true if it reloaded, which reselects on its own.
async function freshen(keepId = activeItem?.id) {
  if (!openPkg || freshening || !api()?.packageStamp) return false;
  freshening = true;
  try {
    const rec = openPkg.record, was = openPkg.stamp;
    const now = await api().packageStamp(rec.path || rec.file);
    const moved = now && (!was || now.size !== was.size || Math.abs(now.mtimeMs - was.mtimeMs) >= 2);
    if (!moved) return false;
    await readPackage(rec, keepId);
    return true;
  } catch {
    return false;          // a share that is down is readPackage's problem
  } finally {
    freshening = false;
  }
}

// Shows a drawing or sheet in the preview. Runs when a drawing or sheet card
// in the package's contents list is clicked, and from readPackage() when a
// package card in the results list is clicked, selecting its first item
// (fresh: true, as the package was just read).
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

// ---- Drawing preview: the stored PDF with the manifest's annotations on top ----
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

  // Annotations live in the manifest, not the PDF, so the shared painter draws
  // them over the rendered page. The transform is dpr rather than identity: the
  // canvas is dpr times its CSS size and pdf.js rendered through that scale.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const S = sheets();
  S.paintElements(ctx, vp, vp.scale,
    S.elementsFromManifest(openPkg.manifest, activeItem.id)
      .filter(e => e.pdfPage === page - 1));
  updateFoot(`${activeItem.label}`);
}

// ---- Sheet preview: rebuilt from the manifest with the editor's builder ----
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

// Rebuilds the printable rows from the stored manifest. The editor builds the
// same rows from live objects.
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
    // Same unit rule as the editor, from the same function, so one sheet cannot
    // print two ways.
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

// ---- Footer controls ----
function updateFoot(info) {
  $('libInfo').textContent = info;
  $('libPage').textContent = `${page} / ${pageCount}`;
  $('libZoomPct').textContent = `${Math.round(zoom * 100)}%`;
}

// Returns the render's promise; the zoom slider waits on it before restoring
// the view.
function repaint() {
  if (!activeItem) return Promise.resolve();
  return activeItem.kind === 'drawing' ? paintDrawing() : showSheet(activeItem);
}

$('libPrev').onclick = () => { if (page > 1) { page--; repaint(); } };
$('libNext').onclick = () => { if (page < pageCount) { page++; repaint(); } };
$('libZoom').oninput = e => {
  // Same centre-hold as every other zoom. #libPaper is the constant: the
  // drawing view builds a new canvas on each repaint.
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

// ---- Package interactions ----
// Opens the selected library package in the editor. The shell controls screen
// state, so this doesn't hide itself.
$('libOpen').onclick = () => {
  const path = pkgPath();
  if (path) window.openPackageForEdit?.(path, openPkg?.record?.packageId);
};

// Opens the selected library package in Inspect mode.
$('libInspect').onclick = () => {
  const path = pkgPath();
  if (path) window.openPackageForInspect?.(path, openPkg?.record?.packageId);
};

// File picker
$('libPick').onclick = () => window.pickPackageFile?.();

// ---- Printing ----
$('libPrint').onclick = async () => {
  if (!activeItem) return;
  const S = sheets();
  try {
    // buildPage() returns raw DOM, and main prints it in a blank window, so the
    // sheet has to travel as a document carrying its own print stylesheet.
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
      // A drawing is already a PDF. Don't base64 it; a large one overflows the
      // stack.
      const bytes = await stampedDrawing(activeItem);
      await api().printPdfBytes({ data: bytes, landscape: false });
    }
  } catch (err) {
    setStatus(`Could not print: ${err.message}`);
  }
};

// Annotations are stamped onto a copy of the PDF for printing, exactly like the
// editor's export.
async function stampedDrawing(it) {
  const raw = openPkg.files[it.doc.file];
  const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const { PDFDocument, StandardFonts } = PDFLib;
  const out = await PDFDocument.load(bytes.slice(0));
  const pages = out.getPages();

  // pdf-lib fonts cannot cross documents, so the faces are embedded here and
  // handed to the shared stamper. Helvetica only, until fontkit is loaded.
  const S = sheets();
  const base = await out.embedFont(StandardFonts.Helvetica);
  const fonts = {
    '':   base,
    'b':  await out.embedFont(StandardFonts.HelveticaBold),
    'i':  await out.embedFont(StandardFonts.HelveticaOblique),
    'bi': await out.embedFont(StandardFonts.HelveticaBoldOblique),
    encode: S.toWinAnsi
  };
  S.stampElements(pages, S.elementsFromManifest(openPkg.manifest, it.id), fonts);

  // Margins are baked into the BYTES, not asked for at print time, because
  // Chromium's PDF viewer ignores webContents.print()'s margins option. Baked
  // after the stamping, so the annotations shrink with the drawing.
  let marginIn = 0;
  try { marginIn = Number((await api().getConfig())?.PRINT_MARGIN_IN ?? 0); } catch {}
  const m = Math.max(0, Math.min(1, marginIn || 0)) * 72;        // inches -> points
  if (m) {
    for (const p of pages) {
      // CAD exports often inset the crop box, and that is what printers show,
      // so centre against it rather than getSize()'s media box.
      const b = p.getCropBox() || p.getMediaBox();
      // One scale for both axes, so the drawing keeps its proportions. The long
      // edges of the sheet get the margin asked for, the short edges get more.
      const s = Math.min((b.width - 2 * m) / b.width, (b.height - 2 * m) / b.height);
      if (s <= 0 || s >= 1) continue;                    // margin bigger than the page
      // scaleContent() scales about the page origin (0,0), so an inset box
      // drifts by b.x * s and has to be re-centred after scaling.
      p.scaleContent(s, s);
      p.translateContent(b.x + (b.width  - b.width  * s) / 2 - b.x * s,
                         b.y + (b.height - b.height * s) / 2 - b.y * s);
    }
  }
  return await out.save();
}
