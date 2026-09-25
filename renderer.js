import * as pdfjsLib from './node_modules/pdfjs-dist/build/pdf.mjs';
import SYMBOLS from './assets/symbols.json' with { type: 'json' };
import METHODS from './assets/methods.json' with { type: 'json' };

pdfjsLib.GlobalWorkerOptions.workerSrc = './node_modules/pdfjs-dist/build/pdf.worker.mjs';

const { PDFDocument, rgb, StandardFonts } = PDFLib;

// Declared here rather than with the screens section: module-level code below
// uses them, and a `const` read before its declaration throws.
const $ = id => document.getElementById(id);
const fileInput = $('file');
let modalMode = 'edit';        // 'new' | 'edit'
let docBackup = null;          // restores fields if the modal is cancelled

// ---------------------------------------------------------------------------
// Dialogs
//
// One in-page dialog for every prompt the app shows. Never use
// window.alert/confirm/prompt: they leave colour pickers and <select>s dead
// until the window is refocused.
//
// dialog() resolves to { button, values }. Escape and a backdrop click resolve
// to the `dismiss` button, or null when there isn't one.
// ---------------------------------------------------------------------------

// Button vocabulary. Callers name a key; label and styling come from here.
const BTN = {
  ok:        { label: 'OK',          kind: 'primary' },
  confirm:   { label: 'Confirm',     kind: 'primary' },
  yes:       { label: 'Yes',         kind: 'primary' },
  no:        { label: 'No' },
  cancel:    { label: 'Cancel',      dismiss: true },
  close:     { label: 'Close',       dismiss: true },
  back:      { label: 'Back' },
  next:      { label: 'Next',        kind: 'primary' },
  start:     { label: 'Start',       kind: 'primary' },
  finish:    { label: 'Finish',      kind: 'primary' },
  apply:     { label: 'Apply',       kind: 'primary' },
  save:      { label: 'Save',        kind: 'primary' },
  dontSave:  { label: "Don't Save" },
  open:      { label: 'Open',        kind: 'primary' },
  add:       { label: 'Add',         kind: 'primary' },
  rename:    { label: 'Rename',      kind: 'primary' },
  duplicate: { label: 'Duplicate',   kind: 'primary' },
  recover:   { label: 'Recover',     kind: 'primary' },
  retry:     { label: 'Retry',       kind: 'primary' },
  skip:      { label: 'Skip' },
  continue:  { label: 'Continue',    kind: 'primary' },
  discard:   { label: 'Discard',     kind: 'danger' },
  delete:    { label: 'Delete',      kind: 'danger' },
  remove:    { label: 'Remove',      kind: 'danger' },
  replace:   { label: 'Replace',     kind: 'danger' },
  clear:     { label: 'Clear',       kind: 'danger' }
};

let openDialogs = 0;
const dialogOpen = () => openDialogs > 0;

// A spec is a BTN key, or { id, label, kind, dismiss, disabled } to override one.
function btnSpec(spec) {
  const base = typeof spec === 'string' ? { id: spec } : { ...spec };
  return { ...(BTN[base.id] || {}), ...base, id: base.id };
}

function dialog({ title, body, note, noteTone, fields = [], buttons = ['ok'],
                  tone = 'info', defaultId = null, spread = 0, width = null } = {}) {
  const specs = buttons.map(btnSpec);
  const dismissId = specs.find(b => b.dismiss)?.id ?? null;

  const back = document.createElement('div');
  back.className = 'dlg-back';
  const box = document.createElement('div');
  box.className = `dialog dlg ${tone}`;
  if (width) box.style.width = width;
  back.appendChild(box);

  const h = document.createElement('h2');
  h.textContent = title || '';
  box.appendChild(h);

  const scroll = document.createElement('div');
  scroll.className = 'dlg-body';
  box.appendChild(scroll);

  if (body instanceof Node) {
    scroll.appendChild(body);
  } else if (body) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = body;
    scroll.appendChild(p);
  }

  const inputs = new Map();
  if (fields.length) {
    const grid = document.createElement('div');
    grid.className = 'dlg-fields';
    for (const f of fields) {
      const wrap = document.createElement('div');
      wrap.className = 'fld' + (f.label ? '' : ' wide');
      if (f.label) {
        const lab = document.createElement('label');
        lab.textContent = f.label;
        lab.htmlFor = `dlgf_${f.key}`;
        wrap.appendChild(lab);
      }
      let input;
      if (f.type === 'select') {
        input = document.createElement('select');
        for (const o of f.options || []) {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          input.appendChild(opt);
        }
      } else if (f.type === 'checkbox') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!f.value;
      } else {
        input = document.createElement('input');
        input.type = f.type || 'text';
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        if (f.step !== undefined) input.step = f.step;
        if (f.placeholder) input.placeholder = f.placeholder;
      }
      input.id = `dlgf_${f.key}`;
      if (f.type !== 'checkbox') input.value = f.value ?? '';
      if (f.width) input.style.width = f.width;
      inputs.set(f.key, { input, f });
      wrap.appendChild(input);
      if (f.hint) {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = f.hint;
        wrap.appendChild(hint);
      }
      grid.appendChild(wrap);
    }
    scroll.appendChild(grid);
  }

  if (note) {
    const noteEl = document.createElement('p');
    noteEl.className = 'note' + (noteTone === 'warn' ? ' warn' : '');
    noteEl.textContent = note;
    scroll.appendChild(noteEl);
  }

  const readValues = () => {
    const out = {};
    for (const [key, { input, f }] of inputs) {
      out[key] = f.type === 'checkbox' ? input.checked
               : f.type === 'number'   ? Number(input.value)
               : input.value;
    }
    return out;
  };

  const acts = document.createElement('div');
  acts.className = 'actions';
  box.appendChild(acts);

  return new Promise(resolve => {
    let done = false;
    const finish = id => {
      if (done) return;
      done = true;
      openDialogs--;
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve({ button: id, values: readValues() });
    };

    specs.forEach((b, i) => {
      if (i === spread && spread > 0) {
        const gap = document.createElement('span');
        gap.className = 'spread';
        acts.appendChild(gap);
      }
      const el = document.createElement('button');
      el.textContent = b.label || b.id;
      if (b.kind === 'primary') el.className = 'primary';
      if (b.kind === 'danger') el.className = 'danger';
      el.disabled = !!b.disabled;
      el.dataset.btn = b.id;
      el.onclick = () => finish(b.id);
      acts.appendChild(el);
    });

    const onKey = e => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        finish(dismissId);
      } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON'
                 && e.target.tagName !== 'TEXTAREA') {
        const target = defaultId || specs.find(b => b.kind === 'primary')?.id;
        const btn = target && acts.querySelector(`[data-btn="${target}"]`);
        if (btn && !btn.disabled) { e.preventDefault(); e.stopPropagation(); finish(target); }
      } else if (e.key === 'Tab') {
        // Traps focus inside the dialog.
        const f = [...box.querySelectorAll('input,select,button,textarea')]
          .filter(x => !x.disabled);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1)
                                : (i === f.length - 1 ? 0 : i + 1);
        e.preventDefault();
        f[next].focus();
      }
    };

    // Capture phase, so the dialog sees keys before the global shortcuts, where
    // Escape means deselect.
    document.addEventListener('keydown', onKey, true);
    back.onmousedown = e => { if (e.target === back) finish(dismissId); };

    openDialogs++;
    document.body.appendChild(back);

    const first = inputs.size
      ? [...inputs.values()][0].input
      : acts.querySelector(`[data-btn="${defaultId}"]`)
        || acts.querySelector('.primary')
        || acts.querySelector('button');
    first?.focus();
    if (first && first.select) first.select();
  });
}

// Maps a label back to its BTN key, so confirmAction(…, 'Delete') gets the
// danger styling.
const BTN_BY_LABEL = Object.fromEntries(
  Object.entries(BTN).map(([id, b]) => [b.label.toLowerCase(), id]));

async function notify(message, detail) {
  await dialog({ title: message, body: detail, tone: 'warn', buttons: ['ok'] });
}

// Resolves true if the action button was pressed.
async function confirmAction(message, detail, okLabel = 'OK', opts = {}) {
  const okId = BTN_BY_LABEL[okLabel.toLowerCase()] || 'ok';
  const ok = { id: okId, label: okLabel };
  const cancel = { id: 'cancel', label: opts.cancelLabel || 'Cancel', dismiss: true };
  const danger = (BTN[okId]?.kind === 'danger');
  const res = await dialog({
    title: message,
    body: detail,
    tone: opts.tone || (danger ? 'danger' : 'warn'),
    buttons: [ok, cancel],
    defaultId: opts.enterAction ? okId : 'cancel'
  });
  return res.button === okId;
}

// ---------------------------------------------------------------------------
// Package state
// ---------------------------------------------------------------------------
const SCHEMA_VERSION = '0.37.0';
// version is a fallback; the real one comes from package.json via main.
const APP = { name: 'BubblerPlus', version: '0.1.0' };
window.api?.appVersion?.().then(v => { if (v) APP.version = v; });

let currentPath = null;
let currentName = null;
let dirty = false;

let readOnly = false;
let newerSchema = null;

let fileStamp = null;
let pendingStamp = null;
let pendingFork = null;

// Package metadata. `raw` is the manifest as last read or saved, so fields this
// build doesn't know survive a re-save.
let doc = {
  part: { number: '', revision: '', name: '', customerName: '',
          customerPartNumber: '', material: '', finish: '' },
  package: { id: null, createdUtc: null, createdBy: 'local', author: '', editDate: '',
             audit: [] },
  raw: null
};

// Drawings in this package. `pdfDoc` and `originalBytes` always point at the
// active one.
let docs = [];
let activeDocId = null;

function updateTitle() {
  const label = currentName || 'Untitled';
  const tag = newerSchema ? ' [view only]' : readOnly ? ' [read-only]' : '';
  const title = `${dirty ? '• ' : ''}${label}${tag} — Bubbler+`;
  document.title = title;
  window.api?.setTitle?.(title);
}

// Numeric compare so '0.10.0' sorts above '0.9.0' rather than below it.
function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Audit trail
//
// Records who saved the package, when, and which areas they changed. Appended
// on save, never rewritten or trimmed.
// ---------------------------------------------------------------------------
let identity = { user: '', host: '' };
if (window.api?.identity) {
  window.api.identity().then(i => { identity = i; }).catch(() => {});
}

let pendingEdits = { areas: new Set(), created: [], deleted: [] };
const resetPendingEdits = () => { pendingEdits = { areas: new Set(), created: [], deleted: [] }; };
let currentPage = 'bubbler';

// Names the area an edit is logged under, from the rail page it was made on.
function currentArea() {
  switch (currentPage) {
    case 'dimensions': return 'Dimensions';
    case 'sheets': {
      const sh = activeSheet();
      return sh ? `Sheet \u201c${sh.name}\u201d` : 'Sheets';
    }
    case 'inspect': {
      const ins = activeInsp();
      return ins ? `Inspection \u201c${ins.sheetName || 'record'}\u201d` : 'Inspections';
    }
    default: return 'Bubbles \u0026 drawings';
  }
}

const noteCreated = what => { pendingEdits.created.push(what); markDirty(); };
const noteDeleted = what => { pendingEdits.deleted.push(what); markDirty(); };

// Logs the edit's area and, on the first edit since a save, schedules an early
// recovery write. Runs after every change to package contents.
function markDirty(area) {
  pendingEdits.areas.add(area || currentArea());
  if (!dirty) {
    dirty = true;
    updateTitle();
    clearTimeout(firstRecoveryTimer);
    firstRecoveryTimer = setTimeout(autosave, FIRST_RECOVERY_MS);
  }
}

// Runs after a save, an open, a recovery, or New.
function markClean(path, name) {
  currentPath = path ?? currentPath;
  currentName = name ?? currentName;
  dirty = false;
  clearTimeout(firstRecoveryTimer);
  updateTitle();
}

// ---------------------------------------------------------------------------
// Model  —  every stored coordinate and size is in PDF points, never pixels.
//
//   every element also carries `documentId` — which drawing it lives on
//   bubble    { id, type, documentId, pdfPage, n, x, y, leader, style, char }
//   refbubble { id, type, documentId, pdfPage, n, x, y, style }
//   char      { dimension, gdt, alternateUnit, method, notes, subs[] }
//   subs[]    extra rows under the same bubble number (stacked features); same
//             field order as char, minus the bubble link and its own subs
//   alternateUnit mirrors the spec pair: { dimension, gdt }
//   Unit is implied by which table you're in (in/mm), not stored per row.
//   dimension is free text: the whole callout, tolerances and all, e.g.
//     ".02 +0 / -0.1 x 45° ± 1°"
//   gdt is the alternative: a row is either a text callout or a control frame
//   rect      { id, type, pdfPage, x, y, w, h, style }        x,y = BOTTOM-left
//   line      { id, type, pdfPage, x1, y1, x2, y2, style }
//   text      { id, type, pdfPage, x, y, text, style }   x,y = FIRST BASELINE, left
//   style     { stroke, strokeWidth, fill, fontSize, bold, italic, underline }
//
// For text, `stroke` is the glyph colour and `fill` is the background box.
// ---------------------------------------------------------------------------
let originalBytes = null;
let pdfDoc = null;
let pageIndex = 0;
let scale = 1.5;
let viewport = null;
let elements = [];
let nextNumber = 1;
let uid = 1;
let tool = 'select';
let selIds = new Set();

let stage = null, shapeLayer = null, ghostLayer = null, transformer = null;
let creating = null;

const byId = id => elements.find(e => e.id === id);
// The one selected element, or null when none or several are selected. The
// multi-select accessors are isSel, selCount and selectedEls.
const selected = () => (selIds.size === 1 ? byId([...selIds][0]) : null);
const isSel = id => selIds.has(id);
const selCount = () => selIds.size;
const selectOnly = id => { selIds = new Set(id ? [id] : []); };
const clearSel = () => { selIds = new Set(); };
const toggleSel = id => { if (!selIds.delete(id)) selIds.add(id); };
const selectedEls = () => elements.filter(e => selIds.has(e.id));

// Rectangles draw under everything else. The editor, the preview painter and
// the PDF stamper all ask this, so the three always agree.
const underlay = el => el?.type === 'rect';

// ---------------------------------------------------------------------------
// Reference bubbles
//
// A balloon that shares a characteristic's number instead of pointing at it
// with a leader. Its own element type, not a flag on `bubble`: every
// `type === 'bubble'` test excludes it, and the places that want it opt in
// through isBalloon(). It carries no char and no leader, and never appears in
// the dimension table, sheets or the workbook export.
// ---------------------------------------------------------------------------
const isBalloon = el => el?.type === 'bubble' || el?.type === 'refbubble';

// The number the reference tool places next. Separate from nextNumber: a
// reference bubble borrows a number, never consumes one.
let refNumber = 1;

// ---------------------------------------------------------------------------
// Tool defaults
// ---------------------------------------------------------------------------
// What each tool creates next, edited from the defaults strip.
let defaults = {
  bubble: { stroke: '#c0392b', strokeWidth: 0.88, fill: '#ffffff', radius: 8 },
  refbubble: { stroke: '#c0392b', strokeWidth: 0.88, fill: '#ffffff', radius: 8 },
  rect:    { stroke: '#c0392b', strokeWidth: 1.2, fill: 'none' },
  line:    { stroke: '#c0392b', strokeWidth: 1.2, fill: 'none' },
  text:    { stroke: '#c0392b', strokeWidth: 1.2, fill: 'none',
             fontSize: 8, bold: false, italic: false, underline: false,
             defaultText: 'Text' }
};
const BUILTIN_DEFAULTS = structuredClone(defaults);

// Sizes are remembered per drawing, in `documents[].defaults`; colours and text
// formatting are not.
const SIZE_KEYS = ['radius', 'fontSize', 'strokeWidth'];

// Loads a drawing's remembered sizes into `defaults`, falling back to the
// built-ins. Runs from setActiveDoc(), and with null when no drawing is left.
function applyDocSizes(d) {
  for (const [t, base] of Object.entries(BUILTIN_DEFAULTS)) {
    const saved = d?.defaults?.[t] || {};
    for (const k of SIZE_KEYS) if (k in base) defaults[t][k] = saved[k] ?? base[k];
  }
}

// ---------------------------------------------------------------------------
// Drawing constants
// ---------------------------------------------------------------------------
const dpr = window.devicePixelRatio || 1;
const pdfLayer = document.getElementById('pdfLayer');
const annoLayer = document.getElementById('annoLayer');
const readout = document.getElementById('readout');

// A bubble's font and stroke scale off its radius.
const BUBBLE_R = 8;            // default radius, in points
const BUBBLE_FONT_RATIO = 1.0;
const BUBBLE_STROKE_RATIO = 0.11;
const radiusOf = b => b.style?.radius ?? BUBBLE_R;
const bubbleFont = r => r * BUBBLE_FONT_RATIO;
const bubbleStroke = r => Math.max(0.25, r * BUBBLE_STROKE_RATIO);
const DEADZONE = 4;          // points — a leader shorter than this isn't drawn
const SEL = '#2d7dd2';
const MIN_SIZE = 3;          // points — smaller than this is a stray click

// Text is anchored on the ALPHABETIC BASELINE on both sides — Konva draws with
// textBaseline:'alphabetic' and pdf-lib's drawText() takes a baseline too.
const LINE_H = 1;            // line spacing, in ems
const TEXT_PAD = 2;          // points of padding around a text background box
const DEFAULT_TEXT = 'Text';

const measureCtx = document.createElement('canvas').getContext('2d');

function fontSpec(st, px) {
  return `${st.italic ? 'italic ' : ''}${st.bold ? 'bold ' : ''}${px}px Helvetica, Arial, sans-serif`;
}

function measureLines(lines, st, px) {
  measureCtx.font = fontSpec(st, px);
  measureCtx.textBaseline = 'alphabetic';
  const widths = lines.map(l => measureCtx.measureText(l).width);
  const m = measureCtx.measureText('Hg');
  return {
    widths,
    maxW: Math.max(0, ...widths),
    ascent: m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent,
    descent: m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent
  };
}

const linesOf = t => String(t.text ?? '').split('\n');

// ---------------------------------------------------------------------------
// History — undo and redo, as snapshots of the whole model
// ---------------------------------------------------------------------------
const HISTORY_MAX = 50;
let undoStack = [];
let redoStack = [];

// Everything undo restores. Elements, sheets and inspections reference each
// other, so they are always snapshotted together.
const snapshot = () => ({
  elements: structuredClone(elements),
  sheets: structuredClone(sheets),
  inspections: structuredClone(inspections),
  // Drawings by REFERENCE: the bytes are immutable and too big to clone per
  // edit. settleDocs() rebuilds a drawing's pdf.js proxy if a step brings it back.
  docs: [...docs], activeDocId,
  nextNumber, uid, selIds: [...selIds]
});

function restoreSnapshot(s) {
  if (s.docs) docs = [...s.docs];
  elements = structuredClone(s.elements);
  sheets = structuredClone(s.sheets || []);
  inspections = structuredClone(s.inspections || []);
  if (!sheets.some(x => x.id === activeSheetId)) activeSheetId = sheets[0]?.id || null;
  if (!inspections.some(x => x.id === activeInspId)) activeInspId = inspections[0]?.id || null;
  nextNumber = s.nextNumber;
  uid = s.uid;
  selIds = new Set((s.selIds || []).filter(id => elements.some(e => e.id === id)));
}

// One undo step per field edit: snapshots the first time a key is seen, and not
// again until focus moves. Called from each field's input handler.
let burstKey = null;
function historyBurst(key) {
  if (burstKey === key) return;
  burstKey = key;
  pushHistory();
}
function endBurst() { burstKey = null; }
document.addEventListener('focusout', endBurst, true);

let burstSeq = 0;
const nextBurstKey = () => `hk${++burstSeq}`;

// Call BEFORE mutating. A caller that has to decide AFTER mutating whether the
// edit counts (placing a shape) takes the snapshot first and hands it in.
function pushHistory(snap = snapshot()) {
  undoStack.push(snap);
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
  updateHistoryButtons();
}

// Steps queue, since one can wait on pdf.js rebuilding a drawing: a held Ctrl+Z
// must not start the next restore before the last one settles.
let historyChain = Promise.resolve();
const undo = () => (historyChain = historyChain.then(() => stepHistory(undoStack, redoStack)));
const redo = () => (historyChain = historyChain.then(() => stepHistory(redoStack, undoStack)));

async function stepHistory(from, to) {
  if (!from.length) return;
  try {
    const prev = docs;
    to.push(snapshot());
    const s = from.pop();
    restoreSnapshot(s);
    updateHistoryButtons();
    await settleDocs(prev, s.activeDocId);
    markDirty();
    repaintAll();
  } catch (err) {
    console.error('History step failed:', err);
  }
}

// Brings the live drawings in line with a restored `docs`: destroys proxies for
// drawings the step removed, rebuilds them for ones it brought back. Only moves
// to a different drawing when the set changed, so undoing a bubble stays on the
// current page. Runs after every undo and redo.
async function settleDocs(prev, wantId) {
  for (const d of prev) {
    if (docs.includes(d)) continue;
    try { await d.pdfjs?.destroy(); } catch { /* already gone */ }
    d.pdfjs = null;
  }
  for (const d of docs) {
    if (d.pdfjs) continue;
    d.pdfjs = await pdfjsLib.getDocument({ data: d.bytes.slice(0) }).promise;
    d.numPages = d.pdfjs.numPages;
  }
  const changed = prev.length !== docs.length || prev.some(d => !docs.includes(d));
  if (!docs.length) {
    activeDocId = null; pdfDoc = null; originalBytes = null; viewport = null;
    $('pageLabel').textContent = '\u2014 / \u2014';
    applyDocSizes(null);
    showDrawing(false);
    renderDocList();
    return;
  }
  const has = id => docs.some(d => d.id === id);
  const target = changed && has(wantId) ? wantId : has(activeDocId) ? activeDocId : docs[0].id;
  if (changed || target !== activeDocId) {
    showDrawing(true);
    await setActiveDoc(target);
  }
}

// Repaints the canvas and whichever page is showing. Runs after every undo and
// redo.
function repaintAll() {
  syncStage();
  if (!$('page-dimensions').hidden) { renderDimTable(); renderPreview(); }
  if (!$('page-sheets').hidden) renderSheets();
  if (!$('page-inspect').hidden) renderInspect();
}

function updateHistoryButtons() {
  document.getElementById('undo').disabled = !undoStack.length;
  document.getElementById('redo').disabled = !redoStack.length;
}

// ---------------------------------------------------------------------------
// Drawings
//
// A package holds several drawings, each stored as drawings/<id>.pdf. Every
// element records its drawing in `documentId`.
//   docs[] = { id, file, label, bytes, sha256, receivedUtc, pdfjs, numPages }
// ---------------------------------------------------------------------------
// Identifies a package's exact drawing set, so a record resolves to the package
// it was taken against. Canonical form: non-empty hashes, deduped, sorted,
// newline-joined. main.js builds the same string; the two must match.
const drawingSetString = list =>
  [...new Set((list || []).filter(Boolean))].sort().join('\n');

async function drawingSetHash(list) {
  const canon = drawingSetString(list);
  if (!canon) return null;
  return await sha256(new TextEncoder().encode(canon));
}

async function sha256(bytes) {
  try {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;      // SubtleCrypto unavailable: no fingerprint
  }
}

const activeDoc = () => docs.find(d => d.id === activeDocId) || null;

function sheetsOf(d) {
  return Array.from({ length: d.numPages }, (_, i) => ({ sheet: i + 1, pdfPage: i }));
}

// Destroys every drawing's pdf.js proxy, which holds a worker-side cache. Runs
// before a New, an Open or a record load replaces the drawings.
async function releaseDocs() {
  for (const d of docs) {
    try { await d.pdfjs?.destroy(); } catch { /* already gone */ }
  }
  docs = [];
}

// Adds a PDF to the package as a new drawing and returns its record.
async function addDocument(bytes, label) {
  const id = `dwg_${uid++}`;
  const proxy = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  const d = {
    id,
    file: `drawings/${id}.pdf`,
    label: label || `Sheet ${docs.length + 1}`,
    bytes,
    sha256: await sha256(bytes.slice(0)),
    receivedUtc: new Date().toISOString(),
    pdfjs: proxy,
    numPages: proxy.numPages
  };
  docs.push(d);
  noteCreated(`Drawing \u201c${d.label}\u201d`);
  return d;
}

// Runs when a drawing is clicked in the list, and after one is added, removed,
// opened, or brought back by undo.
async function setActiveDoc(id) {
  const d = docs.find(x => x.id === id);
  if (!d) return;
  activeDocId = id;
  pdfDoc = d.pdfjs;
  originalBytes = d.bytes;
  pageIndex = 0;
  applyDocSizes(d);       // before the repaint below refreshes the strip
  clearSel();
  renderDocList();
  await renderPage();
}

async function removeDocument(id) {
  const d = docs.find(x => x.id === id);
  if (!d) return;
  const owned = elements.filter(e => e.documentId === id).length;
  if (owned) {
    const ok = await confirmAction(
      `Remove "${d.label}"?`,
      `It has ${owned} annotation${owned === 1 ? '' : 's'}, which will be removed too.`,
      'Remove');
    if (!ok) return;
  }

  const wasAt = docs.findIndex(x => x.id === id);
  pushHistory();
  noteDeleted(`Drawing \u201c${docs[wasAt]?.label || id}\u201d`);
  docs = docs.filter(x => x.id !== id);
  elements = elements.filter(e => e.documentId !== id);

  // Nulled, not left dead: the record lives on in the undo stack, and
  // settleDocs() rebuilds its proxy if an undo brings it back.
  try { await d.pdfjs?.destroy(); } catch { /* already gone */ }
  d.pdfjs = null;

  if (docs.length) {
    await setActiveDoc(docs[Math.min(wasAt, docs.length - 1)].id);
  } else {
    activeDocId = null; pdfDoc = null; originalBytes = null; viewport = null;
    $('pageLabel').textContent = '— / —';
    applyDocSizes(null);
    showDrawing(false);
    renderDocList();
    markDirty();
  }
}

function renderDocList() {
  const ul = $('docList');
  ul.innerHTML = '';
  if (!docs.length) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = 'No drawings yet';
    ul.appendChild(li);
  }
  for (const d of docs) {
    const count = elements.filter(e => e.documentId === d.id).length;
    const li = document.createElement('li');
    li.className = d.id === activeDocId ? 'active' : '';
    li.title = 'Double-click to rename';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = d.label;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${d.numPages}p · ${count}`;

    li.append(name, meta);
    li.onclick = () => { if (d.id !== activeDocId) setActiveDoc(d.id); };

    li.ondblclick = () => {
      const input = document.createElement('input');
      input.className = 'rename';
      input.value = d.label;
      const commit = save => {
        if (save && input.value.trim()) { d.label = input.value.trim(); markDirty(); }
        renderDocList();
      };
      input.onkeydown = e => {
        e.stopPropagation();
        if (e.key === 'Enter') commit(true);
        if (e.key === 'Escape') commit(false);
      };
      input.onblur = () => commit(true);
      input.onclick = e => e.stopPropagation();
      name.replaceWith(input);
      input.focus();
      input.select();
    };
    ul.appendChild(li);
  }
  $('removeDoc').disabled = !docs.length;
}

// ---------------------------------------------------------------------------
// Manifest
//
// An .insp is a zip of manifest.json plus the drawings. Bubbles are stored as
// `characteristics`; everything else as `annotations`.
// ---------------------------------------------------------------------------
// A characteristic's spec in the other unit. Typed by hand, never converted.
const EMPTY_ALT = { dimension: '', gdt: null };
const altUnit = a => ({ ...EMPTY_ALT, ...(a || {}) });

// A GD&T frame as stored: the builder's tokens, plus parsed datums and the
// rendered text for sheets and exports.
function gdtOut(g) {
  if (!g) return null;
  if (typeof g === 'string') g = { ...emptyGdt(), tolerance: g };
  if (!g.symbol && !g.tolerance && !g.datums && !g.diametral) return null;
  return {
    symbol: g.symbol ?? null,
    diametral: !!g.diametral,
    tolerance: g.tolerance ?? '',
    datums: g.datums ?? '',
    parsedDatums: parseDatums(g.datums),
    rendered: gdtToText(g)            // Unicode convenience copy; tokens are the source
  };
}

function gdtIn(g) {
  if (!g) return emptyGdt();
  if (typeof g === 'string') return { ...emptyGdt(), tolerance: g };
  return {
    symbol: g.symbol ?? null,
    diametral: !!g.diametral,
    tolerance: g.tolerance ?? '',
    datums: g.datums ?? ''
  };
}

// Builds the manifest from the live model. Runs on save and on autosave.
async function buildManifest() {
  const now = new Date().toISOString();
  const prev = doc.raw || {};

  // Key order is the manifest's reading order: identity, spec, how it's checked,
  // children, then where it sits on the print.
  const characteristics = elements
    .filter(e => e.type === 'bubble')
    .sort((a, b) => a.n - b.n)
    .map(e => ({
      id: e.id,
      number: e.n,
      documentId: e.documentId,
      sheet: e.pdfPage + 1,
      dimension: e.char?.dimension ?? '',
      gdt: gdtOut(e.char?.gdt),
      alternateUnit: altUnit(e.char?.alternateUnit),
      method: e.char?.method ?? '',
      notes: e.char?.notes ?? '',
      // Stacked features under one number (chamfer size + angle).
      subs: (e.char?.subs ?? []).map(sd => ({
        dimension: sd.dimension ?? '',
        gdt: gdtOut(sd.gdt),
        alternateUnit: altUnit(sd.alternateUnit),
        method: sd.method ?? '',
        notes: sd.notes ?? ''
      })),
      bubble: {
        documentId: e.documentId,
        pdfPage: e.pdfPage,
        x: e.x, y: e.y,
        radiusPt: radiusOf(e),
        leader: e.leader ? { toX: e.leader.toX, toY: e.leader.toY } : null,
        style: { ...e.style }
      }
    }));

  // applyManifest() loads annotations generically, so a new annotation type
  // only needs its fields listed here.
  const annotations = elements
    .filter(e => e.type !== 'bubble')
    .map(e => {
      const base = { id: e.id, type: e.type, documentId: e.documentId,
                     pdfPage: e.pdfPage, style: { ...e.style } };
      if (e.type === 'rect') return { ...base, x: e.x, y: e.y, w: e.w, h: e.h };
      if (e.type === 'line') return { ...base, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 };
      if (e.type === 'text') return { ...base, x: e.x, y: e.y, text: e.text };
      if (e.type === 'refbubble') return { ...base, x: e.x, y: e.y, n: e.n };
      return base;
    });

  return {
    ...prev,                      // preserve fields this build doesn't know about
    schemaVersion: SCHEMA_VERSION,
    package: {
      ...(prev.package || {}),
      id: doc.package.id || `pkg_${crypto.randomUUID().slice(0, 12)}`,
      createdUtc: doc.package.createdUtc || now,
      createdBy: doc.package.createdBy || identity.user || 'local',
      author: doc.package.author || '',
      editDate: doc.package.editDate || '',
      modifiedUtc: now,
      modifiedBy: identity.user || 'unknown',
      audit: doc.package.audit || [],
      application: APP,
      // Changes whenever a drawing is added, removed or replaced.
      drawingSetHash: await drawingSetHash(docs.map(d => d.sha256)),
      defaultUnit: dimUnit          // last unit the table was edited in
    },
    part: {
      ...(prev.part || {}),
      number: doc.part.number,
      revision: doc.part.revision,
      name: doc.part.name,
      customer: { name: doc.part.customerName, partNumber: doc.part.customerPartNumber },
      material: doc.part.material,
      finish: doc.part.finish
    },
    documents: docs.map(d => ({
      id: d.id,
      file: d.file,
      label: d.label,
      sha256: d.sha256,
      receivedUtc: d.receivedUtc,
      pages: d.numPages,
      sheets: sheetsOf(d),
      // Tool sizes remembered for this drawing. Absent until one is set.
      ...(d.defaults && Object.keys(d.defaults).length
        ? { defaults: structuredClone(d.defaults) } : {})
    })),
    activeDocumentId: activeDocId,
    characteristics,
    annotations,
    // Rows are stored in full, not as references, so a record survives later
    // changes to its sheet and characteristics.
    inspections: inspections.map(ins => ({
      id: ins.id,
      sheetId: ins.sheetId,
      sheetName: ins.sheetName || '',
      stage: ins.stage || 'in-process',
      orientation: ins.orientation || 'landscape',
      jobNumber: ins.jobNumber || '',
      machine: ins.machine || '',
      author: ins.author || '',
      editDate: ins.editDate || '',
      bandCount: ins.bandCount || 1,
      columnCount: ins.columnCount || 1,
      bands: (ins.bands || []).map(b => ({ columns: (b.columns || []).map(c => [...c]) })),
      createdUtc: ins.createdUtc,
      rows: ins.rows.map(r => r.type === 'header'
        ? { type: 'header', text: r.text || '' }
        : { type: 'characteristic', ref: r.ref, number: r.number ?? '', isSub: !!r.isSub,
            spec: r.spec || '', method: r.method || '',
            bands: (r.bands || []).map(b => ({
              gageId: b.gageId || '', values: [...(b.values || [])] })) })
    })),
    inspectionSheets: sheets.map(sh => ({
      id: sh.id,
      name: sh.name,
      stage: sh.stage,
      orientation: sh.orientation,
      units: sh.units === 'mm' ? 'mm' : 'in',
      author: sh.author || '',
      editDate: sh.editDate || '',
      createdUtc: sh.createdUtc,
      items: sh.items.map(it => it.type === 'header'
        ? { type: 'header', text: it.text }
        : { type: 'characteristic', ref: it.ref, include: !!it.include,
            override: { spec: it.override?.spec || '', method: it.override?.method || '' } })
    }))
  };
}

// Loads a manifest into the live model. Runs from openInsp() once the drawings
// are in.
function applyManifest(m) {
  doc.raw = m;
  const p = m.part || {};
  doc.part = {
    number: p.number || '', revision: p.revision || '', name: p.name || '',
    customerName: p.customer?.name || '', customerPartNumber: p.customer?.partNumber || '',
    material: p.material || '', finish: p.finish || ''
  };
  doc.package = {
    id: m.package?.id || null,
    createdUtc: m.package?.createdUtc || null,
    createdBy: m.package?.createdBy || 'local',
    audit: Array.isArray(m.package?.audit) ? m.package.audit : [],
    author: m.package?.author || '',
    editDate: m.package?.editDate || ''
  };
  setDimUnit(m.package?.defaultUnit === 'mm' ? 'mm' : 'in');

  const fallbackDoc = docs[0]?.id || null;
  elements = [];
  for (const c of (m.characteristics || [])) {
    const b = c.bubble || {};
    elements.push({
      id: c.id,
      type: 'bubble',
      documentId: b.documentId || c.documentId || fallbackDoc,
      pdfPage: b.pdfPage ?? (c.sheet ? c.sheet - 1 : 0),
      n: c.number,
      x: b.x, y: b.y,
      leader: b.leader ? { toX: b.leader.toX, toY: b.leader.toY } : null,
      style: { ...BUILTIN_DEFAULTS.bubble, ...(b.style || {}),
               radius: b.radiusPt ?? b.style?.radius ?? BUBBLE_R },
      char: {
        dimension: c.dimension ?? '',
        gdt: gdtIn(c.gdt),
        alternateUnit: altUnit(c.alternateUnit),
        method: c.method || '',
        notes: c.notes || '',
        subs: (c.subs || []).map(sd => ({
          dimension: sd.dimension ?? '',
          gdt: gdtIn(sd.gdt),
          alternateUnit: altUnit(sd.alternateUnit),
          method: sd.method || '',
          notes: sd.notes || ''
        }))
      }
    });
  }
  for (const a of (m.annotations || [])) {
    elements.push({
      ...a,
      documentId: a.documentId || fallbackDoc,
      style: { ...(BUILTIN_DEFAULTS[a.type] || {}), ...(a.style || {}) }
    });
  }

  // Raise the counter before anything below mints an id, or a repaired duplicate
  // could be handed a value that's already in use.
  uid = Math.max(uid, nextUid(m));

  sheets = (m.inspectionSheets || []).map(sh => ({
    id: sh.id,
    name: sh.name || 'Sheet',
    stage: sh.stage || 'in-process',
    orientation: sh.orientation || 'landscape',
    units: sh.units === 'mm' ? 'mm' : 'in',
    author: sh.author ?? '',
    editDate: sh.editDate ?? '',
    createdUtc: sh.createdUtc || null,
    items: (sh.items || []).map(it => it.type === 'header'
      ? { type: 'header', text: it.text || '' }
      : { type: 'characteristic', ref: it.ref, include: it.include !== false,
          override: { spec: it.override?.spec || '', method: it.override?.method || '' } })
  }));
  // Older packages can hold duplicate ids.
  dedupeIds(sheets, 'sht', (oldId, newId) => {
    inspections.forEach(i => { if (i.sheetId === oldId) i.sheetId = newId; });
  });
  activeSheetId = sheets[0]?.id || null;

  inspections = (m.inspections || []).map(ins => ({
    id: ins.id,
    sheetId: ins.sheetId,
    sheetName: ins.sheetName || '',
    stage: ins.stage || 'in-process',
    orientation: ins.orientation || 'landscape',
    jobNumber: ins.jobNumber || '',
    machine: ins.machine || '',
    author: ins.author || '',
    editDate: ins.editDate || '',
    ...restoreColumns(ins),
    createdUtc: ins.createdUtc || null
  }));
  dedupeIds(inspections, 'insp');
  activeInspId = inspections[0]?.id || null;

  nextNumber = elements.reduce(
    (mx, e) => e.type === 'bubble' ? Math.max(mx, e.n + 1) : mx, 1);
  syncDocFields();
}

// Renames the second and later holders of a repeated id, calling
// onRename(oldId, newId) so references can be repointed. The first keeps its
// id, so existing references stay valid.
function dedupeIds(list, prefix, onRename) {
  const seen = new Set();
  for (const item of list) {
    if (!seen.has(item.id)) { seen.add(item.id); continue; }
    const oldId = item.id;
    item.id = `${prefix}_${uid++}`;
    seen.add(item.id);
    console.warn(`Duplicate id ${oldId} renamed to ${item.id}`);
    if (onRename) onRename(oldId, item.id);
  }
}

// Ids look like <prefix>_<n> and share one counter, so the next safe value is
// one past the highest suffix anywhere in the package.
function nextUid(m) {
  let max = 0;
  const see = id => {
    const n = /_(\d+)$/.exec(String(id || ''));
    if (n) max = Math.max(max, +n[1]);
  };
  (m.documents || []).forEach(d => see(d.id));
  (m.characteristics || []).forEach(c => see(c.id));
  (m.annotations || []).forEach(a => see(a.id));
  (m.inspectionSheets || []).forEach(sh => see(sh.id));
  (m.inspections || []).forEach(i => see(i.id));
  return max + 1;
}

// saveAs = true always asks. Otherwise it writes straight to currentPath when
// there is one, and falls back to asking on a package that's never been saved.
async function saveInsp({ saveAs = false } = {}) {
  if (recordMode) {
    await notify('This is an inspection record, not a package',
      "Inspection records are saved with the Export PDF button on the Inspect tab. " +
      "To change the underlying package, open the .insp it came from.");
    return false;
  }
  if (!docs.length) { await notify('Nothing to save', 'Add a drawing first.'); return false; }
  // Blocks Save As too: this build would write a newer package back in its
  // older shape.
  if (newerSchema) { await notifyNewerSchema(); return false; }
  if (readOnly && !saveAs) {
    await notify('This package is open somewhere else',
      'It was opened read-only because another machine had it. Use Save As to keep this ' +
      'work under a new name, or reopen it once they are done.');
    return false;
  }
  // A copy of an indexed package (pendingFork, set on open) gets its own id on
  // its first save, never on open, which must not write the file. Re-checked
  // here: if the original has since moved or been deleted, this is a move and
  // keeps its id.
  if (pendingFork && pendingFork.id === doc.package.id) {
    const still = await window.api?.indexIdTaken?.(doc.package.id, currentPath);
    if (still?.taken) {
      doc.package.id = `pkg_${crypto.randomUUID().slice(0, 12)}`;
      console.info('[Index] New package id: this copy is now its own package,',
                   'separate from', still.at);
    }
    pendingFork = null;
  }
  // Appended before the manifest is built, so the entry is written by the save
  // it describes. Autosave never appends.
  recordAuditEntry();
  const manifest = await buildManifest();
  const entries = {
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2))
  };
  for (const d of docs) entries[d.file] = new Uint8Array(d.bytes.slice(0));
  const zip = fflate.zipSync(entries, { level: 6 });

  const stem = [doc.part.number || 'untitled', doc.part.revision && `Rev${doc.part.revision}`]
    .filter(Boolean).join('_').replace(/[^\w.-]+/g, '_');

  const saved = await saveBytes(zip, `${stem}.insp`, 'application/zip',
    [{ name: 'Inspection package', extensions: ['insp'] }],
    saveAs ? {} : { filePath: currentPath, expect: fileStamp });

  if (!saved) return false;          // cancelled
  if (saved.locked) {
    const who = `${saved.by?.user || 'Someone'}${saved.by?.host ? ' on ' + saved.by.host : ''}`;
    const { button } = await dialog({
      title: 'That package is open somewhere else',
      body: `${who} has "${saved.name}" open. Saving over it would replace a package ` +
            'while they are still working in it, so nothing was written. Pick another name.',
      tone: 'warn',
      buttons: ['cancel', { id: 'saveAs', label: 'Save As\u2026', kind: 'primary' }],
      defaultId: 'saveAs'
    });
    return button === 'saveAs' ? await saveInsp({ saveAs: true }) : false;
  }
  // Someone else saved this file since it was opened.
  if (saved.conflict) {
    const { button } = await dialog({
      title: 'This package changed on disk',
      body: `"${currentName || 'This package'}" has been saved by someone else since ` +
            'you opened it. Overwriting replaces their work with yours.',
      tone: 'warn',
      // Overwrite sits apart, as Don't Save does on the close prompt.
      buttons: [{ id: 'over', label: 'Overwrite' }, 'cancel',
                { id: 'saveAs', label: 'Save As\u2026', kind: 'primary' }],
      spread: 1,
      defaultId: 'saveAs'
    });
    if (button === 'saveAs') return await saveInsp({ saveAs: true });
    if (button !== 'over') return false;
    const forced = await saveBytes(zip, `${stem}.insp`, 'application/zip',
      [{ name: 'Inspection package', extensions: ['insp'] }], { filePath: currentPath });
    if (!forced) return false;
    return await afterSave(forced, manifest, saveAs);
  }
  return await afterSave(saved, manifest, saveAs);
}

function notifyNewerSchema() {
  return notify('Saved by a newer Bubbler+',
    `This package uses schema ${newerSchema}; this copy of Bubbler+ understands up to ` +
    `${SCHEMA_VERSION}. It is open to view, print and export. Saving is off — this ` +
    'version would write it back without whatever the newer one added. Update ' +
    'Bubbler+ to edit it.');
}

// Runs once the bytes are on disk, from both the normal and the forced
// overwrite save.
async function afterSave(saved, manifest, saveAs) {
  doc.raw = manifest;                // so a second save doesn't regenerate the package id
  fileStamp = saved.stamp || null;   // what the next save compares against
  markClean(saved.path, saved.name);
  resetPendingEdits();               // they're on record now
  await rememberRecent(saved.path, saved.name);
  clearRecovery();                   // the real file now holds this work

  // Save As takes the lock on the new file.
  if (saveAs && saved.path) {
    const lock = await window.api?.lockAcquire?.(saved.path);
    // Another session can still open the new file between the write and this.
    readOnly = !!(lock && lock.ok === false);
    updateTitle();
    if (readOnly) {
      await notify('Saved, but opened read-only',
        'Someone opened the new file in the moment after it was written. Your work is ' +
        'in it; Save is off until they close it.');
    }
  }

  await publishSidecar(saved.path, manifest);
  return true;
}

// Appends one audit entry for the pending edits. Runs from saveInsp(); a save
// with nothing pending adds nothing.
function recordAuditEntry() {
  const areas = [...pendingEdits.areas];
  if (!areas.length && !pendingEdits.created.length && !pendingEdits.deleted.length) return;
  doc.package.audit = doc.package.audit || [];
  doc.package.audit.push({
    utc: new Date().toISOString(),
    user: identity.user || 'unknown',
    host: identity.host || '',
    action: doc.package.audit.length ? 'save' : 'create',
    // Anything created or deleted is dropped from `changed`, so one action
    // reads as one event.
    changed: areas.filter(a => !pendingEdits.created.includes(a) && !pendingEdits.deleted.includes(a)),
    created: pendingEdits.created.slice(),
    deleted: pendingEdits.deleted.slice()
  });
}

// The View > History dialog: newest first, with unsaved edits as a pending
// entry at the top.
function historyDialog() {
  const list = document.createElement('div');
  list.className = 'hist';

  const pendingAreas = [...pendingEdits.areas];
  const pending = pendingAreas.length || pendingEdits.created.length || pendingEdits.deleted.length;
  const entries = [...(doc.package.audit || [])].reverse();

  if (!entries.length && !pending) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = 'Nothing recorded yet. The trail starts at the first save.';
    list.appendChild(p);
  }

  if (pending) {
    list.appendChild(histEntry({
      utc: null, user: identity.user || 'you', action: 'pending',
      changed: pendingAreas, created: pendingEdits.created, deleted: pendingEdits.deleted
    }));
  }
  for (const e of entries) list.appendChild(histEntry(e));

  return dialog({
    title: 'History',
    body: list,
    width: '560px',
    note: 'Names come from the Windows account that saved the file. ' +
          'Bubbler+ cannot verify them, and an .insp can be edited outside the ' +
          'app \u2014 treat this as a courtesy to the next person, not as evidence.',
    buttons: ['close']
  });
}

function histEntry(e) {
  const row = document.createElement('div');
  row.className = 'hist-row' + (e.action === 'pending' ? ' pending' : '');

  const head = document.createElement('div');
  head.className = 'hist-head';
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = e.user || 'unknown';
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = e.action === 'pending' ? 'unsaved changes'
                   : `${localStamp(e.utc)}${e.action === 'create' ? ' \u00b7 created package' : ''}`;
  head.append(who, when);
  row.appendChild(head);

  for (const [label, items] of [['Created', e.created], ['Changed', e.changed],
                                ['Deleted', e.deleted]]) {
    if (!items?.length) continue;
    const line = document.createElement('div');
    line.className = 'hist-line';
    const tag = document.createElement('span');
    tag.className = 'tag ' + label.toLowerCase();
    tag.textContent = label;
    const txt = document.createElement('span');
    txt.textContent = items.join(', ');
    line.append(tag, txt);
    row.appendChild(line);
  }
  return row;
}

// Formats a stored UTC time as local time.
function localStamp(utc) {
  if (!utc) return '';
  const d = new Date(utc);
  return isNaN(d) ? utc : d.toLocaleString(undefined,
    { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Publishes the package's sidecar to the index. Best effort: no share, or an
// unreachable one, is not an error. Runs after every save, and on open so a
// package moved by hand re-heals its record. Sets pendingFork when the index
// says this id belongs to another file that still exists.
async function publishSidecar(file, manifest, opts = {}) {
  if (!file || !window.api?.publishSidecar) return;
  try {
    const r = await window.api.publishSidecar({
      file,
      onOpen: opts.onOpen === true,
      packageId: manifest.package.id,
      partNumber: manifest.part.number,
      partRev: manifest.part.revision,
      partName: manifest.part.name,
      customer: manifest.part.customer?.name || '',
      drawingSetHash: manifest.package.drawingSetHash || null,
      drawings: (manifest.documents || []).map(d => ({
        id: d.id, sha256: d.sha256, label: d.label
      })),
      sheets: (manifest.inspectionSheets || []).length,
      inspections: (manifest.inspections || []).length
    });
    if (r?.forked) {
      pendingFork = { id: manifest.package.id, at: r.at };
      console.info('[Index] Not indexed: this id belongs to', r.at,
                   '- saving will give this copy its own.');
    }
  } catch (err) {
    console.warn('Could not publish to the index:', err);
  }
}

// Loads an .insp's bytes into the workspace and returns its manifest. Runs when
// opening or recovering a package, and when a record fetches or opens its source.
async function openInsp(buf) {
  clearRecordMode();
  const files = fflate.unzipSync(new Uint8Array(buf));
  const mBytes = files['manifest.json'];
  if (!mBytes) throw new Error('No manifest.json in package');
  let manifest = JSON.parse(new TextDecoder().decode(mBytes));

  // No migrations pre-1.0. Older packages load best-effort (every field has a
  // default); newer ones load view-only.
  newerSchema = null;
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    if (cmpVersion(manifest.schemaVersion, SCHEMA_VERSION) > 0) {
      newerSchema = String(manifest.schemaVersion);
      console.warn(`Package schema ${manifest.schemaVersion} is newer than this build (${SCHEMA_VERSION}); view only.`);
    } else {
      console.warn(`Package schema ${manifest.schemaVersion} predates this build (${SCHEMA_VERSION}); loading best-effort.`);
    }
  }

  const list = manifest.documents || [];
  if (!list.length) throw new Error('Package contains no drawings');

  await releaseDocs();
  uid = 1;
  const mismatched = [];
  for (const entry of list) {
    const raw = files[entry.file];
    if (!raw) throw new Error(`Package is missing ${entry.file}`);
    const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const proxy = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;

    const actual = await sha256(bytes.slice(0));
    if (entry.sha256 && actual && actual !== entry.sha256) {
      // The drawing was swapped since the bubbles were placed.
      mismatched.push(entry.label || entry.file);
    }

    docs.push({
      id: entry.id,
      file: entry.file,
      label: entry.label || entry.file,
      bytes,
      sha256: entry.sha256 || actual,
      receivedUtc: entry.receivedUtc || null,
      defaults: entry.defaults || null,
      pdfjs: proxy,
      numPages: proxy.numPages
    });
  }

  clearSel();
  undoStack = []; redoStack = []; updateHistoryButtons();
  applyManifest(manifest);

  if (mismatched.length) {
    await notify('Drawing does not match this package',
      `${mismatched.join(', ')} \u2014 the PDF stored here is not the one the bubbles ` +
      `were placed against. Check the revision before relying on this package.`);
  }
  await setActiveDoc(
    docs.find(d => d.id === manifest.activeDocumentId)?.id || docs[0].id
  );
  return manifest;                   // callers that know the path republish it
}

// Native save dialog when running in Electron; blob download otherwise.
// Returns null if cancelled, else main's result: { path, name, stamp }, or a
// { locked } / { conflict } refusal. A `filePath` writes without a dialog;
// with `noClobber`, main never overwrites and may rename, so read back `name`.
async function saveBytes(bytes, name, mime, filters,
                         { filePath = null, expect = null, noClobber = false } = {}) {
  if (window.api?.saveFile) {
    return await window.api.saveFile({ filePath, defaultPath: name, data: bytes, filters,
                                      expect, noClobber });
  }
  download(bytes, name, mime);       // browser fallback: no real path to report
  return { path: null, name };
}

function download(bytes, name, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Coordinate transform — the only place conversion happens
// ---------------------------------------------------------------------------
function canvasToPdf(cssX, cssY) {
  const [x, y] = viewport.convertToPdfPoint(cssX, cssY);
  return { x, y };
}
function pdfToCanvas(x, y) {
  const [cssX, cssY] = viewport.convertToViewportPoint(x, y);
  return { x: cssX, y: cssY };
}
// Rect helper: PDF rects are bottom-left origin, Konva rects are top-left.
function rectToCanvas(r) {
  const tl = pdfToCanvas(r.x, r.y + r.h);          // PDF top-left -> canvas top-left
  const br = pdfToCanvas(r.x + r.w, r.y);
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
}
// Reads a Konva box back into PDF points. Goes through the transform, never
// `/ scale`, so it holds on rotated pages.
function canvasBoxToPdf(cx, cy, cw, ch) {
  const a = canvasToPdf(cx, cy);
  const b = canvasToPdf(cx + cw, cy + ch);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y)
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
// Renders the page OFFSCREEN and swaps it into #pdfLayer in one synchronous
// block, since setting a canvas's width clears it. Runs on every drawing, page
// and zoom change. Renders are numbered: a newer one cancels the older, and a
// superseded one never swaps. Returns whether this render landed, so a caller
// holding a scroll restore applies it after the right picture.
let renderSeq = 0, renderTask = null;
let renderedScale = null;     // the scale #pdfLayer actually holds, for the zoom preview

async function renderPage() {
  const seq = ++renderSeq;
  try { renderTask?.cancel(); } catch { /* already finished */ }
  const page = await pdfDoc.getPage(pageIndex + 1);
  if (seq !== renderSeq) return false;
  const vp = page.getViewport({ scale });

  const off = document.createElement('canvas');
  off.width = Math.floor(vp.width * dpr);
  off.height = Math.floor(vp.height * dpr);
  const task = page.render({
    canvasContext: off.getContext('2d'),
    viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
  });
  renderTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name === 'RenderingCancelledException') return false;
    throw err;
  } finally {
    if (renderTask === task) renderTask = null;
  }
  if (seq !== renderSeq) return false;

  // The swap. Nothing below awaits, so no frame ever shows half of it.
  viewport = vp;
  pdfLayer.width = off.width;
  pdfLayer.height = off.height;
  pdfLayer.style.width = `${vp.width}px`;
  pdfLayer.style.height = `${vp.height}px`;
  pdfLayer.getContext('2d').drawImage(off, 0, 0);
  annoLayer.style.width = `${vp.width}px`;
  annoLayer.style.height = `${vp.height}px`;
  $('stack').style.zoom = '';     // the preview scale, if any, is now the real one
  renderedScale = scale;

  stage.size({ width: vp.width, height: vp.height });
  document.getElementById('pageLabel').textContent = `${pageIndex + 1} / ${pdfDoc.numPages}`;
  syncStage();
  return true;
}

// ---------------------------------------------------------------------------
// Scene — rebuilt wholesale from `elements` on any change
// ---------------------------------------------------------------------------
// Rebuilds the canvas shapes from `elements`. A repaint only: it never marks
// the package dirty.
function syncStage() {
  shapeLayer.destroyChildren();
  transformer = null;

  const onPage = elements.filter(e => e.documentId === activeDocId && e.pdfPage === pageIndex);

  // Order: rectangles, leaders, everything else. Mirrored in paintElements()
  // and stampElements().
  for (const el of onPage) if (underlay(el)) shapeLayer.add(makeRect(el));
  for (const el of onPage) if (el.type === 'bubble' && el.leader) shapeLayer.add(makeLeader(el));
  for (const el of onPage) {
    if (el.type === 'bubble') shapeLayer.add(makeBubble(el));
    else if (el.type === 'refbubble') shapeLayer.add(makeRefBubble(el));
    else if (el.type === 'line') shapeLayer.add(makeLine(el));
    else if (el.type === 'text') shapeLayer.add(makeText(el));
  }

  const s = selected();
  if (s && s.documentId === activeDocId && s.pdfPage === pageIndex) {
    if (s.type === 'bubble' && s.leader) {
      // Dropping the end back inside the balloon removes the leader.
      shapeLayer.add(handle(pdfToCanvas(s.leader.toX, s.leader.toY), p => {
        s.leader.toX = p.x; s.leader.toY = p.y;
      }, () => {
        const reach = Math.max(radiusOf(s), DEADZONE);
        if (s.leader && Math.hypot(s.leader.toX - s.x, s.leader.toY - s.y) <= reach) s.leader = null;
      }));
    } else if (s.type === 'line') {
      shapeLayer.add(handle(pdfToCanvas(s.x1, s.y1), p => { s.x1 = p.x; s.y1 = p.y; }));
      shapeLayer.add(handle(pdfToCanvas(s.x2, s.y2), p => { s.x2 = p.x; s.y2 = p.y; }));
    } else if (s.type === 'rect') {
      attachTransformer(s);
    }
  }

  shapeLayer.draw();
  syncEditor();
  syncDefaultsStrip();  // "Next #" advances as bubbles are placed
  renderDocList();      // annotation counts live in the list
  if (!$('page-dimensions').hidden) { renderDimTable(); renderPreview(); }
}

// The repaint after an edit. Selection, page navigation and undo call
// syncStage() alone.
function commitStage() {
  markDirty();
  syncStage();
}

const strokeOf = el => (isSel(el.id) ? SEL : el.style.stroke);
const fillOf = el => (el.style.fill === 'none' ? undefined : el.style.fill);

// Selection and drag handlers shared by every shape. Runs as syncStage() builds
// each one.
function wireCommon(node, el) {
  // Named by id so a group drag can move the other members' nodes directly.
  node.addName(`el-${el.id}`);
  node.on('mousedown', e => {
    // The right button belongs to the marquee; let it through to the stage.
    if (e.evt.button === 2) return;
    e.cancelBubble = true;
    // Grabbing an unselected element selects it alone. No syncStage() here:
    // rebuilding the layer destroys the node Konva just grabbed and kills the
    // drag. The repaint comes on click, or on commitStage() after a drag.
    if (!isSel(el.id) && !e.evt.shiftKey) selectOnly(el.id);
  });
  node.on('click', e => {
    e.cancelBubble = true;
    if (e.evt.shiftKey) toggleSel(el.id); else selectOnly(el.id);
    syncStage();
  });
  node.on('dragstart', () => { pushHistory(); beginGroupDrag(node, el); });
  node.on('dragmove', () => dragGroup(node));
  node.on('dragend', () => endGroupDrag());
  node.on('mouseenter', () => { stage.container().style.cursor = 'move'; });
  node.on('mouseleave', () => { stage.container().style.cursor = cursorForTool(); });
}

// ---------------------------------------------------------------------------
// Group drag
//
// Konva drags one node. The rest of the selection follows by moving their
// NODES during the drag, and the model is written once at the end: rebuilding
// the layer mid-drag would destroy the node Konva is holding. One pushHistory()
// per gesture, from wireCommon()'s dragstart.
// ---------------------------------------------------------------------------
let groupDrag = null;

function beginGroupDrag(node, el) {
  groupDrag = null;
  if (selCount() < 2 || !isSel(el.id)) return;
  const others = selectedEls().filter(e => e.id !== el.id).map(e => {
    const n = shapeLayer.findOne(`.el-${e.id}`);
    const lead = shapeLayer.findOne(`.leader-${e.id}`);
    return n ? { e, n, x0: n.x(), y0: n.y(), lead, pts: lead ? [...lead.points()] : null } : null;
  }).filter(Boolean);
  if (others.length) groupDrag = { ox: node.x(), oy: node.y(), others };
}

function dragGroup(node) {
  if (!groupDrag) return;
  const dx = node.x() - groupDrag.ox, dy = node.y() - groupDrag.oy;
  for (const o of groupDrag.others) {
    o.n.x(o.x0 + dx); o.n.y(o.y0 + dy);
    if (o.lead) o.lead.points(o.pts.map((v, i) => v + (i % 2 ? dy : dx)));
  }
}

// Writes the displacement to the model, through the transform so it holds on
// rotated pages.
function endGroupDrag() {
  if (!groupDrag) return;
  const g = groupDrag;
  groupDrag = null;
  const a = canvasToPdf(0, 0);
  const b = canvasToPdf(g.others[0].n.x() - g.others[0].x0, g.others[0].n.y() - g.others[0].y0);
  const dx = b.x - a.x, dy = b.y - a.y;
  if (!dx && !dy) return;
  for (const { e } of g.others) {
    if (e.type === 'line') { e.x1 += dx; e.y1 += dy; e.x2 += dx; e.y2 += dy; }
    else { e.x += dx; e.y += dy; }
    if (e.leader) { e.leader.toX += dx; e.leader.toY += dy; }
  }
}

// ---------------------------------------------------------------------------
// Shapes — one Konva builder per element type, called from syncStage()
// ---------------------------------------------------------------------------
function makeLeader(b) {
  const c = pdfToCanvas(b.x, b.y);
  const t = pdfToCanvas(b.leader.toX, b.leader.toY);
  return new Konva.Line({
    name: `leader-${b.id}`,
    points: [c.x, c.y, t.x, t.y],
    stroke: strokeOf(b),
    strokeWidth: bubbleStroke(radiusOf(b)) * scale,
    listening: false
  });
}

// A reference bubble's dash pattern, scaled off its radius. The ghost, canvas,
// preview and PDF all use this one.
const refDash = r => [r * 0.5, r * 0.42];

function makeRefBubble(b) {
  const c = pdfToCanvas(b.x, b.y);
  const r = radiusOf(b);
  const g = new Konva.Group({ x: c.x, y: c.y, draggable: true });

  g.add(new Konva.Circle({
    radius: r * scale,
    fill: b.style.fill === 'none' ? undefined : b.style.fill,
    stroke: strokeOf(b),
    strokeWidth: bubbleStroke(r) * scale,
    dash: refDash(r).map(v => v * scale)
  }));

  const label = new Konva.Text({
    text: String(b.n),
    fontSize: bubbleFont(r) * scale,
    fontFamily: 'Helvetica, Arial, sans-serif',
    fill: strokeOf(b),
    listening: false
  });
  label.offsetX(label.width() / 2);
  label.offsetY(label.height() / 2);
  g.add(label);

  wireCommon(g, b);
  g.on('dragmove', () => {
    const p = canvasToPdf(g.x(), g.y());
    b.x = p.x; b.y = p.y;
    showPdf(p);
  });
  g.on('dragend', () => { if (!isSel(b.id)) selectOnly(b.id); commitStage(); });
  return g;
}

function makeBubble(b) {
  const c = pdfToCanvas(b.x, b.y);
  const r = radiusOf(b);
  const g = new Konva.Group({ x: c.x, y: c.y, draggable: true });

  g.add(new Konva.Circle({
    radius: r * scale,
    fill: b.style.fill === 'none' ? undefined : b.style.fill,
    stroke: strokeOf(b),
    strokeWidth: bubbleStroke(r) * scale
  }));

  const label = new Konva.Text({
    text: String(b.n),
    fontSize: bubbleFont(r) * scale,
    fontFamily: 'Helvetica, Arial, sans-serif',
    fill: strokeOf(b),
    listening: false
  });
  label.offsetX(label.width() / 2);
  label.offsetY(label.height() / 2);
  g.add(label);

  wireCommon(g, b);
  g.on('dragmove', () => {
    const p = canvasToPdf(g.x(), g.y());
    b.x = p.x; b.y = p.y;
    if (b.leader) {
      const line = shapeLayer.findOne(`.leader-${b.id}`);
      const t = pdfToCanvas(b.leader.toX, b.leader.toY);
      if (line) line.points([g.x(), g.y(), t.x, t.y]);
    }
    showPdf(p);
  });
  g.on('dragend', () => { if (!isSel(b.id)) selectOnly(b.id); commitStage(); });
  return g;
}

function makeRect(r) {
  const box = rectToCanvas(r);
  const node = new Konva.Rect({
    ...box,
    name: `rect-${r.id}`,
    fill: fillOf(r),
    stroke: strokeOf(r),
    strokeWidth: r.style.strokeWidth * scale,
    strokeScaleEnabled: false,     // don't fatten the border while resizing
    draggable: true
  });

  wireCommon(node, r);
  node.on('dragmove', () => {
    const p = canvasBoxToPdf(node.x(), node.y(), node.width(), node.height());
    Object.assign(r, p);
  });
  node.on('dragend', () => { if (!isSel(r.id)) selectOnly(r.id); commitStage(); });

  // Bakes the Transformer's scale into real width/height, which otherwise go
  // stale.
  node.on('transformstart', () => pushHistory());
  node.on('transformend', () => {
    const w = Math.max(1, node.width() * node.scaleX());
    const h = Math.max(1, node.height() * node.scaleY());
    node.scaleX(1); node.scaleY(1);
    node.width(w); node.height(h);
    Object.assign(r, canvasBoxToPdf(node.x(), node.y(), w, h));
    commitStage();
  });

  return node;
}

function makeLine(l) {
  const a = pdfToCanvas(l.x1, l.y1);
  const b = pdfToCanvas(l.x2, l.y2);
  const node = new Konva.Line({
    x: a.x, y: a.y,
    points: [0, 0, b.x - a.x, b.y - a.y],
    stroke: strokeOf(l),
    strokeWidth: l.style.strokeWidth * scale,
    hitStrokeWidth: 12,            // thin lines are near-impossible to click otherwise
    draggable: true
  });

  wireCommon(node, l);
  node.on('dragmove', () => {
    const pts = node.points();
    const p1 = canvasToPdf(node.x(), node.y());
    const p2 = canvasToPdf(node.x() + pts[2], node.y() + pts[3]);
    l.x1 = p1.x; l.y1 = p1.y; l.x2 = p2.x; l.y2 = p2.y;
  });
  node.on('dragend', () => { if (!isSel(l.id)) selectOnly(l.id); commitStage(); });
  return node;
}

// Draws lines with the first baseline at local y=0, matching pdf-lib exactly.
function textShape(lines, st, px, color, opacity) {
  const met = measureLines(lines, st, px);
  const lh = px * LINE_H;
  return new Konva.Shape({
    opacity: opacity ?? 1,
    sceneFunc(ctx) {
      ctx.setAttr('font', fontSpec(st, px));
      ctx.setAttr('textBaseline', 'alphabetic');
      ctx.setAttr('fillStyle', color);
      lines.forEach((line, i) => {
        const y = i * lh;
        ctx.fillText(line, 0, y);
        if (st.underline && line.length) {
          // Same geometry the exporter uses, so screen and PDF agree.
          const uy = y + px * 0.12;
          ctx.beginPath();
          ctx.setAttr('strokeStyle', color);
          ctx.setAttr('lineWidth', Math.max(0.4, px * 0.06));
          ctx.moveTo(0, uy);
          ctx.lineTo(met.widths[i], uy);
          ctx.stroke();
        }
      });
    }
  });
}

function makeText(t) {
  const c = pdfToCanvas(t.x, t.y);          // c is the FIRST BASELINE on screen
  const st = t.style;
  const px = st.fontSize * scale;
  const lines = linesOf(t);
  const met = measureLines(lines, st, px);
  const pad = TEXT_PAD * scale;

  const g = new Konva.Group({ x: c.x, y: c.y, draggable: true });

  // Box spans from the first line's ascent down past the last line's descent.
  const box = {
    x: -pad,
    y: -met.ascent - pad,
    width: met.maxW + pad * 2,
    height: met.ascent + met.descent + (lines.length - 1) * px * LINE_H + pad * 2
  };

  if (st.fill !== 'none') g.add(new Konva.Rect({ ...box, fill: st.fill }));

  // Invisible hit target — a Shape's sceneFunc gives Konva nothing to hit-test.
  g.add(new Konva.Rect({ ...box, fill: 'rgba(0,0,0,0.001)' }));

  g.add(textShape(lines, st, px, st.stroke));

  // Dashed box marks selection, so the real colour stays visible while editing it.
  if (isSel(t.id)) {
    g.add(new Konva.Rect({ ...box, stroke: SEL, strokeWidth: 1, dash: [4, 3], listening: false }));
  }

  wireCommon(g, t);
  g.on('dragmove', () => {
    const p = canvasToPdf(g.x(), g.y());
    t.x = p.x; t.y = p.y;
    showPdf(p);
  });
  g.on('dragend', () => { if (!isSel(t.id)) selectOnly(t.id); commitStage(); });
  return g;
}

// Small square grip. `commit` receives the new position in PDF points.
function handle(pos, commit, onEnd) {
  const size = 8;
  const h = new Konva.Rect({
    x: pos.x, y: pos.y, width: size, height: size,
    offsetX: size / 2, offsetY: size / 2,
    fill: '#ffffff', stroke: SEL, strokeWidth: 1.5, draggable: true
  });
  h.on('mousedown', e => { e.cancelBubble = true; });
  h.on('click', e => { e.cancelBubble = true; });
  h.on('dragstart', () => pushHistory());
  h.on('dragmove', () => { commit(canvasToPdf(h.x(), h.y())); syncLive(); });
  h.on('dragend', () => { onEnd?.(); commitStage(); });
  h.on('mouseenter', () => { stage.container().style.cursor = 'pointer'; });
  h.on('mouseleave', () => { stage.container().style.cursor = cursorForTool(); });
  return h;
}

// Cheap live redraw while dragging a grip: update geometry without rebuilding.
function syncLive() {
  const s = selected();
  if (!s) return;
  if (s.type === 'bubble' && s.leader) {
    const line = shapeLayer.findOne(`.leader-${s.id}`);
    const c = pdfToCanvas(s.x, s.y), t = pdfToCanvas(s.leader.toX, s.leader.toY);
    if (line) line.points([c.x, c.y, t.x, t.y]);
  } else if (s.type === 'line') {
    const node = shapeLayer.findOne(n => n.getClassName() === 'Line' && n.draggable());
    const a = pdfToCanvas(s.x1, s.y1), b = pdfToCanvas(s.x2, s.y2);
    if (node) { node.x(a.x); node.y(a.y); node.points([0, 0, b.x - a.x, b.y - a.y]); }
  }
  shapeLayer.batchDraw();
}

function attachTransformer(r) {
  const node = shapeLayer.findOne(`.rect-${r.id}`);
  if (!node) return;
  transformer = new Konva.Transformer({
    nodes: [node],
    rotateEnabled: false,          // rotation would need a matrix on export too
    keepRatio: false,
    borderStroke: SEL,
    anchorStroke: SEL,
    anchorSize: 8,
    boundBoxFunc: (oldBox, newBox) =>
      (newBox.width < 6 || newBox.height < 6) ? oldBox : newBox
  });
  shapeLayer.add(transformer);
}

// ---------------------------------------------------------------------------
// Middle-button pan
//
// Replaces the browser's autoscroll on any scroller. `restoreCursor` is for
// surfaces that own their cursor and need it put back.
// ---------------------------------------------------------------------------
function enablePan(el, restoreCursor) {
  if (!el) return;
  let pan = null;

  // On `window` for the duration: a pan that runs past the edge still tracks,
  // and its mouseup usually lands elsewhere.
  const move = e => {
    if (!pan) return;
    el.scrollLeft = pan.left - (e.clientX - pan.x);
    el.scrollTop = pan.top - (e.clientY - pan.y);
  };

  const end = () => {
    if (!pan) return;
    pan = null;
    el.style.cursor = '';
    restoreCursor?.();
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', end);
  };

  el.addEventListener('mousedown', e => {
    if (e.button !== 1) return;
    // Chromium arms autoscroll on mousedown, so it's stopped here, not on click.
    e.preventDefault();
    pan = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.style.cursor = 'grabbing';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
  });

  // Alt-tabbing mid-pan never delivers the mouseup.
  window.addEventListener('blur', end);
}

// The preview panes. #viewport is wired in initStage(), #libScroll from
// library.js.
['prevScroll', 'shPrevScroll', 'inspPrevScroll'].forEach(id => enablePan($(id)));

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------
// Keeps the middle of the pane still across a zoom, or the point under the
// cursor during a Ctrl+scroll. Call before the content resizes; it returns a
// restore to run after, which an async caller holds until its render settles.
// Measured with getBoundingClientRect(), since the zoom surfaces share no scale
// (canvas re-render vs CSS zoom). Hidden or empty content returns a no-op. The
// fraction is not clamped to 0..1 on purpose; scrollLeft/Top clamp anyway.
function holdCentre(scroller, content) {
  const before = content?.getBoundingClientRect();
  if (!scroller || !before?.width || !before?.height) return () => {};
  const s = scroller.getBoundingClientRect();
  const at = zoomAnchor?.scroller === scroller ? zoomAnchor : null;
  const ax = at ? at.x - s.left : scroller.clientWidth / 2;
  const ay = at ? at.y - s.top : scroller.clientHeight / 2;
  const fx = (s.left + ax - before.left) / before.width;
  const fy = (s.top + ay - before.top) / before.height;
  return () => {
    const after = content.getBoundingClientRect();
    if (!after.width || !after.height) return;
    const now = scroller.getBoundingClientRect();
    scroller.scrollLeft += after.left + fx * after.width - (now.left + ax);
    scroller.scrollTop += after.top + fy * after.height - (now.top + ay);
  };
}

// Ctrl+scroll zoom. Moves the pane's own slider and fires its `input`, so the
// wheel shares the slider's zoom path. zoomAnchor is set only during that
// dispatch, where holdCentre() reads it synchronously. Multiplicative, from a
// float kept on the slider (`_wz`), so trackpad deltas accumulate instead of
// rounding back to the step. Needs passive:false, or preventDefault() is ignored.
let zoomAnchor = null;
function wheelZoom(scroller, slider) {
  if (!scroller || !slider) return;
  scroller.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (slider.disabled) return;
    const min = +slider.min, max = +slider.max, step = +slider.step || 1;
    const cur = +slider.value;
    if (slider._wz == null || Math.abs(slider._wz - cur) >= step) slider._wz = cur;
    const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    slider._wz = Math.min(max, Math.max(min, slider._wz * Math.exp(-px * 0.0015)));
    const snapped = Math.min(max, Math.max(min, Math.round(slider._wz / step) * step));
    if (snapped === cur) return;
    zoomAnchor = { scroller, x: e.clientX, y: e.clientY };
    slider.value = snapped;
    try { slider.dispatchEvent(new Event('input', { bubbles: true })); }
    finally { zoomAnchor = null; }
  }, { passive: false });
}
wheelZoom($('viewport'), $('zoomSlider'));
wheelZoom($('prevScroll'), $('prevZoom'));
wheelZoom($('shPrevScroll'), $('shZoom'));
wheelZoom($('inspPrevScroll'), $('inspZoom'));

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------
function initStage() {
  stage = new Konva.Stage({ container: 'annoLayer', width: 10, height: 10 });
  shapeLayer = new Konva.Layer();
  ghostLayer = new Konva.Layer({ listening: false });
  stage.add(shapeLayer, ghostLayer);

  // Konva drags on left AND middle by default. Right sweeps, middle pans.
  Konva.dragButtons = [0];
  stage.container().addEventListener('contextmenu', e => e.preventDefault());

  // The canvas pans too, handing its cursor back to the active tool after.
  enablePan($('viewport'), () => {
    stage.container().style.cursor = cursorForTool();
  });

  stage.on('mousedown', e => {
    if (!viewport) return;
    // The middle button belongs to the pan and must not reach the tools.
    if (e.evt.button === 1) return;
    // Right-drag borrows the select tool and sweeps, from any tool. Checked
    // before the e.target test: a sweep that begins over a shape is still a sweep.
    if (e.evt.button === 2) {
      borrowTool('select', 'rmb');
      if (!e.evt.shiftKey && selCount()) { clearSel(); syncStage(); }
      marquee = { a: pointer(), b: pointer(), add: !!e.evt.shiftKey };
      return;
    }
    if (e.target !== stage) return;                // a shape handled it
    if (tool === 'select') {
      // Shift adds to the selection.
      if (!e.evt.shiftKey && selCount()) { clearSel(); syncStage(); }
      marquee = { a: pointer(), b: pointer(), add: !!e.evt.shiftKey };
      return;
    }
    if (selCount()) { clearSel(); syncStage(); }
    creating = pointer();
  });

  stage.on('mousemove', () => {
    if (!viewport) return;
    const p = pointer();
    showPdf(p);
    if (creating) drawGhost(p);
    if (marquee) { marquee.b = p; drawMarquee(); }
  });

  stage.on('mouseup', () => {
    if (marquee) {
      const m = marquee;
      marquee = null;
      ghostLayer.destroyChildren();
      ghostLayer.draw();
      commitMarquee(m);
      returnTool('rmb');            // no-op unless the right button opened it
      return;
    }
    if (!creating || !viewport) return;
    const p = pointer();
    // Snapshot BEFORE commitCreate(): it spends nextNumber and uid, so a later
    // snapshot would undo to a count one past the removed bubble.
    const before = snapshot();
    const el = commitCreate(creating, p);
    creating = null;
    ghostLayer.destroyChildren();
    ghostLayer.draw();
    // Only new text is selected, and focused for typing.
    if (el) {
      pushHistory(before);
      elements.push(el);
      if (el.type === 'text') selectOnly(el.id);
      markDirty();          // only if something was actually drawn
    }
    syncStage();
    if (el && el.type === 'text') { pText.focus(); pText.select(); }
  });
}

function commitCreate(a, b) {
  const style = { ...defaults[tool] };
  const dist = Math.hypot(b.x - a.x, b.y - a.y);

  if (tool === 'bubble') {
    return {
      id: `el_${uid++}`, type: 'bubble', documentId: activeDocId,
      pdfPage: pageIndex, n: nextNumber++,   // plain increment; edit the field to rebase it
      x: b.x, y: b.y,
      leader: dist > DEADZONE ? { toX: a.x, toY: a.y } : null,
      style,
      char: { dimension: '',
              gdt: emptyGdt(), alternateUnit: altUnit(), method: '', notes: '', subs: [] }
    };
  }
  if (tool === 'refbubble') {
    // No leader. Its number is refNumber, which selecting a balloon sets.
    return {
      id: `el_${uid++}`, type: 'refbubble', documentId: activeDocId,
      pdfPage: pageIndex, n: refNumber,      // borrowed, never incremented
      x: b.x, y: b.y, style
    };
  }
  if (tool === 'rect') {
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (w < MIN_SIZE || h < MIN_SIZE) return null;
    return {
      id: `el_${uid++}`, type: 'rect', documentId: activeDocId, pdfPage: pageIndex,
      x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w, h, style
    };
  }
  if (tool === 'line') {
    if (dist < MIN_SIZE) return null;
    return {
      id: `el_${uid++}`, type: 'line', documentId: activeDocId, pdfPage: pageIndex,
      x1: a.x, y1: a.y, x2: b.x, y2: b.y, style
    };
  }
  if (tool === 'text') {
    const { defaultText, ...textStyle } = style;   // content isn't styling
    return {
      id: `el_${uid++}`, type: 'text', documentId: activeDocId, pdfPage: pageIndex,
      x: a.x, y: a.y, text: defaultText ?? DEFAULT_TEXT, style: textStyle
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Marquee
//
// A sweep with the select tool. An element counts if its box TOUCHES the
// marquee; it doesn't have to be contained.
// ---------------------------------------------------------------------------
let marquee = null;

function drawMarquee() {
  ghostLayer.destroyChildren();
  const a = pdfToCanvas(marquee.a.x, marquee.a.y);
  const b = pdfToCanvas(marquee.b.x, marquee.b.y);
  ghostLayer.add(new Konva.Rect({
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
    stroke: SEL, strokeWidth: 1, dash: [4, 3],
    fill: 'rgba(45,125,210,0.10)', listening: false
  }));
  ghostLayer.draw();
}

// PDF-space box for hit testing. Text has no measurable width here, so its
// anchor point stands in.
function elBox(el) {
  if (isBalloon(el)) {
    const r = radiusOf(el);
    return { x1: el.x - r, y1: el.y - r, x2: el.x + r, y2: el.y + r };
  }
  if (el.type === 'rect') {
    return { x1: el.x, y1: el.y, x2: el.x + el.w, y2: el.y + el.h };
  }
  if (el.type === 'line') {
    return { x1: Math.min(el.x1, el.x2), y1: Math.min(el.y1, el.y2),
             x2: Math.max(el.x1, el.x2), y2: Math.max(el.y1, el.y2) };
  }
  return { x1: el.x, y1: el.y, x2: el.x, y2: el.y };
}

function commitMarquee(m) {
  const x1 = Math.min(m.a.x, m.b.x), x2 = Math.max(m.a.x, m.b.x);
  const y1 = Math.min(m.a.y, m.b.y), y2 = Math.max(m.a.y, m.b.y);
  // A click, not a sweep: the mousedown already cleared the selection.
  if (x2 - x1 < 1 && y2 - y1 < 1) { syncStage(); return; }

  if (!m.add) clearSel();
  for (const el of elements) {
    if (el.documentId !== activeDocId || el.pdfPage !== pageIndex) continue;
    const b = elBox(el);
    if (b.x1 <= x2 && b.x2 >= x1 && b.y1 <= y2 && b.y2 >= y1) selIds.add(el.id);
  }
  syncStage();
}

function pointer() {
  const pos = stage.getPointerPosition();
  return canvasToPdf(pos.x, pos.y);
}

function drawGhost(p) {
  ghostLayer.destroyChildren();
  const d = defaults[tool];
  const common = { stroke: d.stroke, strokeWidth: d.strokeWidth * scale, opacity: 0.55 };
  const ghostFill = d.fill === 'none' ? undefined : d.fill;

  if (tool === 'refbubble') {
    const c = pdfToCanvas(p.x, p.y);
    const gr = d.radius ?? BUBBLE_R;
    ghostLayer.add(new Konva.Circle({
      x: c.x, y: c.y, radius: gr * scale, fill: ghostFill,
      stroke: d.stroke, strokeWidth: bubbleStroke(gr) * scale, opacity: 0.55,
      dash: refDash(gr)
    }));
  } else if (tool === 'bubble') {
    const c = pdfToCanvas(p.x, p.y);
    if (Math.hypot(p.x - creating.x, p.y - creating.y) > DEADZONE) {
      const t = pdfToCanvas(creating.x, creating.y);
      ghostLayer.add(new Konva.Line({ points: [c.x, c.y, t.x, t.y], ...common }));
    }
    const gr = d.radius ?? BUBBLE_R;
    ghostLayer.add(new Konva.Circle({
      x: c.x, y: c.y, radius: gr * scale, fill: ghostFill,
      stroke: d.stroke, strokeWidth: bubbleStroke(gr) * scale, opacity: 0.55
    }));
  } else if (tool === 'rect') {
    const box = rectToCanvas({
      x: Math.min(creating.x, p.x), y: Math.min(creating.y, p.y),
      w: Math.abs(p.x - creating.x), h: Math.abs(p.y - creating.y)
    });
    ghostLayer.add(new Konva.Rect({ ...box, fill: ghostFill, ...common }));
  } else if (tool === 'line') {
    const a = pdfToCanvas(creating.x, creating.y), b = pdfToCanvas(p.x, p.y);
    ghostLayer.add(new Konva.Line({ points: [a.x, a.y, b.x, b.y], ...common }));
  } else if (tool === 'text') {
    const a = pdfToCanvas(creating.x, creating.y);
    const s = textShape([d.defaultText || DEFAULT_TEXT], d, d.fontSize * scale, d.stroke, 0.55);
    s.position({ x: a.x, y: a.y });
    ghostLayer.add(s);
  }
  ghostLayer.draw();
}

// ---------------------------------------------------------------------------
// Toolbox + Editor
// ---------------------------------------------------------------------------
const HINTS = {
  select: 'Click a shape to select. Drag to move.',
  bubble: 'Click to place. Drag out to add a leader.',
  rect: 'Drag to draw. Select for resize handles.',
  line: 'Drag to draw. Select to move either end.',
  text: 'Click to place, then type in the Editor below.'
};

function cursorForTool() { return tool === 'select' ? 'default' : 'crosshair'; }

document.querySelectorAll('.tool').forEach(btn => {
  btn.onclick = () => {
    tool = btn.dataset.tool;
    document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('defToolLabel').title = HINTS[tool];
    if (stage) stage.container().style.cursor = cursorForTool();
    syncDefaultsStrip();   // the strip shows what THIS tool creates, never the selection
  };
});

// ---------------------------------------------------------------------------
// Object editor (right panel) — SELECTION ONLY. Never touches tool defaults.
// ---------------------------------------------------------------------------
const pNum = document.getElementById('pNum');
const pStroke = document.getElementById('pStroke');
const pWidth = document.getElementById('pWidth');
const pFill = document.getElementById('pFill');
const pNoFill = document.getElementById('pNoFill');
const pText = document.getElementById('pText');
const pSize = document.getElementById('pSize');
const fBold = document.getElementById('fBold');
const fItalic = document.getElementById('fItalic');
const fUnder = document.getElementById('fUnder');

// Document panel — plain two-way binding via data-doc attributes.
const docInputs = [...document.querySelectorAll('[data-doc]')];

function syncDocFields() {
  for (const el of docInputs) el.value = doc.part[el.dataset.doc] ?? '';
}
for (const el of docInputs) {
  el.addEventListener('input', () => { doc.part[el.dataset.doc] = el.value; });
}

// Panel rows are CSS grid; strip fields are flex, where toggling display would
// stack the label over its input, so the strip uses [hidden].
const show = (id, on) => { document.getElementById(id).style.display = on ? 'grid' : 'none'; };
const showField = (id, on) => { document.getElementById(id).hidden = !on; };

// A group shows a value only where every member agrees, and blank where they
// differ. A colour input can't be blank, so colours show the first member's.
const agreed = (els, pick) => {
  const first = pick(els[0]);
  return els.every(e => pick(e) === first) ? first : null;
};

// Fills the object editor from the selection. Runs at the end of every
// syncStage().
function syncEditor() {
  const els = selectedEls();
  const s = selected();
  if (!els.length) {
    $('noSel').textContent = 'Select an element to edit it here.';
    $('noSel').style.display = 'block';
    $('editorFields').hidden = true;
    return;
  }
  const many = els.length > 1;
  $('noSel').style.display = 'none';
  $('editorFields').hidden = false;

  const allText = els.every(e => e.type === 'text');
  const allBalloon = els.every(isBalloon);
  const allRef = els.every(e => e.type === 'refbubble');
  const allPlain = els.every(e => !isBalloon(e) && e.type !== 'text');
  const src = els[0].style;

  // Selecting a balloon arms the reference tool with its number. It has to
  // happen here: the canvas mousedown clears the selection before
  // commitCreate() could read it.
  if (s && isBalloon(s)) {
    refNumber = s.n;
    if (tool === 'refbubble') syncDefaultsStrip();
  }

  show('rowNum', allBalloon && (!many || allRef));
  show('rowText', allText);
  show('rowFont', allText || allBalloon);        // "size" must mean one thing
  show('rowFmt', allText);
  show('rowWidth', allPlain);                    // a balloon's is derived from radius
  $('lblStroke').textContent = allText ? 'Colour' : 'Border';
  $('lblFill').textContent = allText ? 'Background' : 'Fill';
  $('lblSize').textContent = allBalloon ? 'Bubble size' : 'Text size (pt)';

  const put = (input, v) => {
    if (document.activeElement === input) return;   // never fight the typist
    input.value = v == null ? '' : v;
  };

  if (allBalloon) put(pNum, agreed(els, e => e.n));
  if (allText) put(pText, agreed(els, e => e.text));
  if (allBalloon) put(pSize, agreed(els, e => e.style.radius ?? BUBBLE_R));
  if (allText) {
    put(pSize, agreed(els, e => e.style.fontSize));
    // A format button shows on only when every member has it.
    fBold.classList.toggle('active', els.every(e => e.style.bold));
    fItalic.classList.toggle('active', els.every(e => e.style.italic));
    fUnder.classList.toggle('active', els.every(e => e.style.underline));
  }

  pStroke.value = agreed(els, e => e.style.stroke) ?? src.stroke;
  put(pWidth, agreed(els, e => e.style.strokeWidth));
  const fill = agreed(els, e => e.style.fill);
  pNoFill.checked = fill === 'none';
  pNoFill.indeterminate = fill == null;          // some filled, some not
  pFill.disabled = fill === 'none';
  if (fill && fill !== 'none') pFill.value = fill;
  else if (src.fill !== 'none') pFill.value = src.fill;
}

// Applies a style patch to every selected element.
function applyStyle(patch) {
  const els = selectedEls();
  if (!els.length) return;
  if (patch.radius != null) patch = { ...patch, strokeWidth: bubbleStroke(patch.radius) };
  for (const e of els) {
    // Each member takes only the keys that apply to its type.
    const p = { ...patch };
    if (p.radius != null && !isBalloon(e)) { delete p.radius; delete p.strokeWidth; }
    if (p.fontSize != null && e.type !== 'text') delete p.fontSize;
    if (Object.keys(p).length) Object.assign(e.style, p);
  }
  commitStage();
}

// One undo step per control per edit. A colour picker fires `input`
// continuously while dragging.
[pStroke, pWidth, pFill, pNum, pText, pSize].forEach(el => {
  const hk = nextBurstKey();          // per control: adjusting width then colour is two edits
  el.addEventListener('input', () => { if (selected()) historyBurst(hk); }, true);
  el.addEventListener('change', endBurst);
});
pNoFill.addEventListener('change', () => { if (selected()) pushHistory(); });

pStroke.oninput = () => applyStyle({ stroke: pStroke.value });
pWidth.oninput = () => applyStyle({ strokeWidth: Math.max(0.1, parseFloat(pWidth.value) || 0.1) });
pFill.oninput = () => applyStyle({ fill: pFill.value });
pNoFill.onchange = () => applyStyle({ fill: pNoFill.checked ? 'none' : pFill.value });

// A group can share a number only if all are reference bubbles; real bubbles
// must never share one.
pNum.oninput = () => {
  const els = selectedEls().filter(isBalloon);
  if (!els.length || (els.length > 1 && !els.every(e => e.type === 'refbubble'))) return;
  const v = Math.max(1, parseInt(pNum.value, 10) || 1);
  for (const e of els) e.n = v;
  commitStage();
};
pText.oninput = () => {
  const els = selectedEls().filter(e => e.type === 'text');
  if (!els.length) return;
  for (const e of els) e.text = pText.value;
  commitStage();
};
pSize.oninput = () => {
  const els = selectedEls();
  if (!els.length) return;
  const v = Math.max(1, parseFloat(pSize.value) || 1);
  // Shown only when the selection agrees on what "size" means.
  if (els.every(isBalloon)) applyStyle({ radius: v });
  else if (els.every(e => e.type === 'text')) applyStyle({ fontSize: v });
};

function toggleFmt(key) {
  const els = selectedEls().filter(e => e.type === 'text');
  if (!els.length) return;
  pushHistory();
  if (els.length > 1) {
    // Sets every member to one state; flipping each would leave a mixed group
    // mixed.
    const on = !els.every(e => e.style[key]);
    for (const e of els) e.style[key] = on;
    commitStage();
    return;
  }
  applyStyle({ [key]: !els[0].style[key] });
}
fBold.onclick = () => toggleFmt('bold');
fItalic.onclick = () => toggleFmt('italic');
fUnder.onclick = () => toggleFmt('underline');

// ---------------------------------------------------------------------------
// Tool defaults strip (under the toolbar) — what a tool creates NEXT.
// Fully independent from the object editor above; never reads a selection.
// ---------------------------------------------------------------------------
const dNum2 = $('dNum2'), dSize2 = $('dSize2'), dText2 = $('dText2'),
      dStroke2 = $('dStroke2'), dWidth2 = $('dWidth2'), dFill2 = $('dFill2'),
      dNoFill = $('dNoFill'), dBold = $('dBold'), dItalic = $('dItalic'), dUnder = $('dUnder');

const TOOL_LABEL = { select: 'SELECT — nothing to draw', bubble: 'BUBBLE',
                     refbubble: 'REFERENCE BUBBLE', rect: 'RECTANGLE',
                     line: 'LINE', text: 'TEXT' };

// Runs on every tool switch and every syncStage().
function syncDefaultsStrip() {
  // Select has nothing to configure, so the strip empties.
  if (tool === 'select') {
    $('defToolLabel').textContent = 'No tool active — click a shape to select it.';
    for (const id of ['dfNum', 'dfSize', 'dfText', 'dfFmt', 'dfDiv1',
                      'dfStroke', 'dfWidth', 'dfFill']) showField(id, false);
    return;
  }

  const t = tool;
  const d = defaults[t];
  $('defToolLabel').textContent = TOOL_LABEL[t];

  const isText = t === 'text';
  const isBubble = t === 'bubble' || t === 'refbubble';

  showField('dfNum', isBubble);
  showField('dfSize', isBubble || isText);
  showField('dfText', isText);
  showField('dfFmt', isText);
  showField('dfDiv1', true);
  showField('dfStroke', true);
  showField('dfWidth', !isText && !isBubble);
  showField('dfFill', true);

  $('dSizeLbl').textContent = isBubble ? 'Bubble size' : 'Text size';
  $('dStrokeLbl').textContent = isText ? 'Colour' : 'Border';
  $('dFillLbl').textContent = isText ? 'Background' : 'Fill';

  // A reference bubble's number doesn't advance, so it isn't labelled "Next #".
  $('dNumLbl').textContent = t === 'refbubble' ? 'Number' : 'Next #';
  if (document.activeElement !== dNum2) {
    dNum2.value = t === 'refbubble' ? refNumber : nextNumber;
  }
  if (document.activeElement !== dText2) dText2.value = d.defaultText ?? '';
  if (isBubble) dSize2.value = d.radius ?? BUBBLE_R;
  if (isText) {
    dSize2.value = d.fontSize;
    dBold.classList.toggle('active', !!d.bold);
    dItalic.classList.toggle('active', !!d.italic);
    dUnder.classList.toggle('active', !!d.underline);
  }
  dStroke2.value = d.stroke;
  dWidth2.value = d.strokeWidth;
  dNoFill.checked = d.fill === 'none';
  dFill2.disabled = d.fill === 'none';
  if (d.fill !== 'none') dFill2.value = d.fill;
}

function patchDefaults(patch) {
  if (patch.radius != null) patch = { ...patch, strokeWidth: bubbleStroke(patch.radius) };
  if (tool === 'select') return;
  Object.assign(defaults[tool], patch);
  // Sizes are stored on the active drawing, so they mark dirty. Colours stay
  // per-session.
  const d = activeDoc();
  const sized = SIZE_KEYS.filter(k => k in patch && k in BUILTIN_DEFAULTS[tool]);
  if (!d || !sized.length) return;
  d.defaults = d.defaults || {};
  d.defaults[tool] = { ...(d.defaults[tool] || {}),
                       ...Object.fromEntries(sized.map(k => [k, defaults[tool][k]])) };
  markDirty();
}

dNum2.oninput = () => {
  const v = Math.max(1, parseInt(dNum2.value, 10) || 1);
  if (tool === 'refbubble') refNumber = v; else nextNumber = v;
};
dSize2.oninput = () => {
  const v = Math.max(1, parseFloat(dSize2.value) || 1);
  if (tool === 'bubble' || tool === 'refbubble') patchDefaults({ radius: v });
  else patchDefaults({ fontSize: v });
};
dText2.oninput = () => { defaults.text.defaultText = dText2.value; };
dStroke2.oninput = () => patchDefaults({ stroke: dStroke2.value });
dWidth2.oninput = () => patchDefaults({ strokeWidth: Math.max(0.1, parseFloat(dWidth2.value) || 0.1) });
dFill2.oninput = () => patchDefaults({ fill: dFill2.value });
dNoFill.onchange = () => patchDefaults({ fill: dNoFill.checked ? 'none' : dFill2.value });
dBold.onclick = () => patchDefaults({ bold: !defaults.text.bold });
dItalic.onclick = () => patchDefaults({ italic: !defaults.text.italic });
dUnder.onclick = () => patchDefaults({ underline: !defaults.text.underline });

// ---------------------------------------------------------------------------
// Dimensions table
// ---------------------------------------------------------------------------
// Rows follow bubble order and edit the characteristic on each bubble directly;
// there is no separate row store.
// The unit the table edits in. The manifest stores inch as primary and mm as
// the alternate either way.
let dimUnit = 'in';

// The spec pair the table edits in the current unit. The alternate has the same
// { dimension, gdt } shape, so the editor takes either.
function unitView(c) {
  if (dimUnit === 'in') return c;
  c.alternateUnit = c.alternateUnit || altUnit();
  return c.alternateUnit;
}

// Per-unit placeholders.
const PH = {
  in: { dim: 'e.g. ⌀.2500 +.0005/-.0000' },
  mm: { dim: 'e.g. ⌀6.35 ±0.013' }
};
const ph = () => PH[dimUnit];

// Coerce before trimming: values may be numbers, and 0 is a real value.
const hasValue = v => v !== null && v !== undefined && String(v).trim() !== '';

// Counts as converted if any part of the alternate has been authored — a Lim or
// Max row has no dimension, so checking dimension alone would undercount.
function isConverted(c) {
  const a = c?.alternateUnit;
  if (!a) return 0;
  return (hasValue(a.dimension) || hasValue(gdtToText(a.gdt))) ? 1 : 0;
}

// The only setter for dimUnit. Runs from the unit toggle, applyManifest() and
// startup.
function setDimUnit(unit) {
  dimUnit = unit === 'mm' ? 'mm' : 'in';
  document.querySelectorAll('.unit-btn').forEach(b =>
    b.classList.toggle('on', b.dataset.unit === dimUnit));
  const table = $('dimTable');
  if (table) table.classList.toggle('mm', dimUnit === 'mm');
  const head = $('dimColHead');
  if (head) head.textContent = `Dimension & tolerance (${dimUnit === 'mm' ? 'mm' : 'inch'})`;
}

function bubbleChars() {
  return elements.filter(e => e.type === 'bubble').sort((a, b) => a.n - b.n);
}

function renderDimTable() {
  const body = $('dimBody');
  if (!body) return;
  closeSuggest();          // the input it was anchored to is about to be discarded
  body.innerHTML = '';
  const rows = bubbleChars();

  $('dimEmpty').hidden = rows.length > 0;
  const subs = rows.reduce((n, el) => n + (el.char?.subs?.length || 0), 0);
  let text = rows.length
    ? `${rows.length} characteristic${rows.length === 1 ? '' : 's'}` +
      (subs ? ` · ${subs} sub` : '')
    : '';
  // In mm the useful signal is how many alternates have actually been authored.
  if (rows.length && dimUnit === 'mm') {
    const total = rows.length + subs;
    const done = rows.reduce((n, el) =>
      n + isConverted(el.char) + (el.char?.subs || []).reduce((m, sd) => m + isConverted(sd), 0), 0);
    text += ` · ${done}/${total} converted`;
  }
  $('dimCount').textContent = text;

  for (const el of rows) {
    el.char = el.char || {};
    for (const tr of dimRows(el)) body.appendChild(tr);
  }
}

// A blank sub-characteristic: same shape as a main one, minus the bubble link.
function newSub() {
  return { dimension: '', gdt: emptyGdt(), alternateUnit: altUnit(),
           method: '', notes: '' };
}

// One characteristic's main row plus a row per sub. Columns: [+/−] [#] [editor]
// [method] [notes] [rendered]. The number cell spans them all, which pushes each
// sub-row's first cell into the action column, so + and − line up.
function dimRows(el) {
  const c = el.char;
  c.subs = c.subs || [];
  const out = [];

  const main = document.createElement('tr');
  main.className = 'main-row';
  main.dataset.elId = el.id;          // Auto-Find reads this off the focused row

  main.appendChild(actionCell('+', 'Add sub-characteristic', () => {
    pushHistory();
    c.subs.push(newSub());
    markDirty();
    renderDimTable();
  }));

  const numTd = document.createElement('td');
  numTd.className = 'num-cell';
  numTd.dataset.col = 'num';
  numTd.textContent = el.n;
  numTd.title = `Bubble ${el.n}`;
  numTd.rowSpan = 1 + c.subs.length;
  main.appendChild(numTd);

  appendEditCells(main, unitView(c));
  out.push(main);

  c.subs.forEach((sub, i) => {
    const tr = document.createElement('tr');
    tr.className = 'sub-row';
    tr.dataset.elId = el.id;          // a sub belongs to its parent's bubble
    tr.appendChild(actionCell('\u2212', 'Remove this sub-characteristic', () => {
      pushHistory();
      c.subs.splice(i, 1);
      markDirty();
      renderDimTable();
    }));
    appendEditCells(tr, unitView(sub));
    out.push(tr);
  });

  return out;
}

// The four cells main and sub rows share. The rendered cell is built first so
// the editor can repaint it, but appended last.
function appendEditCells(tr, c) {
  const render = renderCell();
  tr.appendChild(tolCell(c, render.preview));
  tr.appendChild(plainCell(c, 'method', 'method', 'e.g. calipers', METHOD_LIST));
  tr.appendChild(notesCell(c, render.preview));
  tr.appendChild(render.td);
}

// A narrow leading column holding one button.
function actionCell(glyph, title, onClick) {
  const td = document.createElement('td');
  td.className = 'act-cell';
  td.dataset.col = 'act';
  const btn = document.createElement('button');
  btn.className = 'sub-btn';
  btn.textContent = glyph;
  btn.title = title;
  btn.tabIndex = -1;              // mouse target; keep it out of the field-to-field flow
  btn.onclick = onClick;
  td.appendChild(btn);
  return td;
}

function renderCell() {
  const td = document.createElement('td');
  td.className = 'render';
  td.dataset.col = 'render';
  const preview = document.createElement('div');
  preview.className = 'spec-render';
  td.appendChild(preview);
  return { td, preview };
}

// Inserts at the caret of the table field focused last. Runs from the symbol
// palette left of the unit toggle.
function insertSymbol(fontChar) {
  const i = lastDimInput;
  if (!i || !document.body.contains(i)) {
    notify('Nothing selected', 'Click into a field first, then pick a symbol.');
    return;
  }
  insertAtCaret(i, fontChar);
}

// Inserts as if typed. execCommand('insertText') joins the field's native undo
// and fires a real `input`, so the field's commit path (historyBurst included)
// runs; assigning `input.value` would wipe the field's undo. Deprecated, but
// still the only API that does this; the fallback covers its removal.
function insertAtCaret(input, text) {
  input.focus();
  const a = input.selectionStart ?? input.value.length;
  const b = input.selectionEnd ?? a;
  input.setSelectionRange(a, b);
  if (!document.execCommand('insertText', false, text)) {
    input.setRangeText(text, a, b, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

$('symMenu').onclick = () => {
  const sections = [['Common', SYM_COMMON], ['Characteristics', GDT_SYMBOLS],
                    ['Modifiers', GDT_MODS]];
  popupSections($('symMenu'), sections, 'sym', null, ([, fch]) => insertSymbol(fch));
};

document.querySelectorAll('.unit-btn').forEach(btn => {
  btn.onclick = () => {
    if (dimUnit === btn.dataset.unit) return;
    setDimUnit(btn.dataset.unit);
    markDirty();          // the package records the unit it was last edited in
    renderDimTable();
  };
});

function tolCell(c, preview) {
  const td = document.createElement('td');
  td.dataset.col = 'tol';
  td.appendChild(tolEditor(c, preview));
  return td;
}

function plainCell(c, col, field, placeholder, suggest) {
  const td = document.createElement('td');
  td.className = col;
  td.dataset.col = col;
  const input = textInput(c[field], v => { c[field] = v; markDirty(); }, placeholder);
  if (suggest?.length) attachSuggest(input, suggest);
  td.appendChild(input);
  return td;
}

// Notes are appended to the rendered callout, so editing them repaints the
// last cell of the same row.
function notesCell(c, preview) {
  const td = document.createElement('td');
  td.className = 'notes';
  td.dataset.col = 'notes';
  td.appendChild(textInput(c.notes, v => {
    c.notes = v;
    paintSpec(preview, c);
    markDirty();
  }, ''));
  return td;
}

// The only writer of the rendered cell. toFont() here and nowhere upstream: the
// callout is stored as Unicode.
function paintSpec(preview, c) {
  if (!preview) return;
  const txt = toFont(renderSpec(c));
  preview.textContent = txt || '\u2014';
  preview.classList.toggle('empty', !txt);
}

// ---------------------------------------------------------------------------
// GD&T
//
// The symbol font isn't Unicode-mapped: its symbols sit in punctuation slots
// (position is '#', not U+2316). Everything is stored as Unicode and converted
// to font slots only for display.
// ---------------------------------------------------------------------------
// Symbol rows from assets/symbols.json, as [key, fontSlot, unicode, label].
const symRows = g => (SYMBOLS.groups[g] || []).map(s => [s.key, s.slot, s.unicode, s.label]);
const SYM_COMMON  = symRows('common');
const GDT_SYMBOLS = symRows('gdt');
const GDT_MODS    = symRows('modifiers');

const ALL_SYMS = [...SYM_COMMON, ...GDT_SYMBOLS, ...GDT_MODS];
// _GLYPH = font slot, for text about to be shown in the symbol font.
// _UNI   = codepoint, for anything that gets stored. Storage is always Unicode.
const GDT_SYM_GLYPH = Object.fromEntries(GDT_SYMBOLS.map(([k, f]) => [k, f]));
const GDT_MOD_GLYPH = Object.fromEntries(GDT_MODS.map(([k, f]) => [k, f]));
const GDT_SYM_UNI = Object.fromEntries(GDT_SYMBOLS.map(([k, , u]) => [k, u]));
const GDT_MOD_UNI = Object.fromEntries(GDT_MODS.map(([k, , u]) => [k, u]));

// Unicode <-> font-slot translation. Built once; first definition of a codepoint
// wins so the duplicate diameter entry can't shadow itself.
const UNI_TO_FONT = {};
const FONT_TO_UNI = {};
for (const [, fch, uni] of ALL_SYMS) {
  if (!(uni in UNI_TO_FONT)) UNI_TO_FONT[uni] = fch;
  if (!(fch in FONT_TO_UNI)) FONT_TO_UNI[fch] = uni;
}

// Stored Unicode to display font slots, and back.
const toFont = t => [...String(t || '')].map(c => UNI_TO_FONT[c] || c).join('');
const toUni  = t => [...String(t || '')].map(c => FONT_TO_UNI[c] || c).join('');

const emptyGdt = () => ({ symbol: null, diametral: false, tolerance: '', datums: '' });

// A frame's rendered text, in UNICODE, for the preview, sheets and PDF export.
// Whoever displays it calls toFont().
function gdtToText(g) {
  if (!g || typeof g !== 'object') return '';
  const parts = [];
  if (g.symbol && GDT_SYM_UNI[g.symbol]) parts.push(GDT_SYM_UNI[g.symbol]);
  const tol = (g.diametral ? GDT_MOD_UNI.DIAMETER : '') + (g.tolerance || '');
  if (tol) parts.push(tol);
  const d = g.datums || '';
  if (d) parts.push(d);
  if (!parts.length) return '';
  // Pipes stand in for the compartment dividers of a real feature control frame.
  return '| ' + parts.join(' | ') + ' |';
}

const UNI_TO_MOD = Object.fromEntries(GDT_MODS.map(([k, , u]) => [u, k]));

// Datums are typed freely but stored parseably: letters start a datum, a modifier
// character attaches to the one before it, so "A\u24C2B" reads as A(M), B.
function parseDatums(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/([A-Za-z]+(?:-[A-Za-z]+)*)|(.)/g)) {
    if (m[1]) out.push({ letter: m[1].toUpperCase(), modifier: null });
    else if (UNI_TO_MOD[m[2]] && out.length) out[out.length - 1].modifier = UNI_TO_MOD[m[2]];
  }
  return out;
}

// The dimension cell's editor: a free-text callout, or a toggle into the frame
// builder. Repaints the row's rendered cell (`preview`) directly.
function tolEditor(c, preview) {
  const row = document.createElement('div');
  row.className = 'tol-inputs';

  const refresh = () => {
    paintSpec(preview, c);
    markDirty();
  };

  const isGdt = () => !!(c.gdt && typeof c.gdt === 'object' && c.gdt.symbol);

  const build = () => {
    row.innerHTML = '';

    // Text, not a glyph: it picks the kind of row, and a symbol would read as a
    // frame control.
    const toggle = document.createElement('button');
    toggle.className = 'mode-btn' + (isGdt() ? ' on' : '');
    toggle.textContent = 'GD&T';
    toggle.title = isGdt() ? 'Back to a text dimension' : 'Build a feature control frame';
    toggle.tabIndex = -1;
    toggle.onclick = () => {
      pushHistory();
      if (isGdt()) c.gdt = emptyGdt();               // back to plain text
      else c.gdt = { ...emptyGdt(), symbol: 'position' };
      build();
      refresh();
    };
    row.appendChild(toggle);
    row.appendChild(el('span', 'mode-split'));   // marks where the callout starts

    if (isGdt()) {
      row.appendChild(gdtBuilder(c, refresh));
    } else {
      const d = textInput(c.dimension ?? '', v => { c.dimension = v; refresh(); }, ph().dim);
      d.className = 'symtext dim wide';
      row.appendChild(d);
    }
  };

  build();
  // Paint, but do NOT refresh(): building a row is rendering, not editing, and
  // refresh() marks the package dirty.
  paintSpec(preview, c);
  return row;
}

// A characteristic's rendered callout, in UNICODE, for the preview, sheets and
// PDF export. It feeds frozen inspection rows, so it must never font-encode: a
// record in font slots is undecodable once the face changes.
function renderSpec(c) {
  if (!c) return '';
  const spec = (c.gdt && c.gdt.symbol) ? gdtToText(c.gdt) : (c.dimension || '');
  return [spec, c.notes || ''].filter(Boolean).join(' ');
}

// Feature control frame builder, rendered inline in the control row. The cell
// owns the rendered preview, so this only reports changes upward.
function gdtBuilder(c, parentRefresh) {
  if (typeof c.gdt === 'string') c.gdt = { ...emptyGdt(), tolerance: c.gdt };
  if (!c.gdt || typeof c.gdt !== 'object') c.gdt = emptyGdt();
  const g = c.gdt;

  const row = document.createElement('span');
  row.className = 'gdt-build';
  const refresh = () => parentRefresh();

  const sym = document.createElement('button');
  sym.className = 'seg-btn sym-btn';
  sym.tabIndex = -1;
  const paintSym = () => {
    // Unset shows position dimmed; '?' would render as the projected tolerance
    // glyph and read as a real selection.
    sym.textContent = g.symbol ? GDT_SYM_GLYPH[g.symbol] : GDT_SYM_GLYPH.position;
    sym.classList.toggle('set', !!g.symbol);
    sym.classList.toggle('unset', !g.symbol);
    sym.title = g.symbol
      ? (GDT_SYMBOLS.find(x => x[0] === g.symbol) || [, , , ''])[3]
      : 'Choose characteristic';
  };
  sym.onclick = () => popupGrid(sym, 'Characteristic', 'sym', GDT_SYMBOLS, g.symbol,
    key => { pushHistory(); g.symbol = key; paintSym(); refresh(); },
    () => { pushHistory(); g.symbol = null; paintSym(); refresh(); });
  paintSym();
  row.appendChild(sym);

  const dia = document.createElement('button');
  dia.className = 'seg-btn dia-btn';
  dia.textContent = GDT_MOD_GLYPH.DIAMETER;
  dia.title = 'Diametral tolerance zone';
  dia.tabIndex = -1;
  const paintDia = () => dia.classList.toggle('on', !!g.diametral);
  dia.onclick = () => { pushHistory(); g.diametral = !g.diametral; paintDia(); refresh(); };
  paintDia();
  row.appendChild(dia);

  row.appendChild(glyphInput('gval', g, 'tolerance', '.010', refresh));
  row.appendChild(addModBtn(g, 'tolerance', refresh));
  row.appendChild(glyphInput('gdatum', g, 'datums', 'A B C', refresh));
  row.appendChild(addModBtn(g, 'datums', refresh));
  return row;
}

// Displays font glyphs, stores Unicode.
function glyphInput(cls, g, field, placeholder, refresh) {
  const i = document.createElement('input');
  i.type = 'text';
  i.className = 'symtext ' + cls;
  i.placeholder = placeholder;
  i.value = toFont(g[field]);
  i.dataset.field = field;
  const hk = nextBurstKey();
  i.oninput = () => { historyBurst(hk); g[field] = toUni(i.value); refresh(); };
  guardKeys(i);
  trackFocus(i);
  return i;
}

function addModBtn(g, field, refresh) {
  const b = document.createElement('button');
  b.className = 'add-btn';
  b.textContent = '+';
  b.title = 'Insert material condition';
  b.tabIndex = -1;
  b.onclick = () => popupGrid(b, 'Modifier', 'mod', GDT_MODS, null, key => {
    const input = b.parentElement.querySelector(`input[data-field="${field}"]`);
    const glyph = GDT_MOD_GLYPH[key];
    // Through the field, as if typed, so its oninput commits and opens a history
    // burst.
    if (input) {
      insertAtCaret(input, glyph);
    } else {
      pushHistory();
      g[field] = (g[field] || '') + (FONT_TO_UNI[GDT_MOD_GLYPH[key]] || '');
      refresh();
    }
  });
  return b;
}

let openPop = null;
// The shared symbol popup. `sections` is [[title, items], ...], items are
// [key, glyph, _, label]; popupGrid() is the single-section shorthand. `kind` is
// a CSS class: 'list' is the text one, the rest draw symbol tiles. Closes on
// outside click, Escape or scroll.
function popupSections(anchorEl, sections, kind, current, onPick, onClear) {
  closePop();
  const pop = document.createElement('div');
  pop.className = 'gpop';

  sections.forEach(([title, items]) => {
    if (title) {
      const h = document.createElement('p');
      h.className = 'ttl';
      h.textContent = title;
      pop.appendChild(h);
    }
    const grid = document.createElement('div');
    grid.className = 'grid ' + kind;
    items.forEach(item => {
      const cell = document.createElement('div');
      cell.className = 'cell' + (item[0] === current ? ' on' : '');
      cell.textContent = item[1];
      cell.title = item[3];
      cell.onclick = () => { onPick(item); closePop(); };
      grid.appendChild(cell);
    });
    pop.appendChild(grid);
  });

  if (onClear) {
    const clr = document.createElement('button');
    clr.className = 'clear';
    clr.textContent = 'Clear';
    clr.onclick = () => { onClear(); closePop(); };
    pop.appendChild(clr);
  }

  document.body.appendChild(pop);
  const r = anchorEl.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let top = r.bottom + 4;
  if (top + pr.height > innerHeight - 8) top = Math.max(8, r.top - pr.height - 4);
  let left = r.left;
  if (left + pr.width > innerWidth - 8) left = Math.max(8, innerWidth - pr.width - 8);
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;

  openPop = pop;
  setTimeout(() => {
    document.addEventListener('mousedown', outsidePop, true);
    document.addEventListener('keydown', escPop, true);
    window.addEventListener('scroll', closePop, true);
  }, 0);
}
const popupGrid = (anchorEl, title, kind, items, current, onPick, onClear) =>
  popupSections(anchorEl, [[title, items]], kind, current,
                item => onPick(item[0]), onClear);

function closePop() {
  if (!openPop) return;
  openPop.remove();
  openPop = null;
  document.removeEventListener('mousedown', outsidePop, true);
  document.removeEventListener('keydown', escPop, true);
  window.removeEventListener('scroll', closePop, true);
}
function outsidePop(e) { if (openPop && !openPop.contains(e.target)) closePop(); }
function escPop(e) { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } }


// Text fields in the table display the symbol font and store Unicode, so an
// inserted symbol prints as drawn but reads correctly in the manifest.
function textInput(value, onCommit, placeholder) {
  const i = document.createElement('input');
  i.type = 'text';
  i.className = 'symtext';
  i.value = toFont(value ?? '');
  i.placeholder = placeholder || '';
  const hk = nextBurstKey();
  i.oninput = () => { historyBurst(hk); onCommit(toUni(i.value)); };
  guardKeys(i);
  trackFocus(i);
  return i;
}
// Moves to the same column in the next row with an enabled input, keeping the
// input's position within the cell, or the nearest when that row has fewer.
// Runs on Enter / Shift+Enter in a table field.
function moveRow(input, dir) {
  const td = input.closest('td');
  const tr = td?.parentElement;
  if (!td || !tr) return false;

  // Navigate by data-col, not cellIndex: sub rows have no number cell, so the
  // positional index of the tolerance cell differs between row kinds.
  const col = td.dataset.col;
  const mine = [...td.querySelectorAll('input:not([disabled])')].indexOf(input);

  let row = dir > 0 ? tr.nextElementSibling : tr.previousElementSibling;
  while (row) {
    const cell = row.querySelector(`td[data-col="${col}"]`);
    const fields = cell ? [...cell.querySelectorAll('input:not([disabled])')] : [];
    if (fields.length) {
      const target = fields[Math.min(mine, fields.length - 1)];
      target.focus();
      target.select?.();
      return true;
    }
    row = dir > 0 ? row.nextElementSibling : row.previousElementSibling;  // nothing to focus here
  }
  return false;
}

let lastDimInput = null;
function trackFocus(input) {
  input.addEventListener('focus', () => { lastDimInput = input; });
}

// Keeps table keystrokes from the canvas shortcuts, and adds Enter / Shift+Enter
// to walk the column.
function guardKeys(input) {
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    // An open suggestion list owns the arrows, Enter, Tab and Escape. Asked
    // explicitly: listeners on the target fire in the order added, so its own
    // listener couldn't get in front of this one.
    if (input._suggest?.key(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      moveRow(input, e.shiftKey ? -1 : 1);
    }
  });
}

// ---------------------------------------------------------------------------
// Suggestion list
//
// A dropdown for a text field: type to filter, arrows to move, Enter to take it
// and drop a row, Tab to take it and move across, Down on an empty field for the
// whole list. What is highlighted is always what Enter and Tab take. It
// suggests only; anything typed is kept. One list is open at a time.
// ---------------------------------------------------------------------------
// Method column suggestions: assets/methods.json, or the Settings replacement
// kept in config.json. Mutated in place, never reassigned: attachSuggest()
// holds on to this array when a row is built.
const METHOD_LIST = [];

function setMethodList(list) {
  const seen = new Set();
  METHOD_LIST.length = 0;
  for (const m of (list || [])) {
    const s = String(m || '').trim();
    const k = s.toLowerCase();
    if (s && !seen.has(k)) { seen.add(k); METHOD_LIST.push(s); }   // dedupe, keep order
  }
  if (!METHOD_LIST.length && list !== METHODS.methods) setMethodList(METHODS.methods);
}
setMethodList(METHODS.methods);

let openSuggest = null;
const closeSuggest = () => openSuggest?.close();

function attachSuggest(input, items) {
  let box = null, matches = [], at = -1;

  // Any scroll closes the box except its own, which a capturing listener on
  // window also sees (scrollIntoView() fires one while arrowing).
  const onScroll = e => { if (!box || !box.contains(e.target)) close(); };

  // Prefix hits before substring hits: typing "th" should reach the thread
  // gages before "Depth Micrometer", which merely contains those letters.
  function rank(q) {
    if (!q) return items.slice();
    const n = q.toLowerCase();
    const starts = [], has = [];
    for (const m of items) {
      const i = m.toLowerCase().indexOf(n);
      if (i === 0) starts.push(m);
      else if (i > 0) has.push(m);
    }
    return [...starts, ...has];
  }

  // Built as nodes, never innerHTML: the list is user-edited, and markup in a
  // gage name should print as text.
  function optionEl(text, q, idx) {
    const el = document.createElement('div');
    el.className = 'opt' + (idx === at ? ' on' : '');
    const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i < 0) el.textContent = text;
    else {
      const hit = document.createElement('em');
      hit.textContent = text.slice(i, i + q.length);
      el.append(text.slice(0, i), hit, text.slice(i + q.length));
    }
    el.addEventListener('mousedown', e => e.preventDefault());   // keep focus
    el.onclick = () => { accept(matches[idx]); close(); };
    return el;
  }

  function place() {
    const r = input.getBoundingClientRect();
    box.style.minWidth = `${r.width}px`;
    box.style.left = `${Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8))}px`;
    // Below unless there is no room and there is more room above.
    const below = innerHeight - r.bottom - 8;
    const h = box.offsetHeight;
    box.style.top = (h > below && r.top - 8 > below)
      ? `${Math.max(8, r.top - h - 2)}px`
      : `${r.bottom + 2}px`;
  }

  function paint(q) {
    box.innerHTML = '';
    matches.forEach((m, i) => box.appendChild(optionEl(m, q, i)));
    place();
    box.querySelector('.opt.on')?.scrollIntoView({ block: 'nearest' });
  }

  function open(q, all) {
    matches = rank(all ? '' : q);
    // A field already holding the only match has nothing left to offer.
    if (!matches.length || (matches.length === 1 && matches[0].toLowerCase() === q.toLowerCase())) {
      close();
      return;
    }
    if (!box) {
      box = document.createElement('div');
      box.className = 'sugg';
      document.body.appendChild(box);
      openSuggest = api;
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', close);
    }
    // Down on an empty field is a dropdown, not a guess: no preselection, so
    // Enter there commits the blank rather than the first gage in the file.
    if (all) at = -1;
    else if (at < 0 || at >= matches.length) at = 0;
    paint(all ? '' : q);
  }

  function close() {
    if (!box) return;
    box.remove();
    box = null;
    matches = [];
    at = -1;
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', close);
    if (openSuggest === api) openSuggest = null;
  }

  // Through the field's own commit path, so history bursts and toUni() run as
  // they do for a typed value.
  function accept(text) {
    if (!text) return;
    input.value = toFont(text);
    input.dispatchEvent(new Event('input'));
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }

  function move(d) {
    at = at < 0
      ? (d > 0 ? 0 : matches.length - 1)
      : (at + d + matches.length) % matches.length;
    paint(toUni(input.value).trim());
  }

  const api = {
    close,
    key(e) {
      if (!box) {
        // Down on a closed field opens the whole list, as a dropdown should.
        if (e.key === 'ArrowDown') { e.preventDefault(); open('', true); return true; }
        return false;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return true; }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();      // Escape means "deselect" to the global handler
        close();
        return true;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // `at` is 0 whenever anything was typed, so this takes the highlighted
        // row. Escape first keeps text the list disagrees with.
        if (at >= 0) accept(matches[at]);
        close();
        moveRow(input, e.shiftKey ? -1 : 1);
        return true;              // guardKeys must not move the row a second time
      }
      if (e.key === 'Tab') {
        if (at >= 0) accept(matches[at]);
        close();
        return false;             // let the browser move focus as it normally would
      }
      return false;
    }
  };

  // addEventListener, not .oninput: textInput() already owns that property, and
  // assigning it would silently drop the commit.
  input.addEventListener('input', () => {
    const q = toUni(input.value).trim();
    // The filter changed: highlight the top match again.
    at = 0;
    if (!q) { close(); return; }
    open(q, false);
  });
  input.addEventListener('blur', close);

  input._suggest = api;
  return api;
}

// ---------------------------------------------------------------------------
// Sheets
//
// A sheet is AUTHORED, not derived from the characteristics: its order,
// headers and overrides are edited by hand. Headers and rows are siblings in one
// ordered list.
//
//   sheet { id, name, stage, orientation, units, author, editDate, createdUtc,
//           items[] }
//   item  { type:'characteristic', ref, include, override:{spec,method} }
//         | { type:'header', text }
//   ref   = "<charId>" for a main row, "<charId>#<n>" for a sub-characteristic
// ---------------------------------------------------------------------------
let sheets = [];
let activeSheetId = null;
let shZoom = 0.6;
let bundleOpen = true;
let dragRef = null;

const STAGES = {
  'in-process': 'In-process', 'first-article': 'First article',
  'multi-part-fa': 'Multi-part FA', 'final': 'Final / AQL'
};
const TEMPLATES = { 'default': null };

const activeSheet = () => sheets.find(s => s.id === activeSheetId) || null;
const refOf = (el, i) => i === undefined ? el.id : `${el.id}#${i}`;

// Resolve a ref back to the characteristic it points at.
function deref(ref) {
  const [id, sub] = String(ref).split('#');
  const el = elements.find(e => e.id === id && e.type === 'bubble');
  if (!el) return null;
  if (sub === undefined) return { el, c: el.char, num: el.n, isSub: false };
  const sd = (el.char?.subs || [])[+sub];
  return sd ? { el, c: sd, num: el.n, isSub: true } : null;
}

// Every row the package can offer, in bubble order, mains followed by their subs.
function allRefs() {
  const out = [];
  for (const el of bubbleChars()) {
    out.push(refOf(el));
    (el.char?.subs || []).forEach((_, i) => out.push(refOf(el, i)));
  }
  return out;
}

function newSheet(name) {
  return {
    id: `sht_${uid++}`,
    name: name || `Sheet ${sheets.length + 1}`,
    stage: 'in-process',
    orientation: 'landscape',
    // Which unit set the rows pull from, per sheet.
    units: 'in',
    author: doc.package.author || '',      // seeded, then edited per sheet
    editDate: doc.package.editDate || '',
    createdUtc: new Date().toISOString(),
    // A new sheet starts with everything included.
    items: allRefs().map(ref => ({ type: 'characteristic', ref, include: true,
                                   override: { spec: '', method: '' } }))
  };
}

// Appends characteristics added since the sheet was made, as excluded, and
// drops refs whose characteristic was deleted. Runs on each render of the sheet
// editor, and when a record is taken from a sheet.
function reconcile(sheet) {
  const live = new Set(allRefs());
  sheet.items = sheet.items.filter(it => it.type !== 'characteristic' || live.has(it.ref));
  const have = new Set(sheet.items.filter(i => i.type === 'characteristic').map(i => i.ref));
  for (const ref of allRefs()) {
    if (!have.has(ref)) {
      sheet.items.push({ type: 'characteristic', ref, include: false,
                         override: { spec: '', method: '' } });
    }
  }
  normalizeSubs(sheet);
}

// Puts every sub directly beneath its parent, in source order, and excludes it
// while the parent is excluded. Runs at the end of reconcile().
function normalizeSubs(sheet) {
  const bySub = new Map();
  for (const it of sheet.items) {
    if (it.type === 'characteristic' && it.ref.includes('#')) bySub.set(it.ref, it);
  }
  const out = [];
  for (const it of sheet.items) {
    if (it.type === 'header') { out.push(it); continue; }
    if (it.ref.includes('#')) continue;               // re-emitted under its parent
    out.push(it);
    const d = deref(it.ref);
    const n = d?.el?.char?.subs?.length || 0;
    for (let i = 0; i < n; i++) {
      const ref = `${it.ref}#${i}`;
      const sub = bySub.get(ref) ||
        { type: 'characteristic', ref, include: false, override: { spec: '', method: '' } };
      if (!it.include) sub.include = false;
      out.push(sub);
    }
  }
  sheet.items = out;
}

// The list is edited as groups — a header, or a characteristic with its subs —
// so a drag moves a parent and its children as one unit.
function sheetGroups(sh) {
  const groups = [];
  for (const it of sh.items) {
    if (it.type === 'header') { groups.push({ kind: 'header', item: it }); continue; }
    if (it.ref.includes('#')) { groups[groups.length - 1]?.subs?.push(it); continue; }
    groups.push({ kind: 'char', item: it, subs: [] });
  }
  return groups;
}
const flattenGroups = groups =>
  groups.flatMap(g => g.kind === 'header' ? [g.item] : [g.item, ...g.subs]);

// ---- list pane ----
function renderSheetCards() {
  const host = $('shCards');
  host.innerHTML = '';
  if (!sheets.length) {
    const p = document.createElement('p');
    p.className = 'sh-empty';
    p.textContent = 'No sheets yet. Use + to create one.';
    host.appendChild(p);
  }
  const total = allRefs().length;
  for (const sh of sheets) {
    const on = sh.items.filter(i => i.type === 'characteristic' && i.include).length;
    const card = document.createElement('div');
    card.className = 'sh-card' + (sh.id === activeSheetId ? ' on' : '');
    const nm = document.createElement('div');
    nm.className = 'nm'; nm.textContent = sh.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${STAGES[sh.stage] || sh.stage} · ${on} of ${total}`;
    // The copy button, drawn as two overlapping sheets.
    const dup = document.createElement('button');
    dup.className = 'dup';
    dup.title = 'Copy this sheet, then invert what it includes';
    dup.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" '
      + 'stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5"/>'
      + '<path d="M5.5 14.5h9V5.5" stroke-linecap="round"/></svg>';
    dup.onclick = e => { e.stopPropagation(); duplicateSheet(sh); };

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '\u2715';
    del.title = 'Delete sheet';
    del.onclick = async e => {
      e.stopPropagation();
      if (!await confirmAction(`Delete "${sh.name}"?`,
            'The sheet layout is removed. Characteristics are untouched.', 'Delete')) return;
      pushHistory();
      noteDeleted(`Sheet \u201c${sh.name}\u201d`);
      sheets = sheets.filter(x => x.id !== sh.id);
      if (activeSheetId === sh.id) activeSheetId = sheets[0]?.id || null;
      markDirty();
      renderSheets();
    };
    card.append(nm, meta, dup, del);
    card.onclick = () => { activeSheetId = sh.id; renderSheets(); };
    host.appendChild(card);
  }
}

// ---- editor pane ----
function renderSheetRows() {
  const host = $('shRows');
  host.innerHTML = '';
  const sh = activeSheet();
  $('shBar').style.display = sh ? 'flex' : 'none';
  if (!sh) {
    const p = document.createElement('p');
    p.className = 'sh-empty';
    p.textContent = 'Select or create a sheet.';
    host.appendChild(p);
    return;
  }
  reconcile(sh);
  $('shName').value = sh.name;
  $('shStage').value = sh.stage;
  $('shOrient').value = sh.orientation;
  // Authorship is per sheet; older sheets fall back to the package's.
  $('shAuthor').value = sh.author ?? doc.package.author ?? '';
  $('shEdited').value = sh.editDate ?? doc.package.editDate ?? '';
  $('shUnits').value = sh.units === 'mm' ? 'mm' : 'in';
  syncSelBar(sh);

  const groups = sheetGroups(sh);
  const active = groups.filter(g => g.kind === 'header' || g.item.include);
  const off    = groups.filter(g => g.kind === 'char' && !g.item.include);

  active.forEach(g => renderGroup(host, sh, groups, g, false));

  if (off.length) {
    const div = document.createElement('div');
    div.className = 'sh-divider';
    div.innerHTML = `<span class="caret">${bundleOpen ? '\u25BE' : '\u25B8'}</span>` +
                    `<span>Not on this sheet (${off.length})</span>`;
    div.onclick = () => { bundleOpen = !bundleOpen; renderSheetRows(); };
    host.appendChild(div);
    if (bundleOpen) off.forEach(g => renderGroup(host, sh, groups, g, true));
  }
}

// The selection bar: the count and the list-wide operations. Runs on every
// render of the sheet editor.
function syncSelBar(sh) {
  const chars = sh.items.filter(i => i.type === 'characteristic');
  const on = chars.filter(i => i.include).length;
  $('shSelCount').textContent = `${on} of ${chars.length} included`;
  // Offers whichever end the sheet isn't already at.
  $('shAllNone').textContent = on === chars.length ? 'None' : 'All';
  $('shAllNone').title = on === chars.length
    ? 'Exclude every characteristic' : 'Include every characteristic';

  // Rows with nothing authored in this sheet's units, counted next to Export.
  const miss = unconverted(sh);
  const pill = $('shUnconv');
  pill.hidden = !miss.length;
  if (miss.length) {
    const nums = miss.map(({ d }) => d.isSub ? `${d.num}a` : d.num);
    pill.textContent = `${miss.length} without mm specs`;
    pill.title = `No millimetre spec authored for: ${nums.join(', ')}. ` +
                 `These rows print blank. Author them on Dimensions in mm, ` +
                 `or override the spec on this sheet.`;
  }
}

// Sets `include` on every characteristic by `decide`; subs follow their parent.
// Runs from Invert and All / None.
function setIncludes(sh, decide) {
  pushHistory();
  for (const g of sheetGroups(sh)) {
    if (g.kind !== 'char') continue;
    g.item.include = decide(g.item);
    for (const sub of g.subs) sub.include = g.item.include;
  }
  markDirty();
  renderSheets();
}

// One group = a header, or a characteristic with all its subs. Subs always show
// under their parent, included or not.
function renderGroup(host, sh, groups, g, excluded) {
  const gi = groups.indexOf(g);
  if (g.kind === 'header') { host.appendChild(headerRowEl(sh, groups, g, gi)); return; }
  host.appendChild(itemRowEl(sh, groups, g, gi, excluded, g.item, false));
  g.subs.forEach(sub =>
    host.appendChild(itemRowEl(sh, groups, g, gi, excluded || !g.item.include, sub, true)));
}

function itemRowEl(sh, groups, g, gi, excluded, it, isSub) {
  const d = deref(it.ref);
  const row = document.createElement('div');
  row.className = 'sh-row' + (excluded || !it.include ? ' excluded' : '') + (isSub ? ' sub' : '');
  // Only whole groups are draggable; a sub can't be moved away from its parent.
  row.draggable = !isSub;
  row.dataset.gidx = gi;

  const grip = document.createElement('span');
  grip.className = 'grip' + (isSub ? ' locked' : '');
  grip.textContent = isSub ? '\u21B3' : '\u2261';
  if (isSub) grip.title = 'Sub-characteristics stay with their parent';
  row.appendChild(grip);

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!it.include;
  cb.disabled = isSub && !g.item.include;      // can't be on while the parent is off
  cb.onclick = e => e.stopPropagation();
  cb.onchange = () => {
    pushHistory();
    it.include = cb.checked;
    if (!isSub) {
      // Moving a group in or out takes its subs with it.
      if (!it.include) g.subs.forEach(sd => { sd.include = false; });
      if (it.include) {
        const rest = groups.filter(x => x !== g);
        let at = 0;
        rest.forEach((x, i) => { if (x.kind === 'char' && x.item.include) at = i + 1; });
        rest.splice(at, 0, g);
        sh.items = flattenGroups(rest);
      }
    }
    markDirty();
    renderSheets();
  };
  row.appendChild(cb);

  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = isSub ? '' : (d ? d.num : '');
  row.appendChild(num);

  const spec = document.createElement('span');
  spec.className = 'spec';
  spec.textContent = d ? (toFont(renderSpec(d.c)) || '\u2014') : '(missing)';
  row.appendChild(spec);

  if (it.override?.spec || it.override?.method) {
    const chip = document.createElement('span');
    chip.className = 'ovr-chip';
    chip.textContent = [it.override.spec, it.override.method].filter(Boolean).join(' \u00B7 ');
    chip.title = 'Override applies to this sheet only';
    row.appendChild(chip);
  }

  const acts = document.createElement('span');
  acts.className = 'acts';
  acts.appendChild(btn('Override', () => overrideDialog(sh, it, d)));
  if (!isSub && !excluded) acts.appendChild(btn('+ Header', () => {
    pushHistory();
    const rest = [...groups];
    rest.splice(gi, 0, { kind: 'header', item: { type: 'header', text: 'NEW HEADER' } });
    sh.items = flattenGroups(rest);
    markDirty(); renderSheets();
  }));
  row.appendChild(acts);

  if (!isSub) wireDrag(row, sh, groups);
  return row;
}

function headerRowEl(sh, groups, g, gi) {
  const row = document.createElement('div');
  row.className = 'sh-hdr';
  row.draggable = true;
  row.dataset.gidx = gi;

  const grip = document.createElement('span');
  grip.className = 'grip'; grip.textContent = '\u2261';
  row.appendChild(grip);

  const inp = document.createElement('input');
  inp.value = g.item.text;
  inp.oninput = () => { g.item.text = inp.value; markDirty(); renderSheetPreview(); };
  inp.addEventListener('keydown', e => e.stopPropagation());
  row.appendChild(inp);

  row.appendChild(btn('\u2715', () => {
    pushHistory();
    const rest = groups.filter(x => x !== g);
    sh.items = flattenGroups(rest);
    markDirty(); renderSheets();
  }));
  wireDrag(row, sh, groups);
  return row;
}

function btn(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'padding:2px 7px;font-size:11px';
  b.onclick = e => { e.stopPropagation(); onClick(); };
  return b;
}

// Scrolls #shRows while a row is dragged near its top or bottom edge, faster the
// deeper into the band. Windows delivers no wheel events during an HTML5 drag.
// Stops on leaving the list, drop and dragend, never on a short silence: a
// pointer held still only gets a dragover every ~350ms. The 1.5s timeout is a
// safety net for a drag that vanishes.
const EDGE_BAND = 70, EDGE_MAX = 36;      // px of band, px per frame at the very edge
let edgeSpeed = 0, edgeRaf = 0, edgeHeard = 0;
const stopEdge = () => { edgeSpeed = 0; };
function edgeLoop() {
  if (!edgeSpeed || performance.now() - edgeHeard > 1500) { edgeSpeed = 0; edgeRaf = 0; return; }
  $('shRows').scrollTop += edgeSpeed;
  edgeRaf = requestAnimationFrame(edgeLoop);
}
$('shRows').addEventListener('dragover', e => {
  if (dragRef === null) return;
  const r = e.currentTarget.getBoundingClientRect();
  const top = e.clientY - r.top, bottom = r.bottom - e.clientY;
  const depth = top < EDGE_BAND ? -(1 - Math.max(0, top) / EDGE_BAND)
              : bottom < EDGE_BAND ? (1 - Math.max(0, bottom) / EDGE_BAND) : 0;
  edgeSpeed = Math.sign(depth) * Math.ceil(depth * depth * EDGE_MAX);
  edgeHeard = performance.now();
  if (edgeSpeed && !edgeRaf) edgeRaf = requestAnimationFrame(edgeLoop);
});
// Anywhere outside the list: the pointer has left the band by leaving the list.
document.addEventListener('dragover', e => {
  if (edgeSpeed && !$('shRows').contains(e.target)) stopEdge();
});
document.addEventListener('drop', stopEdge);
document.addEventListener('dragend', stopEdge);

// Plain HTML5 drag and drop, at group level so subs travel with their parent.
function wireDrag(row, sh, groups) {
  row.addEventListener('dragstart', e => {
    dragRef = +row.dataset.gidx;
    e.dataTransfer.effectAllowed = 'move';
  });
  // A drop outside any row (or Escape) never reaches the drop handler.
  row.addEventListener('dragend', () => {
    dragRef = null;
    stopEdge();
    document.querySelectorAll('#shRows .drag-over').forEach(n => n.classList.remove('drag-over'));
  });
  row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('drag-over'); });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', e => {
    e.preventDefault();
    row.classList.remove('drag-over');
    const to = +row.dataset.gidx;
    if (dragRef === null || dragRef === to) return;
    pushHistory();
    const rest = [...groups];
    const [moved] = rest.splice(dragRef, 1);
    rest.splice(dragRef < to ? to - 1 : to, 0, moved);
    if (moved.kind === 'char') {
      moved.item.include = true;              // dropped into the sheet
    }
    sh.items = flattenGroups(rest);
    dragRef = null;
    markDirty();
    renderSheets();
  });
}

// ---- override ----
function overrideDialog(sh, it, d) {
  const cur = it.override || (it.override = { spec: '', method: '' });
  const wrap = document.createElement('div');
  wrap.id = 'ovrModal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:90;' +
                       'display:flex;align-items:center;justify-content:center';
  wrap.innerHTML = `
    <div class="dialog" style="width:460px">
      <h2>Override for this sheet</h2>
      <p class="sub">Replaces what prints on <b>${sh.name}</b> only. Leave blank to use the characteristic as written.</p>
      <div class="row"><label>Prints as</label><input id="ovrSpec"></div>
      <div class="row"><label>Method</label><input id="ovrMethod"></div>
      <p class="hint">Original: ${d ? (renderSpec(d.c) || '\u2014') : '\u2014'}
         &nbsp;·&nbsp; ${d?.c?.method || 'no method'}</p>
      <div class="actions">
        <button id="ovrSym" title="Insert symbol">⌀ Symbols</button>
        <span style="flex:1"></span>
        <button id="ovrClear">Clear</button>
        <button id="ovrCancel">Cancel</button>
        <button id="ovrOk" class="primary">Apply</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const spec = wrap.querySelector('#ovrSpec');
  const meth = wrap.querySelector('#ovrMethod');
  // Both fields take palette inserts, so both show the symbol font and store
  // Unicode.
  spec.className = 'symtext';
  meth.className = 'symtext';
  spec.value = toFont(cur.spec || '');
  meth.value = toFont(cur.method || '');
  trackFocus(spec);
  trackFocus(meth);
  spec.focus();

  // The palette inserts into the last focused field, so make it this one.
  lastDimInput = spec;
  wrap.querySelector('#ovrSym').onclick = () => {
    const sections = [['Common', SYM_COMMON], ['Characteristics', GDT_SYMBOLS],
                      ['Modifiers', GDT_MODS]];
    popupSections(wrap.querySelector('#ovrSym'), sections, 'sym', null,
                  ([, fch]) => insertSymbol(fch));
  };

  const close = () => wrap.remove();
  wrap.querySelector('#ovrCancel').onclick = close;
  wrap.querySelector('#ovrClear').onclick = () => {
    pushHistory();
    it.override = { spec: '', method: '' }; markDirty(); close(); renderSheets();
  };
  wrap.querySelector('#ovrOk').onclick = () => {
    pushHistory();
    it.override = { spec: toUni(spec.value).trim(), method: toUni(meth.value).trim() };
    markDirty(); close(); renderSheets();
  };
  wrap.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') wrap.querySelector('#ovrOk').click();
  });
}

// ---- pagination ----
// Geometry measured against a real page-sized PDF, one set per orientation.
// Applied inline everywhere: print and screen CSS must not restate any of it,
// or the preview and the PDF drift apart.
const GEOM = {
  portrait: {
    pageW: 8.5, pageH: 11,
    cols: [0.2417, 2.2523, 1.0519, 0.9122], group: 0.7009,
    headerRows: [0.2122, 0.1990, 0.1972, 0.1986, 0.1990],
    checkRow: 0.1633, dataRow: 0.2117, rows: 41,
    marginTop: 0.2569, footerUp: 0.128,
    // Title block sits a point below the body to stop the taller labels clipping.
    fontTitle: 9.7, fontBody: 8.0, fontHeader: 7.0, fontCheck: 6.0, fontFoot: 7.3
  },
  landscape: {
    pageW: 11, pageH: 8.5,
    cols: [0.2481, 2.3185, 1.0843, 0.9382], group: 0.7202,
    headerRows: [0.2171, 0.2035, 0.2028, 0.2042, 0.2035],
    checkRow: 0.1683, dataRow: 0.2167, rows: 28,
    marginTop: 0.2565, footerUp: 0.130,
    fontTitle: 10.0, fontBody: 8.3, fontHeader: 7.3, fontCheck: 6.3, fontFoot: 7.6
  }
};
// The label/blank split inside a check group isn't drawn in the PDF (its border
// is off), so it's kept at the original 0.29/0.72 proportion.
const LABEL_FRACTION = 0.29 / 0.72;

const geomFor = o => GEOM[o] || GEOM.landscape;
function gridWidth(o, nGroups) {
  const G = geomFor(o);
  return G.cols.reduce((a, b) => a + b, 0) + nGroups * G.group;
}

// Straight from the measured forms: 41 rows portrait, 28 landscape.
const PAGE_ROWS = { portrait: GEOM.portrait.rows, landscape: GEOM.landscape.rows };

// ---- repeated check bands (in-process only) ----
//
// Below the title block, an in-process sheet repeats its band (the three-row
// check header plus the rows) as many times as fits, each adding a set of check
// columns. Other forms get one band. Band height comes from the measured row
// count, so banding and pagination agree to the row.
function bandHeights(orientation) {
  const G = geomFor(orientation);
  const rows = PAGE_ROWS[orientation] ?? PAGE_ROWS.landscape;
  return {
    available: 3 * G.checkRow + rows * G.dataRow,
    checkBlock: 3 * G.checkRow,
    dataRow: G.dataRow,
    maxRows: rows
  };
}

function bandCount(stage, orientation, rowCount) {
  if (stage !== 'in-process') return 1;          // fixed-entry forms gain nothing
  if (!rowCount) return 1;
  const h = bandHeights(orientation);
  if (rowCount > h.maxRows) return 1;            // doesn't even fit once; paginate
  const band = h.checkBlock + rowCount * h.dataRow;
  return Math.max(1, Math.floor((h.available + 1e-6) / band));
}

// Units are what may not be split across a page: a header, or a characteristic
// with its included subs (a rowspan cannot cross a page boundary).
function sheetUnits(sh) {
  const units = [];
  const on = sh.items.filter(i => i.type === 'header' || i.include);
  for (const it of on) {
    if (it.type === 'header') { units.push({ rows: [it], n: 1 }); continue; }
    if (it.ref.includes('#')) {
      const last = units[units.length - 1];
      if (last && last.rows[0].type === 'characteristic') { last.rows.push(it); last.n++; continue; }
    }
    units.push({ rows: [it], n: 1 });
  }
  return units;
}

// Works on any {orientation, rows-or-items} source, so sheets and frozen
// inspections paginate identically.
function paginateRows(rows, orientation, stage) {
  if (bandCount(stage, orientation, rows.length) > 1) return [rows];
  const cap = PAGE_ROWS[orientation] || PAGE_ROWS.landscape;
  const units = [];
  for (const r of rows) {
    if (r.isSub) {
      const last = units[units.length - 1];
      if (last) { last.rows.push(r); last.n++; continue; }
    }
    units.push({ rows: [r], n: 1 });
  }
  const pages = [];
  let cur = [], used = 0;
  for (const u of units) {
    if (used && used + u.n > cap) { pages.push(cur); cur = []; used = 0; }
    cur.push(...u.rows);
    used += u.n;
  }
  if (cur.length || !pages.length) pages.push(cur);
  return pages;
}

function paginate(sh) {
  const cap = PAGE_ROWS[sh.orientation] || PAGE_ROWS.landscape;
  const units = sheetUnits(sh);
  const total = units.reduce((n, u) => n + u.n, 0);

  // A banded sheet is always one page.
  if (bandCount(sh.stage, sh.orientation, total) > 1) {
    return [units.flatMap(u => u.rows)];
  }

  const pages = [];
  let cur = [], used = 0;
  for (const u of units) {
    if (used && used + u.n > cap) { pages.push(cur); cur = []; used = 0; }
    cur.push(...u.rows);
    used += u.n;
  }
  if (cur.length || !pages.length) pages.push(cur);
  return pages;
}

// ---------------------------------------------------------------------------
// Printed form templates
//
// The four forms differ in wording and in how the check columns are arranged,
// not in structure — so they are configuration, not four builders.
//
//   headerRight   the four right-hand labels of the header block
//   checkLabels   the three stacked labels heading each check column
//   checkMode     'multi'  = one column per inspection pass (8 landscape / 5 portrait)
//                 'single' = all columns merged into one full-width entry
//   portraitHidden which check groups drop in portrait, keeping the page to scale
// ---------------------------------------------------------------------------
const SHEET_TEMPLATES = {
  'in-process': {
    title: 'In-Process Inspection (IPI)',
    headerRight: ['Job Number', 'Machine', 'Last Author', 'Last Edit Date'],
    checkLabels: ['Date:', 'Initials:', 'OP#:'],
    checkMode: 'multi',
    portraitHidden: [1, 5, 6]
  },
  'multi-part-fa': {
    title: 'Multi-Part First Article Inspection (FAI)',
    headerRight: ['Job Number', 'Machine & OP', 'Last Author', 'Last Edit Date'],
    checkLabels: ['Date:', 'Initials:', 'Part#:'],
    checkMode: 'multi',
    portraitHidden: [1, 5, 6]
  },
  // The single-entry forms head their one column with two labels, not three.
  // The block stays .54in tall either way, so rows per page are unaffected.
  'first-article': {
    title: 'First Article Inspection (FAI)',
    headerRight: ['Job Number', 'Machine & OP', 'Last Author', 'Last Edit Date'],
    checkLabels: ['Date:', 'Technician:'],
    checkMode: 'single',
    portraitHidden: [1, 5, 6]
  },
  'final': {
    title: 'Final Inspection (AQL)',
    headerRight: ['Job Number', 'Machine & OP', 'Last Author', 'Last Edit Date'],
    checkLabels: ['Date:', 'Technician:'],
    checkMode: 'single',
    portraitHidden: [1, 5, 6]
  }
};
const templateFor = stage => SHEET_TEMPLATES[stage] || SHEET_TEMPLATES['in-process'];

// The characteristic as this sheet's unit set sees it; notes ride along from
// the parent. An unauthored alternate returns nothing, never the inch value: a
// blank on a form gets asked about, an inch number under "mm" does not.
function specSource(c, units) {
  if (units !== 'mm') return c;
  const a = c.alternateUnit;
  if (!a || !(hasValue(a.dimension) || hasValue(gdtToText(a.gdt)))) return null;
  return { dimension: a.dimension, gdt: a.gdt, notes: c.notes };
}

// Characteristics on this sheet with nothing authored in its unit set.
function unconverted(sh) {
  if (sh.units !== 'mm') return [];
  return sh.items
    .filter(it => it.type === 'characteristic' && it.include)
    .map(it => ({ it, d: deref(it.ref) }))
    .filter(({ it, d }) => d && !it.override?.spec && !specSource(d.c, 'mm'));
}

function rowsFromSheet(sh, items) {
  return items.map(it => {
    if (it.type === 'header') return { type: 'header', text: it.text };
    const d = deref(it.ref);
    if (!d) return null;
    const src = specSource(d.c, sh.units);
    return {
      type: 'characteristic',
      number: d.isSub ? '' : d.num,
      isSub: d.isSub,
      spec: it.override?.spec || (src ? renderSpec(src) : ''),
      method: it.override?.method || d.c.method || '',
      bands: []
    };
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// One page of any form. Runs for each page of the Sheets preview, the sheet PDF
// and the record PDF.
//   ctx = sheetCtx() or inspCtx(): { stage, orientation, bandCount, bands,
//         jobNumber, machine, author, editDate }
// ---------------------------------------------------------------------------
function buildPage(ctx, rows, pageNo, pageCount) {
  const tpl = templateFor(ctx.stage);
  const land = ctx.orientation === 'landscape';
  const groups = land ? [0,1,2,3,4,5,6,7]
                      : [0,1,2,3,4,5,6,7].filter(i => !tpl.portraitHidden.includes(i));
  const g = groups.length;
  const single = tpl.checkMode === 'single';
  const live = r => r.filter(i => groups.includes(i)).length;

  const G = geomFor(ctx.orientation);
  const gw = gridWidth(ctx.orientation, g);
  const side = (G.pageW - gw) / 2;

  const paper = document.createElement('div');
  paper.className = 'paper ' + (land ? 'landscape' : 'portrait');
  // Every dimension comes from GEOM.
  paper.style.width = G.pageW + 'in';
  paper.style.height = G.pageH + 'in';
  paper.style.paddingTop = G.marginTop + 'in';
  paper.style.paddingLeft = side + 'in';
  paper.style.paddingRight = side + 'in';
  paper.style.fontSize = G.fontBody + 'pt';

  const t = document.createElement('table');

  // Width is stated, not left to the cells: with border-collapse, merging the
  // check columns drops internal borders and the grid would come out narrower.
  t.style.width = gw.toFixed(4) + 'in';

  const lblW = G.group * LABEL_FRACTION;
  const cg = document.createElement('colgroup');
  [...G.cols, ...groups.flatMap(() => [lblW, G.group - lblW])]
    .forEach(w => { const c = document.createElement('col');
                    c.style.width = w.toFixed(4) + 'in'; cg.appendChild(c); });
  t.appendChild(cg);

  const cell = (cls, txt, attrs = {}) => {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    td.textContent = txt ?? '';
    for (const k in attrs) td.setAttribute(k, attrs[k]);
    return td;
  };
  const tr = () => document.createElement('tr');

  const r1 = tr();
  const logo = cell('logo', logoDataUri ? '' : 'LOGO', { rowspan: 5, colspan: 2 });
  if (logoDataUri) {
    const img = document.createElement('img');
    img.src = logoDataUri;
    logo.appendChild(img);
  }
  const ttl = cell('ttl', tpl.title, { colspan: 2 + g * 2 });
  ttl.style.fontSize = G.fontTitle + 'pt';
  ttl.style.height = G.headerRows[0] + 'in';
  r1.append(logo, ttl);
  t.appendChild(r1);

  // Author and edit date come from the sheet or record, else the package.
  const rightVals = [ctx.jobNumber || '', ctx.machine || '',
                     ctx.author ?? doc.package.author ?? '',
                     ctx.editDate ?? doc.package.editDate ?? ''];
  const leftPairs = [['Customer', doc.part.customerName], ['Part Number', doc.part.number],
                     ['Part Name', doc.part.name], ['Part Revision', doc.part.revision]];
  leftPairs.forEach(([l, v], i) => {
    const r = tr();
    r.append(cell('lbl', l), cell('val', v, { colspan: 1 + live([0,1,2]) * 2 }),
             cell('lbl', tpl.headerRight[i], { colspan: live([3]) * 2 }),
             cell('val', rightVals[i], { colspan: live([4,5,6,7]) * 2 }));
    [...r.children].forEach(td => {
      td.style.height = G.headerRows[i + 1] + 'in';
      td.style.fontSize = G.fontHeader + 'pt';
    });
    t.appendChild(r);
  });

  // Banding is decided once for the whole document and arrives in ctx. Never
  // derive it from this page's rows.
  const bands = ctx.bandCount || 1;

  // The head block is a fixed height whatever the label count; two labels means
  // taller rows.
  const nLab = tpl.checkLabels.length;
  const chH = (G.checkRow * 3 / nLab).toFixed(4) + 'in';
  // Head values come from the band being drawn.
  const headAt = (band, gi, li) =>
    ((ctx.bands?.[band]?.columns || [])[gi] || [])[li] || '';

  // Each band is a fresh set of check columns: its own header, the same rows.
  for (let band = 0; band < bands; band++) {
  tpl.checkLabels.forEach((lab, i) => {
    const r = tr();
    if (i === 0) {
      r.append(cell('stub', 'Dimension / Specification', { rowspan: nLab, colspan: 2 }),
               cell('stub', 'Method', { rowspan: nLab }), cell('stub', 'Gage ID', { rowspan: nLab }));
    }
    const labelCell = () => {
      // The span, not the cell, is lifted over the blank beside it. Lifting the
      // cell makes Chromium paint its collapsed borders separately: a stray line
      // under each label, in the PDF only.
      const c = cell('chl');
      const sp = document.createElement('span');
      sp.textContent = lab;
      c.appendChild(sp);
      c.style.height = chH;
      c.style.fontSize = G.fontCheck * 0.82 + 'pt';
      return c;
    };
    const lc = labelCell();
    if (single) {
      const vc = cell('ch', headAt(band, 0, i), { colspan: g * 2 - 1 });
      vc.style.height = chH;
      vc.style.fontSize = G.fontCheck + 'pt';
      r.append(lc, vc);      // centred, not stranded beside the label
    } else {
      r.appendChild(lc);
      groups.forEach((_, gi) => {
        if (gi > 0) r.appendChild(labelCell());
        // Each entry column of each band carries its own date / initials / op#.
        const vc = cell('ch', headAt(band, gi, i));
        vc.style.height = chH;
        vc.style.fontSize = G.fontCheck + 'pt';
        r.appendChild(vc);
      });
    }
    t.appendChild(r);
  });

  // `vals` is the row's result per entry column, for the band being drawn.
  const checks = vals => single
    ? [cell('meth', (vals || [])[0] || '', { colspan: g * 2 })]
    : groups.map((_, gi) => cell('meth', (vals || [])[gi] || '', { colspan: 2 }));

  rows.forEach((row, i) => {
    if (row.type === 'header') {
      const r = tr();
      r.append(cell('grp', row.text, { colspan: 4 + g * 2 }));
      t.appendChild(r);
      return;
    }
    let span = 1;
    if (!row.isSub) for (let k = i + 1; k < rows.length && rows[k].isSub; k++) span++;
    const r = tr();
    if (!row.isSub) r.append(cell('n', row.number, span > 1 ? { rowspan: span } : {}));
    // Dimension and method are shared; gage and readings belong to this band.
    const rb = (row.bands || [])[band] || {};
    r.append(cell('spec', toFont(row.spec || '')), cell('meth', row.method || ''),
             cell('meth', toFont(rb.gageId || '')));
    checks((rb.values || []).map(toFont)).forEach(c => r.appendChild(c));
    [...r.children].forEach(td => { td.style.height = G.dataRow + 'in'; });
    t.appendChild(r);
  });
  }   // end band

  paper.appendChild(t);

  const foot = document.createElement('div');
  foot.className = 'page-foot';
  foot.style.fontSize = G.fontFoot + 'pt';
  foot.style.bottom = G.footerUp + 'in';
  foot.style.left = side + 'in';
  foot.style.right = side + 'in';
  foot.textContent = `Page ${pageNo} of ${pageCount}`;
  paper.appendChild(foot);
  return paper;
}

// Runs from renderSheets(), after each edit on the Sheets page, and when the
// preview is toggled on.
function renderSheetPreview() {
  // A hidden pane is repainted by the toggle on the way back.
  if (!previewOn('shPrevToggle')) return;
  const host = $('shPaper');
  host.innerHTML = '';
  host.style.zoom = shZoom;
  const sh = activeSheet();
  if (!sh) { $('shPages').textContent = '\u2014'; $('shPrevInfo').textContent = ''; return; }

  const pages = paginate(sh);
  const ctx = sheetCtx(sh, pages.reduce((n, p) => n + p.length, 0));
  pages.forEach((items, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    const tag = document.createElement('div');
    tag.className = 'page-tag';
    tag.textContent = `Page ${i + 1} of ${pages.length}`;
    wrap.append(tag, buildPage(ctx, rowsFromSheet(sh, items), i + 1, pages.length));
    host.appendChild(wrap);
  });

  const rows = pages.reduce((n, p) => n + p.length, 0);
  $('shPages').textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
  const g = sh.orientation === 'landscape' ? 8 : 5;
  const bands = bandCount(sh.stage, sh.orientation, rows);
  const total = g * bands;
  $('shPrevInfo').textContent =
    `${sh.orientation} \u00b7 ${rows} row${rows === 1 ? '' : 's'} \u00b7 ` +
    (bands > 1 ? `${bands} bands \u00d7 ${g} = ${total} checks` : `${g} checks`);
}

// ---- export ----
// Built from the same buildPage() as the preview.
let fontDataUri = null;
// The print window loads from a data URL and can't reach assets/, so the logo
// travels as a data URI, like the font.
let logoDataUri = null;

async function loadLogo() {
  try {
    if (!window.api?.readAsset) return;
    const bytes = await window.api.readAsset('logo.png');
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    logoDataUri = 'data:image/png;base64,' + btoa(bin);
  } catch {
    logoDataUri = null;         // falls back to the LOGO placeholder
  }
}
async function symbolFontDataUri() {
  if (fontDataUri) return fontDataUri;
  try {
    const bytes = await window.api.readAsset('Verisurf.ttf');
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    fontDataUri = 'data:font/ttf;base64,' + btoa(bin);
  } catch (err) {
    console.warn('Symbol font unavailable for print:', err);
    fontDataUri = '';
  }
  return fontDataUri;
}

// Styles are inlined rather than linked: the print window loads from a data URL
// and has no access to the app's stylesheet or asset folder.
function printCss(fontUri) {
  return `
    ${fontUri ? `@font-face{font-family:'VerisurfGDT';src:url('${fontUri}') format('truetype');}` : ''}
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:#fff}
    body{font-family:Arial,Helvetica,sans-serif;color:#000}
    /* Page size, padding, row heights and font sizes are all set inline from the
       measured geometry — nothing here may restate them, or the two would drift. */
    .paper{page-break-after:always;break-after:page;position:relative;overflow:hidden}
    .paper:last-child{page-break-after:auto;break-after:auto}
    .page-foot{position:absolute;display:flex;justify-content:space-between;align-items:baseline}
    .page-foot span:nth-child(2){flex:1;text-align:center}
    table{border-collapse:collapse;table-layout:fixed}
    td{border:1px solid #000;padding:0 3px;overflow:hidden;vertical-align:middle}
    .ttl{background:#d9d9d9;text-align:center}
    .lbl{background:#d9d9d9;white-space:nowrap}
    .logo{text-align:center}
    .logo img{max-width:96%;max-height:92%;object-fit:contain}
    .ch{background:#d9d9d9;border-left:none;text-align:center}
    /* Only .29in wide, so let the label spill into the blank beside it. The
       span does the lifting; a lifted cell prints a stray border segment. */
    .chl{background:#d9d9d9;border-right:none;text-align:left;font-size:.82em;
         overflow:visible;white-space:nowrap}
    .chl span{position:relative;z-index:1}
    .stub{background:#d9d9d9;text-align:center}
    .grp{background:#ededed;font-weight:bold;text-align:left;padding-left:5px}
    .spec{text-align:center;font-family:'VerisurfGDT',Arial,sans-serif}
    .meth{text-align:center}
    .n{text-align:center}
    tr{page-break-inside:avoid;break-inside:avoid}`;
}

// The stem a file gets, whether it is saved one at a time or in a batch.
function sheetStem(sh) {
  return [doc.part.number || 'part', doc.part.revision && `Rev${doc.part.revision}`, sh.name]
    .filter(Boolean).join('_').replace(/[^\w.-]+/g, '_');
}

// Bytes only; the caller decides where they land. Runs from the Sheets tab's
// Export PDF button and from File > Export….
async function sheetPdfBytes(sh) {
  const pages = paginate(sh);
  const ctx = sheetCtx(sh, pages.reduce((n, p) => n + p.length, 0));
  const holder = document.createElement('div');
  pages.forEach((items, i) => holder.appendChild(
    buildPage(ctx, rowsFromSheet(sh, items), i + 1, pages.length)));

  const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>${printCss(await symbolFontDataUri())}</style></head>
    <body>${holder.innerHTML}</body></html>`;

  return window.api.printPdf({ html, landscape: sh.orientation === 'landscape' });
}

// The Sheets tab's Export PDF button.
async function exportSheetPdf() {
  const sh = activeSheet();
  if (!sh) return;
  if (!window.api?.printPdf) {
    await notify('Printing unavailable', 'This build cannot reach the print service.');
    return;
  }
  try {
    const bytes = await sheetPdfBytes(sh);
    await saveBytes(bytes, `${sheetStem(sh)}.pdf`, 'application/pdf',
      [{ name: 'PDF', extensions: ['pdf'] }]);
  } catch (err) {
    await notify('Could not export sheet', err.message);
  }
}

// ---------------------------------------------------------------------------
// Inspect
//
// An inspection is a filled-in copy of a sheet, stored in the package. It is a
// SNAPSHOT taken when the sheet is chosen: its rows keep their rendered text and
// never re-read the sheet or the characteristics.
//
//   inspection { id, sheetId, sheetName, stage, orientation, author, editDate,
//                jobNumber, machine, createdUtc, bandCount, columnCount,
//                bands[], rows[] }
//   rows[]     { type:'header', text }
//            | { type:'characteristic', ref, number, isSub, spec, method, bands[] }
// ---------------------------------------------------------------------------
let inspections = [];
let activeInspId = null;
// The Inspect pane's own drawing view, kept apart from the Dimensions pane's so
// each stays where it was left.
let inspDocId = null, inspPageIdx = 0, inspScale = 0.7;
let inspBusy = false, inspQueued = false, inspHold = null;

const activeInsp = () => inspections.find(i => i.id === activeInspId) || null;

// How many entry columns a form actually has: the merged single-entry forms have
// one, the multi-column forms have as many check groups as the orientation shows.
function columnCountFor(stage, orientation) {
  const tpl = templateFor(stage);
  if (tpl.checkMode === 'single') return 1;
  return orientation === 'landscape'
    ? 8 : 8 - (tpl.portraitHidden || []).length;
}
const labelsFor = stage => templateFor(stage).checkLabels;

// A band is one full repeat of the form below the title block: its own check
// header, gage IDs and entries. Dimension and method are shared across bands.
//
//   ins.bands[b].columns[c][l]   head values: Date / Initials / OP# per column
//   row.bands[b].gageId          the gage used for that band
//   row.bands[b].values[c]       the reading in column c of that band
const blankColumns = (cols, labels) =>
  Array.from({ length: cols }, () => Array.from({ length: labels }, () => ''));
const blankBands = (bands, cols, labels) =>
  Array.from({ length: bands }, () => ({ columns: blankColumns(cols, labels) }));
const blankRowBands = (bands, cols) =>
  Array.from({ length: bands }, () => ({
    gageId: '', values: Array.from({ length: cols }, () => '')
  }));
const sheetById = id => sheets.find(s => s.id === id) || null;

// Freezes the sheet as it stands. Runs when a sheet is picked from Inspect's
// add menu.
function newInspection(sheetId) {
  const sh = sheetById(sheetId);
  reconcile(sh);
  const cols = columnCountFor(sh.stage, sh.orientation);
  const labels = labelsFor(sh.stage);
  // Frozen with the record: editing the sheet later must not reshape it.
  const rowCount = sh.items.filter(i => i.type === 'header' || i.include).length;
  const bands = bandCount(sh.stage, sh.orientation, rowCount);
  const rows = [];
  for (const it of sh.items) {
    if (it.type === 'header') { rows.push({ type: 'header', text: it.text }); continue; }
    if (!it.include) continue;
    const d = deref(it.ref);
    if (!d) continue;
    rows.push({
      type: 'characteristic',
      ref: it.ref,
      number: d.isSub ? '' : d.num,
      isSub: d.isSub,
      // Rendered here, not at display time — the record must not move. Stored
      // as Unicode: the frozen row outlives whatever face renders it.
      spec: it.override?.spec || renderSpec(d.c),
      method: it.override?.method || d.c.method || '',
      bands: blankRowBands(bands, cols)
    });
  }
  return {
    id: `insp_${uid++}`,
    bandCount: bands,
    columnCount: cols,
    bands: blankBands(bands, cols, labels.length),
    sheetId,
    sheetName: sh.name,
    stage: sh.stage,
    orientation: sh.orientation,
    author: sh.author || '',
    editDate: sh.editDate || '',
    jobNumber: '',
    machine: '',
    createdUtc: new Date().toISOString(),
    rows
  };
}

function renderInspCards() {
  const host = $('inspCards');
  host.innerHTML = '';
  if (!inspections.length) {
    const p = document.createElement('p');
    p.className = 'sh-empty';
    p.textContent = sheets.length
      ? 'No inspections yet. Use + to start one.'
      : 'Create a sheet first \u2014 an inspection is a filled-in copy of one.';
    host.appendChild(p);
  }
  for (const ins of inspections) {
    const first = ((ins.bands || [])[0]?.columns || [])[0] || [];
    const who = first[1] || '', when = first[0] || '';

    const card = document.createElement('div');
    card.className = 'sh-card' + (ins.id === activeInspId ? ' on' : '');
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = ins.sheetName || 'Inspection';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${when || 'no date'} \u00b7 ${who || 'unassigned'}`;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '\u2715';
    del.title = 'Delete inspection';
    del.onclick = async e => {
      e.stopPropagation();
      if (!await confirmAction('Delete this inspection?',
            'The recorded results are removed. The sheet is untouched.', 'Delete')) return;
      pushHistory();
      noteDeleted(`Inspection \u201c${ins.sheetName || 'record'}\u201d`);
      inspections = inspections.filter(x => x.id !== ins.id);
      if (activeInspId === ins.id) activeInspId = inspections[0]?.id || null;
      markDirty(); renderInspect();
    };
    card.append(nm, meta, del);
    card.onclick = () => { activeInspId = ins.id; renderInspect(); };
    host.appendChild(card);
  }
}

function renderInspRows() {
  const host = $('inspRows');
  host.innerHTML = '';
  const ins = activeInsp();
  $('inspBar').style.display = ins ? 'flex' : 'none';
  $('inspSrc').textContent = '';
  if (!ins) {
    const p = document.createElement('p');
    p.className = 'sh-empty';
    p.textContent = 'Select or create an inspection.';
    host.appendChild(p);
    return;
  }
  // Only a record has a source package to go looking for.
  $('inspFetch').hidden = !recordMode;
  $('inspOpenPkg').hidden = !recordMode;

  $('inspJob').value = ins.jobNumber || '';
  $('inspMachine').value = ins.machine || '';
  $('inspSrc').textContent =
    `from \u201c${ins.sheetName}\u201d \u00b7 ${ins.orientation} \u00b7 frozen ${(ins.createdUtc || '').slice(0, 10)}`;

  // One block per band, stacked as it prints: the check header, the column
  // headers, then the rows.
  const labels = labelsFor(ins.stage);
  const cols = ins.columnCount || 1;
  const bands = ins.bandCount || 1;
  $('inspRows').closest('.sh-editor')?.style.setProperty('--ins-cols', cols);
  host.style.setProperty('--ins-cols', cols);

  for (let b = 0; b < bands; b++) {
    const band = ins.bands[b] || (ins.bands[b] = { columns: blankColumns(cols, labels.length) });

    if (bands > 1) {
      const tag = document.createElement('div');
      tag.className = 'band-tag';
      tag.textContent = `Band ${b + 1} of ${bands}`;
      host.appendChild(tag);
    }

    labels.forEach((lab, li) => {
      const row = document.createElement('div');
      row.className = 'ins-row head';
      row.appendChild(el('span', 'num'));
      row.appendChild(el('span', 'grp-bar'));
      row.appendChild(el('span', 'spec'));
      row.appendChild(el('span', 'lbl', lab));
      const cells = document.createElement('div');
      cells.className = 'ins-cells';
      for (let c = 0; c < cols; c++) {
        band.columns[c] = band.columns[c] || [];
        cells.appendChild(colInput(band.columns[c], li, lab.replace(':', '')));
      }
      row.appendChild(cells);
      host.appendChild(row);
    });

    const ch = document.createElement('div');
    ch.className = 'ins-row colhead';
    ch.appendChild(el('span', 'num'));
    ch.appendChild(el('span', 'grp-bar'));
    ch.appendChild(el('span', 'spec', 'Dimension'));
    ch.appendChild(el('span', 'lbl', 'Gage ID'));
    ch.appendChild(el('span', 'cells-label', 'Entries'));
    host.appendChild(ch);

    ins.rows.forEach((row, i) => {
      if (row.type === 'header') {
        const h = document.createElement('div');
        h.className = 'ins-hdr';
        h.textContent = row.text;
        host.appendChild(h);
        return;
      }
      const nextIsSub = ins.rows[i + 1]?.isSub;
      const inGroup = row.isSub || nextIsSub;
      row.bands = row.bands || blankRowBands(bands, cols);
      const rb = row.bands[b] || (row.bands[b] = { gageId: '', values: [] });

      const line = document.createElement('div');
      line.className = 'ins-row' + (row.isSub ? ' sub' : '') +
                       (inGroup && nextIsSub ? '' : ' group-end');
      line.appendChild(el('span', 'num', row.number || ''));
      line.appendChild(el('span', 'grp-bar' + (inGroup ? ' on' : '')));

      // Shared across bands but editable in each; edits mirror live.
      line.appendChild(sharedSpecInput(row, i));

      line.appendChild(colInput(rb, 'gageId', 'gage', 'gage'));

      const cells = document.createElement('div');
      cells.className = 'ins-cells';
      rb.values = rb.values || [];
      for (let c = 0; c < cols; c++) cells.appendChild(colInput(rb.values, c, 'result'));
      line.appendChild(cells);
      host.appendChild(line);
    });
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// The same field shown once per band. Edits write to the row and mirror into the
// other bands' copies, so several inputs can share one value without drifting.
function sharedSpecInput(row, rowIndex) {
  const i = document.createElement('input');
  i.type = 'text';
  i.className = 'symtext spec';
  i.dataset.specRow = String(rowIndex);
  i.value = toFont(row.spec || '');
  i.placeholder = 'dimension';
  const hk = `spec${rowIndex}`;      // shared: all bands of a row are one edit
  i.oninput = () => {
    historyBurst(hk);
    row.spec = toUni(i.value);
    document.querySelectorAll(`#inspRows input[data-spec-row="${rowIndex}"]`)
      .forEach(other => { if (other !== i) other.value = i.value; });
    markDirty();
  };
  guardKeys(i);
  trackFocus(i);
  return i;
}

// One cell of a string array — used for both the head labels and the results.
function colInput(arr, idx, placeholder, cls) {
  const i = document.createElement('input');
  i.type = 'text';
  i.className = 'symtext ' + (cls || 'cell');
  i.value = toFont(arr[idx] || '');
  i.placeholder = placeholder;
  const hk = nextBurstKey();
  i.oninput = () => {
    historyBurst(hk);
    arr[idx] = toUni(i.value);
    markDirty();
    renderInspCards();          // the card shows the first column's date and name
  };
  guardKeys(i);
  trackFocus(i);
  return i;
}

// Restores a record's band structure, folding older shapes forward: a single
// value per row, or a flat one-band column list. Runs as a record is loaded
// from a package or from an embedded PDF.
function restoreColumns(ins) {
  const stage = ins.stage || 'in-process';
  const labels = labelsFor(stage);
  const cols = ins.columnCount || columnCountFor(stage, ins.orientation || 'landscape');
  const bands = Math.max(1, ins.bandCount || 1);

  const out = blankBands(bands, cols, labels.length);
  (ins.bands || []).forEach((b, bi) => {
    if (bi >= bands) return;
    (b?.columns || []).forEach((c, ci) => {
      if (ci >= cols) return;
      (c || []).forEach((v, li) => { if (li < labels.length) out[bi].columns[ci][li] = v || ''; });
    });
  });
  // Pre-band record: its single column set becomes band 0.
  if (!ins.bands && ins.columns) {
    ins.columns.forEach((c, ci) => {
      if (ci >= cols) return;
      (c || []).forEach((v, li) => { if (li < labels.length) out[0].columns[ci][li] = v || ''; });
    });
  } else if (!ins.bands && (ins.date || ins.inspector)) {
    out[0].columns[0][0] = ins.date || '';
    if (labels.length > 1) out[0].columns[0][1] = ins.inspector || '';
  }

  const rows = (ins.rows || []).map(r => {
    const o = { ...r };
    const rb = blankRowBands(bands, cols);
    (r.bands || []).forEach((b, bi) => {
      if (bi >= bands) return;
      rb[bi].gageId = b?.gageId || '';
      (b?.values || []).forEach((v, ci) => { if (ci < cols) rb[bi].values[ci] = v || ''; });
    });
    if (!r.bands) {                       // pre-band row
      rb[0].gageId = r.gageId || '';
      if (r.values) r.values.forEach((v, ci) => { if (ci < cols) rb[0].values[ci] = v || ''; });
      else if (r.value) rb[0].values[0] = r.value;
    }
    delete o.value; delete o.values; delete o.gageId;
    o.bands = rb;
    return o;
  });
  return { bandCount: bands, columnCount: cols, bands: out, rows };
}

// buildPage()'s context for a live sheet. totalRows is the whole sheet, never
// one page: banding is decided for the document.
const sheetCtx = (sh, totalRows) => ({
  stage: sh.stage, orientation: sh.orientation,
  author: sh.author, editDate: sh.editDate,
  bandCount: bandCount(sh.stage, sh.orientation, totalRows)
});

// buildPage()'s context for a record, from its frozen stage, bands and header
// values, so it always reprints on the form it was filled on.
const inspCtx = ins => ({ stage: ins.stage || 'in-process', orientation: ins.orientation,
                          bands: ins.bands, bandCount: ins.bandCount,
                          jobNumber: ins.jobNumber, machine: ins.machine,
                          author: ins.author, editDate: ins.editDate });

// Runs from openInspDrawing(), from Inspect's drawing and page controls, and
// when the preview is toggled on.
async function renderInspDrawing() {
  // A hidden pane is repainted by the toggle on the way back.
  if (!previewOn('inspPrevToggle')) return;
  const canvas = $('inspCanvas');
  const d = docs.find(x => x.id === inspDocId);
  // A record carries no drawing until Fetch, so its empty pane says so.
  $('inspPrevEmpty').textContent = recordMode
    ? 'No drawing yet \u2014 use Fetch bubble print to pull it from the source package.'
    : 'No drawing loaded';
  $('inspPrevEmpty').hidden = !!d;
  canvas.hidden = !d;
  if (!d) {
    $('inspPage').textContent = '\u2014 / \u2014';
    $('inspBubbles').textContent = '\u2014';
    return;
  }

  // pdf.js render calls can't overlap on one canvas; coalesce instead of racing.
  if (inspBusy) { inspQueued = true; return; }
  inspBusy = true;
  try {
    inspPageIdx = Math.min(inspPageIdx, d.numPages - 1);
    await paintDrawingPage(canvas, d, inspPageIdx, inspScale);
    $('inspPage').textContent = `${inspPageIdx + 1} / ${d.numPages}`;
    // Real bubbles only; a reference bubble shares its number with one.
    const n = elements.filter(e => e.type === 'bubble'
      && e.documentId === d.id && e.pdfPage === inspPageIdx).length;
    $('inspBubbles').textContent = `${n} bubble${n === 1 ? '' : 's'}`;
  } finally {
    inspBusy = false;
    if (inspQueued) { inspQueued = false; renderInspDrawing(); }
    else if (inspHold) { inspHold(); inspHold = null; }
  }
}

function syncInspDrawingControls() {
  const sel = $('inspDoc');
  sel.innerHTML = '';
  for (const d of docs) {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.label;
    if (d.id === inspDocId) o.selected = true;
    sel.appendChild(o);
  }
  const pct = Math.round(inspScale * 100);
  $('inspZoom').value = pct;
  $('inspZoomPct').textContent = `${pct}%`;
}

// Called when the Inspect page opens, and after a Fetch brings drawings in.
function openInspDrawing() {
  if (!docs.some(d => d.id === inspDocId)) {
    inspDocId = activeDocId || docs[0]?.id || null;
    inspPageIdx = 0;
  }
  syncInspDrawingControls();
  renderInspDrawing();
}

function renderInspect() {
  renderInspCards();
  renderInspRows();
  openInspDrawing();
}

// ---------------------------------------------------------------------------
// Embedded record
//
// An exported record PDF carries its record as an attachment: opened here, the
// Inspect screen restores it; opened anywhere else, it's an ordinary filled
// form. Drawings are referenced by hash, never embedded; Fetch uses the hashes
// to find the source package.
// ---------------------------------------------------------------------------
const RECORD_FILE = 'inspection.json';
const RECORD_KIND = 'bubbler-inspection';

// JSON with keys sorted recursively, so equal records hash equal whatever order
// their fields were written in.
function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

// What the record hash covers: what was inspected and recorded, never export
// timestamps.
function inspectionCore(ins) {
  return {
    id: ins.id, sheetId: ins.sheetId, sheetName: ins.sheetName,
    stage: ins.stage, orientation: ins.orientation,
    jobNumber: ins.jobNumber || '', machine: ins.machine || '',
    author: ins.author || '',
    editDate: ins.editDate || '',
    bandCount: ins.bandCount || 1,
    columnCount: ins.columnCount || 1,
    bands: (ins.bands || []).map(b => ({ columns: (b.columns || []).map(c => [...c]) })),
    createdUtc: ins.createdUtc || null,
    rows: (ins.rows || []).map(r => ({
      ...r,
      bands: (r.bands || []).map(b => ({ gageId: b.gageId || '', values: [...(b.values || [])] }))
    }))
  };
}

async function hashInspection(ins) {
  const bytes = new TextEncoder().encode(canonicalJson(inspectionCore(ins)));
  return await sha256(bytes);
}

async function buildRecord(ins) {
  return {
    kind: RECORD_KIND,
    schemaVersion: SCHEMA_VERSION,
    exportedUtc: new Date().toISOString(),
    application: APP,
    package: {
      id: doc.package.id || null,
      createdUtc: doc.package.createdUtc || null,
      createdBy: doc.package.createdBy || null,
      // The printed title block reads these, so a reopened record must have them.
      author: doc.package.author || '',
      editDate: doc.package.editDate || '',
      // The audit trail as of export.
      audit: (doc.package.audit || []).slice()
    },
    part: {
      number: doc.part.number, revision: doc.part.revision, name: doc.part.name,
      customer: { name: doc.part.customerName, partNumber: doc.part.customerPartNumber },
      material: doc.part.material, finish: doc.part.finish
    },
    // Locates the source package without carrying the PDFs.
    drawingSetHash: await drawingSetHash(docs.map(d => d.sha256)),
    drawings: docs.map(d => ({
      id: d.id, file: d.file, label: d.label,
      sha256: d.sha256, pages: d.numPages
    })),
    // Compared against the package's copy to tell whether they still match.
    recordHash: await hashInspection(ins),
    inspection: inspectionCore(ins)
  };
}

async function attachRecord(pdfBytes, ins) {
  const out = await PDFDocument.load(pdfBytes);
  const json = JSON.stringify(await buildRecord(ins), null, 2);
  await out.attach(new TextEncoder().encode(json), RECORD_FILE, {
    mimeType: 'application/json',
    description: 'Bubbler+ inspection record',
    creationDate: new Date(),
    modificationDate: new Date()
  });
  return await out.save();
}

// Returns a PDF's embedded record, or null for an ordinary drawing. Runs on
// every PDF that is opened.
async function readRecord(buf) {
  let pdf = null;
  try {
    pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    const att = await pdf.getAttachments();
    if (!att) return null;
    const hit = att[RECORD_FILE] ||
                Object.values(att).find(a => /inspection\.json$/i.test(a.filename || ''));
    if (!hit) return null;
    const rec = JSON.parse(new TextDecoder().decode(hit.content));
    return rec && rec.kind === RECORD_KIND ? rec : null;
  } catch {
    return null;                    // not a record; treat as a plain drawing
  } finally {
    try { await pdf?.destroy(); } catch { /* ignore */ }
  }
}

// The open record's drawing list, which Fetch looks up by hash.
let recordDrawings = [];
// True while an exported record, not a package, is open. Saving is blocked:
// there's no .insp to write back to.
let recordMode = false;
let recordHash = null;
let recordSetHash = null;

async function loadRecord(rec) {
  await releaseDocs();
  elements = []; sheets = []; activeSheetId = null;
  nextNumber = 1; uid = 1; clearSel(); pageIndex = 0;
  undoStack = []; redoStack = []; updateHistoryButtons();

  const p = rec.part || {};
  doc.raw = null;
  doc.part = {
    number: p.number || '', revision: p.revision || '', name: p.name || '',
    customerName: p.customer?.name || '', customerPartNumber: p.customer?.partNumber || '',
    material: p.material || '', finish: p.finish || ''
  };
  doc.package = {
    id: rec.package?.id || null,
    createdUtc: rec.package?.createdUtc || null,
    createdBy: rec.package?.createdBy || 'local',
    author: rec.package?.author || '',
    editDate: rec.package?.editDate || ''
  };
  recordDrawings = rec.drawings || [];
  recordSetHash = rec.drawingSetHash || null;
  recordHash = rec.recordHash || null;
  recordMode = true;
  newerSchema = null;          // a record is never saved as a package; the flag is the last package's

  const ins = rec.inspection || {};
  inspections = [{
    id: ins.id || `insp_${uid++}`,
    sheetId: ins.sheetId || null,
    sheetName: ins.sheetName || 'Inspection',
    stage: ins.stage || 'in-process',
    orientation: ins.orientation || 'landscape',
    jobNumber: ins.jobNumber || '', machine: ins.machine || '',
    author: ins.author || '', editDate: ins.editDate || '',
    ...restoreColumns(ins),          // also migrates any older single-value record
    createdUtc: ins.createdUtc || null
  }];
  activeInspId = inspections[0].id;

  syncDocFields();
  showApp();
  showDrawing(false);
  setInspectOnly(true);
}

// Leaves record mode. Every route out of a record runs through here: opening a
// package, starting a new one, loading a bare PDF.
function clearRecordMode() {
  recordMode = false;
  recordHash = null;
  recordSetHash = null;
  recordDrawings = [];
  applyRailMode();
}

// ---------------------------------------------------------------------------
// Settings
//
// The share root lives in config.json in the data folder, not in the
// package: it's a per-machine setting.
// ---------------------------------------------------------------------------
let appConfig = { NETWORK_PATH: '', SIDECAR_PATH: '', ARCHIVE_DIR: 'Archive',
                  SEARCH_DEPTH: 4, CONCURRENCY: 8 };

// Live progress while the share is being crawled.
if (window.api?.onIndexProgress) {
  window.api.onIndexProgress(p => {
    const el = document.getElementById('cfgScan');
    if (!el) return;
    if (p.phase === 'scan') {
      // Counts folders read, so an empty share still shows progress.
      const stuck = p.unreadable ? `, ${p.unreadable} unreadable` : '';
      el.textContent = `Scanning \u2014 ${p.scanned} folder${p.scanned === 1 ? '' : 's'} read, ` +
        `${p.count} package${p.count === 1 ? '' : 's'} found${stuck}` +
        (p.label ? ` \u00b7 ${p.label}` : '');
    } else if (p.phase === 'start') {
      el.textContent = 'Walking the share\u2026';
    }
  });
}

// Runs once at startup.
async function loadConfig() {
  try {
    if (window.api?.getConfig) appConfig = await window.api.getConfig();
    if (appConfig.METHODS?.length) setMethodList(appConfig.METHODS);
  } catch (err) {
    console.warn('Could not read config:', err);
  }
}

// The Settings dialog, from the app menu.
function settingsDialog() {
  const wrap = document.createElement('div');
  wrap.className = 'modal-back';
  wrap.innerHTML = `
    <div class="dialog" style="width:520px">
      <h2>Settings</h2>
      <p class="sub">Saved in config.json.</p>
      <h3 style="margin-top:16px">General settings</h3>
      <div class="row"><label>Printing margins</label>
        <div class="swap" style="gap:6px; align-items:center">
          <input id="cfgMargin" type="number" min="0" max="1" step="0.05" style="flex: 50%">
          <span class="hint" style="margin:0; flex: 50%">Only applies when printing bubbled drawings.</span>
        </div>
      </div>
      <div class="row"><label>Method list</label>
        <div class="swap" style="gap:6px; align-items:center; display:flex">
          <textarea id="cfgMethods" rows="7" spellcheck="false"
            style="resize:none; font-family:ui-monospace, monospace; font-size:12px; flex:50%"
            placeholder="One per line"></textarea>
          <span class="hint" style="flex:50%">Auto-complete entries for the Method
            column, one per line, shown in this order. Empty it to restore the built-in list.</span>
        </div>
      </div>
      <h3 style="margin-top:16px">Package index</h3>
      <p class="hint" style="padding-bottom: 8px">Packages publish themselves to the Index 
	 folder when saved or opened. The index is used for listing files in 'Quick Find.'</p>
      <div class="row"><label>Index folder</label>
        <div class="swap" style="gap:6px">
          <input id="cfgSidecar" style="flex:1" placeholder="blank = local index, this machine only">
          <button id="cfgBrowseIdx">Browse\u2026</button>
        </div>
      </div>
      <div class="row"><label>Packages root</label>
        <div class="swap" style="gap:6px">
          <input id="cfgPath" style="flex:1" placeholder="\\\\server\\share\\Master Files">
          <button id="cfgBrowse">Browse\u2026</button>
        </div>
      </div>
      <div class="row"><label>Package folder</label><input id="cfgPackage" placeholder="QC"></div>
      <div class="row"><label>Archive folder</label><input id="cfgArchive"></div>
      <p class="hint">Archive folder is expected to be inside Package folder, and is only searched when trying
	 to 'Fetch' a package via an old, exported inspection record.</p>
      <h3 style="margin-top:16px">Rebuilding the index</h3>
      <p class="hint">Rebuilding may be necessary if packages have been moved, deleted or
	 restored by hand. A rebuild also flags any that have gone missing so they stop appearing
	 in 'Quick Find'. A rebuild only looks for .insp packages inside folders matching the name of
	 'Package folder' above, and those folders must be in the package root, up to a specified depth.</p>
      <p class="hint" id="cfgIndex">\u2014</p>
      <p class="hint" id="cfgStatus">Not tested.</p>
      <p class="hint" id="cfgScan" style="display:none"></p>
      <div class="actions">
        <button id="cfgTest">Test</button>
        <button id="cfgSetup">Rebuild index</button>
        <button id="cfgPurge" disabled>Remove missing</button>
        <button id="cfgData">Open data folder</button>
        <span style="flex:1"></span>
        <button id="cfgCancel">Cancel</button>
        <button id="cfgOk" class="primary">Save</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const q = sel => wrap.querySelector(sel);
  const path = q('#cfgPath'), side = q('#cfgSidecar'), arch = q('#cfgArchive'),
        pkg = q('#cfgPackage'), status = q('#cfgStatus'),
        marg = q('#cfgMargin'), meth = q('#cfgMethods');
  path.value = appConfig.NETWORK_PATH || '';
  side.value = appConfig.SIDECAR_PATH || '';

  // An index folder only counts when a packages root is set; the field is
  // disabled without one, matching indexRoot() in main.
  const syncIndexField = () => {
    const rooted = !!path.value.trim();
    side.disabled = !rooted;
    q('#cfgBrowseIdx').disabled = !rooted;
    side.placeholder = rooted
      ? 'blank = local index, this machine only'
      : 'needs a packages root above';
  };
  path.oninput = syncIndexField;
  syncIndexField();
  pkg.value = appConfig.PACKAGE_DIR || 'QC';
  arch.value = appConfig.ARCHIVE_DIR || 'Archive';
  marg.value = appConfig.PRINT_MARGIN_IN ?? 0.25;
  meth.value = METHOD_LIST.join('\n');
  path.focus();

  // SEARCH_DEPTH and CONCURRENCY are left out on purpose: config:set merges, so
  // absent keys keep their config.json values.
  const patch = () => ({
    NETWORK_PATH: path.value.trim(),
    SIDECAR_PATH: side.value.trim(),
    PACKAGE_DIR: pkg.value.trim() || 'QC',
    ARCHIVE_DIR: arch.value.trim() || 'Archive',
    PRINT_MARGIN_IN: Math.max(0, Math.min(1, parseFloat(marg.value) || 0))
  });

  const close = () => wrap.remove();
  wrap.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  q('#cfgCancel').onclick = close;

  q('#cfgBrowse').onclick = async () => {
    const dir = await window.api?.pickFolder?.();
    if (dir) path.value = dir;
  };
  q('#cfgBrowseIdx').onclick = async () => {
    const dir = await window.api?.pickFolder?.();
    if (dir) side.value = dir;
  };

  // Checks the share is actually reachable before it gets committed.
  q('#cfgTest').onclick = async () => {
    status.textContent = 'Checking\u2026';
    const r = await window.api?.testPath?.(path.value);
    status.textContent = r?.ok
      ? `Reachable \u2014 ${r.folders} folder${r.folders === 1 ? '' : 's'} at the root.`
      : `Not reachable: ${r?.reason || 'unknown error'}`;
    status.style.color = r?.ok ? '#7fae6a' : '#d08a70';
  };

  // Index state, refreshed after a rebuild.
  const showStats = async () => {
    const st = await window.api?.indexStats?.();
    if (!st) return;
    q('#cfgPurge').disabled = !st.missing;
    // No packages root means a local index, which is reported like any other.
    if (!st.packages) {
      q('#cfgIndex').textContent = st.local
        ? 'Nothing indexed yet \u2014 packages are added to this machine\u2019s local index as you save or open them.'
        : 'No packages published yet. Saving a package adds it automatically.';
    } else {
      const gone = st.missing ? ` \u00b7 ${st.missing} missing` : '';
      const where = st.local ? ' \u00b7 local to this machine' : '';
      q('#cfgIndex').textContent =
        `${st.packages} package${st.packages === 1 ? '' : 's'}, ` +
        `${st.hashes} drawing hash${st.hashes === 1 ? '' : 'es'}${gone}${where}`;
    }
  };
  showStats();

  q('#cfgSetup').onclick = async () => {
    const scan = q('#cfgScan');
    // Saves the paths first, so the rebuild uses what's on screen.
    appConfig = await window.api.setConfig(patch());
    scan.style.display = 'block';
    scan.textContent = 'Starting\u2026';
    q('#cfgSetup').disabled = q('#cfgPurge').disabled = true;
    const r = await window.api.indexRebuild();
    q('#cfgSetup').disabled = false;          // showStats() below re-decides Remove missing
    // With no packages root, the button rechecks the local index instead of
    // crawling.
    scan.textContent = !r.ok
      ? `Failed: ${r.reason}`
      : r.checkOnly
        ? `No packages root set \u2014 rechecked ${r.packages} indexed ` +
          `package${r.packages === 1 ? '' : 's'} in ${r.seconds.toFixed(1)}s, ` +
          (r.missing ? `${r.missing} missing.` : 'all still reachable.')
        : `Published ${r.written} of ${r.packages} package${r.packages === 1 ? '' : 's'}` +
          (r.missing ? `, flagged ${r.missing} missing` : '') +
          // Two files share one id; only one is indexed. Paths are in the main
          // process console.
          (r.duplicates ? `, ${r.duplicates} sharing an id` : '') +
          ` \u2014 ${r.folders} folder${r.folders === 1 ? '' : 's'} read in ${r.seconds.toFixed(1)}s` +
          (r.unreadable ? `, ${r.unreadable} could not be read.` : '.');
    // Amber when the rebuild couldn't account for everything: an unreadable
    // folder, or two files sharing an id.
    scan.style.color = !r.ok ? '#d08a70'
      : (r.unreadable || r.duplicates) ? '#b8862c' : '#7fae6a';
    showStats();
    // The Library holds its results in memory, so it's told to refresh.
    window.BubblerLibrary?.refresh?.();
  };

  // Settings, recents, recovery and the local index live in the data folder.
  window.api?.dataFolder?.().then(p => { if (p) q('#cfgData').title = p; });
  q('#cfgData').onclick = async () => {
    const r = await window.api?.openDataFolder?.();
    if (r && !r.ok) await notify('Could not open the data folder', `${r.path}\n\n${r.error}`);
  };

  q('#cfgPurge').onclick = async () => {
    const st = await window.api?.indexStats?.();
    const n = st?.missing || 0;
    if (!n) { showStats(); return; }
    const { button } = await dialog({
      title: `Remove ${n} missing package${n === 1 ? '' : 's'} from the index?`,
      body: 'Only the index forgets them. No files are deleted \u2014 there are none ' +
            'where these records point. A package that turns up again is added ' +
            'back the next time it is opened, saved or found by a rebuild.',
      buttons: ['remove', 'cancel'],
      defaultId: 'cancel'
    });
    if (button !== 'remove') return;
    const scan = q('#cfgScan');
    q('#cfgPurge').disabled = q('#cfgSetup').disabled = true;
    try {
      const r = await window.api.indexPurgeMissing();
      scan.style.display = 'block';
      scan.style.color = r?.ok ? '#7fae6a' : '#d08a70';
      scan.textContent = !r?.ok ? 'Could not remove missing packages.'
        : `Removed ${r.removed} missing package${r.removed === 1 ? '' : 's'}` +
          (r.kept ? `; kept ${r.kept} that ${r.kept === 1 ? 'is' : 'are'} reachable again.` : '.');
    } catch (err) {
      scan.style.display = 'block';
      scan.style.color = '#d08a70';
      scan.textContent = `Could not remove missing packages: ${err.message}`;
    } finally {
      q('#cfgSetup').disabled = false;
      await showStats();
      window.BubblerLibrary?.refresh?.();
    }
  };

  q('#cfgOk').onclick = async () => {
    appConfig = await window.api.setConfig({
      ...patch(),
      // Applied before it is stored, so the cleaned list is what's saved.
      METHODS: (setMethodList(meth.value.split('\n')), METHOD_LIST.slice())
    });
    close();
  };
}
// ---------------------------------------------------------------------------
// Autosave
//
// Writes a recovery copy while there are unsaved changes, never over the
// user's own file. Stored uncompressed: the drawings are already-compressed
// PDFs, and deflating them again stalls the UI for seconds.
// ---------------------------------------------------------------------------
const FIRST_RECOVERY_MS = 15000;
const AUTOSAVE_MS = 120000;
let firstRecoveryTimer = null;
let autosaveTimer = null;
let lastAutosave = 0;

async function autosave() {
  // Nothing to protect, or nothing that could be written back.
  if (!dirty || recordMode || newerSchema || !docs.length || !window.api?.recoverySave) return;
  try {
    const manifest = await buildManifest();
    const entries = {
      'manifest.json': new TextEncoder().encode(JSON.stringify(manifest))
    };
    for (const d of docs) entries[d.file] = new Uint8Array(d.bytes.slice(0));
    const zip = fflate.zipSync(entries, { level: 0 });   // store, don't deflate
    await window.api.recoverySave({
      data: zip,
      meta: {
        savedUtc: new Date().toISOString(),
        partNumber: doc.part.number || '',
        partRev: doc.part.revision || '',
        name: currentName || 'Untitled',
        path: currentPath || null,
        drawings: docs.length,
        bubbles: elements.filter(e => e.type === 'bubble').length
      }
    });
    lastAutosave = Date.now();
  } catch (err) {
    console.warn('Autosave failed:', err);      // never interrupt the user for this
  }
}

function startAutosave() {
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(autosave, AUTOSAVE_MS);
}

const clearRecovery = () => window.api?.recoveryClear?.().catch(() => {});

// Offered once at startup. Declining deletes it, so the prompt can't nag.
async function offerRecovery() {
  if (!window.api?.recoveryCheck) return;
  let meta = null;
  try { meta = await window.api.recoveryCheck(); } catch { return; }
  if (!meta) return;

  const when = (meta.savedUtc || '').slice(0, 16).replace('T', ' ');
  const what = [meta.partNumber && `${meta.partNumber} Rev ${meta.partRev || '?'}`,
                `${meta.bubbles} bubble${meta.bubbles === 1 ? '' : 's'}`,
                `${meta.drawings} drawing${meta.drawings === 1 ? '' : 's'}`]
               .filter(Boolean).join(' \u00b7 ');
  const ok = await confirmAction('Recover unsaved work?',
    `Bubbler+ closed with unsaved changes at ${when}.\n${what}\n\n` +
    `Recovering opens that session. Discarding deletes it permanently.`,
    'Recover', { cancelLabel: 'Discard', enterAction: true });

  if (!ok) {
    const sure = await confirmAction('Discard recovered work?',
      'This deletes the recovered session permanently. It cannot be undone.',
      'Discard', { cancelLabel: 'Keep it' });
    if (sure) await clearRecovery();
    return;
  }

  try {
    const bytes = await window.api.recoveryLoad();
    await openInsp(bytes.buffer);
    showApp();
    showDrawing(true);
    // It was never saved to a real file, so keep it dirty and unbound.
    currentPath = null;
    markClean(null, meta.name || 'Recovered');
    markDirty();
  } catch (err) {
    await notify('Could not recover', err.message);
  }
}

// ---------------------------------------------------------------------------
// Launcher
//
// An overlay over the workspace: a live session stays visible behind it, and
// nothing is closed by opening it. It only closes when there is something to
// close onto; on a cold start, Escape and the backdrop do nothing.
// ---------------------------------------------------------------------------
const hasSession = () => docs.length > 0 || sheets.length > 0;
const launcherOpen = () => !$('launchBack').hidden;

function showLauncher() {
  $('library').hidden = true;
  $('launchBack').hidden = false;
  $('lxClose').hidden = !hasSession();
  $('app').hidden = !hasSession();       // the workspace is the backdrop
  renderRecents();
}

function hideLauncher() {
  if (!hasSession()) return;             // nowhere to go; stay put
  $('launchBack').hidden = true;
  showApp();
}

window.showLauncher = showLauncher;      // library.js returns here

$('lxClose').onclick = hideLauncher;
$('launchBack').onclick = e => { if (e.target === $('launchBack')) hideLauncher(); };
$('lxNew').onclick = async () => { if (await confirmDiscard('New')) openModal('new'); };
$('lxOpen').onclick = async () => { if (await confirmDiscard('Open')) pickFile('any'); };
$('lxFind').onclick = () => {
  $('launchBack').hidden = true;
  $('app').hidden = true;
  window.BubblerLibrary?.show();
};

// How the Library opens a package for editing: the same path as a recent or a
// file pick, dirty guard included. Success goes through loadFile(), which takes
// the Library off screen; any other outcome leaves it showing. Returns whether
// the package loaded.
window.openPackageForEdit = async (file, packageId = null) => {
  if (!(await confirmDiscard('Open'))) return false;
  try {
    const read = await window.api.readPackage(file);
    pendingStamp = read.stamp || null;
    await loadFile(file.split(/[\\/]/).pop(), read.bytes.buffer, file);
    return true;
  } catch (err) {
    // The Library never stats on search, so a failed open is where it learns a
    // package has gone.
    if (packageId && /ENOENT|no such file|cannot find/i.test(err.message || '')) {
      await window.api?.indexFlagMissing?.(packageId);
      window.BubblerLibrary?.refresh?.();
    }
    await notify('Could not open the package', err.message);
    return false;
  }
};

window.pickPackageFile = async () => {
  if (await confirmDiscard('Open')) pickFile('any');
};

// openPackageForEdit(), then the inspect rail. Switched after the load, so a
// declined prompt or a bad file leaves the Library as it was.
window.openPackageForInspect = async (file, packageId = null) => {
  if (await window.openPackageForEdit(file, packageId)) setInspectOnly(true);
};

// Home shows the launcher over the workspace. Nothing is closed, so no prompt.
$('railHome').onclick = () => showLauncher();

// Switches the rail only; the package and its edits stay as they are.
$('railMode').onclick = () => setInspectOnly(!inspectOnly);

// Another session took the lock after this one went quiet. Goes read-only and
// says so now, not at save time.
window.api?.onLockLost?.(async () => {
  if (readOnly) return;
  readOnly = true;
  updateTitle();
  await notify('Lost the lock on this package',
    'This session went quiet long enough for another machine to take it over. ' +
    'Save is off; use Save As to keep this work under a new name.');
});

// The sheet renderer, for library.js's Print mode.
window.BubblerSheets = {
  buildPage, paginate, paginateRows, rowsFromSheet, printCss,
  symbolFontDataUri, templateFor, renderSpec, toFont, geomFor, specSource,
  sheetCtx, enablePan, holdCentre, wheelZoom, stampElements, elementsFromManifest, paintElements,
  toWinAnsi
};

// The rail's two shapes: author (Bubbler, Dimensions, Sheets) or inspect
// (Inspect). Home is always there.
let inspectOnly = false;

function applyRailMode() {
  for (const b of document.querySelectorAll('.nav[data-page]')) {
    b.hidden = (b.dataset.page === 'inspect') !== inspectOnly;
  }
  // A record has no package to author, so the swap stays hidden until Open
  // package makes it one (through clearRecordMode()).
  $('railMode').hidden = recordMode;
  $('railFoot').hidden = recordMode;
  // Named for where it goes, not where it is — the rail already shows where it is.
  $('railModeLbl').textContent = inspectOnly ? 'Edit Mode' : 'Inspect Mode';
  $('railMode').title = inspectOnly
    ? 'Back to authoring this package'
    : 'Fill in an inspection against this package';
}

function setInspectOnly(on) {
  inspectOnly = on;
  applyRailMode();
  // Never leave the app parked on a page whose rail button just disappeared.
  if (on) gotoPage('inspect');
  else if (currentPage === 'inspect') gotoPage('bubbler');
}

// Programmatic equivalent of clicking a rail button.
function gotoPage(name) {
  const btn = document.querySelector(`.nav[data-page="${name}"]`);
  if (btn) btn.click();
}

// ---------------------------------------------------------------------------
// Preview panes
//
// One preview toggle per page. Sheets and Inspect share .sh-split, so each
// button finds its own split by walking up from itself.
// ---------------------------------------------------------------------------
function splitOf(id) {
  return $(id)?.closest('.dim-split, .sh-split') || null;
}
const previewOn = id => !splitOf(id)?.classList.contains('no-preview');

function wirePreviewToggle(id, repaint) {
  const btn = $(id), split = splitOf(id);
  if (!btn || !split) return;
  const paint = () => {
    const off = split.classList.contains('no-preview');
    btn.classList.toggle('on', !off);
    btn.title = off ? 'Show the preview' : 'Hide the preview';
  };
  btn.onclick = () => {
    split.classList.toggle('no-preview');
    paint();
    // A canvas or a zoomed page measures zero inside a display:none pane, so the
    // repaint happens on the way back in, never on the way out.
    if (previewOn(id)) repaint();
  };
  paint();
}

wirePreviewToggle('dimPrevToggle', () => renderPreview());
wirePreviewToggle('shPrevToggle', () => renderSheetPreview());
wirePreviewToggle('inspPrevToggle', () => openInspDrawing());

// ---------------------------------------------------------------------------
// Finding the source package
//
// Fetch and Open package both hand the record's drawing hashes and package id
// to the resolver, which checks the index and falls back to walking the share.
// Fetch borrows the drawings; Open package opens the package.
// ---------------------------------------------------------------------------
async function resolveSource(action) {
  if (!window.api?.resolveSource) {
    await notify('Not available', 'This build cannot reach the package search.');
    return null;
  }
  const hashes = (recordDrawings || []).map(d => d.sha256).filter(Boolean);
  if (!hashes.length && !doc.package.id) {
    await notify('Nothing to search on',
      'This record carries no drawing hashes or package id.');
    return null;
  }

  setResolveBusy(true, `Looking for the source package\u2026`);
  let r;
  try {
    r = await window.api.resolveSource({
      // Most precise first: the exact drawing set, then any single drawing.
      drawingSetHash: recordSetHash,
      sha256List: hashes,
      packageId: doc.package.id,
      // Folder names carry the part number, narrowing the walk.
      partNumber: doc.part.number || '',
      customer: doc.part.customerName || ''
    });
  } finally {
    setResolveBusy(false);
  }

  if (r?.ok) return r;

  if (r?.reason === 'not-found') {
    // The share may not hold it — let them point at the file directly.
    const ok = await confirmAction('Package not found',
      `Nothing on the share matches this record's drawings. Locate the .insp yourself?`,
      'Browse');
    if (!ok) return null;
    const picked = await window.api.openFile('insp');
    if (!picked) return null;
    return { ok: true, via: 'manual', entry: { file: picked.path }, manual: picked };
  }
  await notify('Could not search', r?.reason || 'Unknown error');
  return null;
}

function setResolveBusy(on, text) {
  const bar = $('inspSrc');
  if (!bar) return;
  if (on) { bar.dataset.prev = bar.textContent; bar.textContent = text; }
  else if (bar.dataset.prev !== undefined) { bar.textContent = bar.dataset.prev; }
}

async function packageBytes(res) {
  if (res.manual) return res.manual.data.buffer;
  const { bytes } = await window.api.readPackage(res.entry.file);
  return bytes.buffer;
}

// Borrows the source's drawings and bubbles. The record stays open: still no
// saving, nothing written back.
async function fetchBubblePrint() {
  const res = await resolveSource('fetch');
  if (!res) return;
  try {
    const buf = await packageBytes(res);
    // openInsp clears record state, so everything the record owns is held and
    // put back, hashes included, or a second Fetch has nothing to search on.
    const keepIns = inspections, keepId = activeInspId;
    const keepDrawings = recordDrawings, keepHash = recordHash;
    const keepSetHash = recordSetHash;
    await openInsp(buf);              // brings in drawings, bubbles, annotations
    // openInsp left the package's own inspections in place; that copy is the
    // only chance to compare before it is thrown away.
    const pkgIns = inspections.find(i => i.id === keepId) || null;
    inspections = keepIns;            // the record is still what's open
    activeInspId = keepId;
    recordDrawings = keepDrawings;
    recordHash = keepHash;
    recordSetHash = keepSetHash;
    recordMode = true;                // openInsp cleared it; this is still a record
    currentPath = null;
    markClean(null, currentName);
    showApp();
    showDrawing(true);                // openInsp never dismisses the empty state
    setInspectOnly(true);             // openInsp reset the rail to authoring
    renderInspect();                  // picks up the drawings that just arrived
    await noteDivergence(pkgIns, keepHash);
  } catch (err) {
    await notify('Could not load the drawing', err.message);
  }
}

// Opens the source package outright, landing on the matching inspection.
async function openSourcePackage() {
  const res = await resolveSource('open');
  if (!res) return;
  const wantId = activeInsp()?.id || null;
  const exportedHash = recordHash;    // openInsp clears record state below
  try {
    const buf = await packageBytes(res);
    await openInsp(buf);              // clears record mode: this is a real package
    showApp();
    showDrawing(true);
    const match = inspections.find(i => i.id === wantId);
    if (match) activeInspId = match.id;
    markClean(res.entry.file || null, res.manual?.name || fileNameOf(res.entry.file));
    setInspectOnly(true);
    renderInspect();
    if (!match) {
      await notify('Record not in this package',
        'The package opened, but it holds no inspection with this record\u2019s id.');
    } else {
      await noteDivergence(match, exportedHash);
    }
  } catch (err) {
    await notify('Could not open the package', err.message);
  }
}

const fileNameOf = p => String(p || '').split(/[\\/]/).pop() || null;

// Says so, once, when the record's hash differs from the package's copy of the
// same inspection: one side changed since export. Records are never written
// back, so there is nothing to reconcile.
async function noteDivergence(packageIns, exportedHash) {
  if (!exportedHash || !packageIns) return;
  let live;
  try { live = await hashInspection(packageIns); } catch { return; }
  if (live === exportedHash) return;
  await notify('Record and package have diverged',
    'The inspection held in the package no longer matches the record this PDF was ' +
    'exported from. Nothing has been changed either way \u2014 records are snapshots ' +
    'and are never written back. Check both before relying on one.');
}

// ---------------------------------------------------------------------------
// Inspect page wiring
// ---------------------------------------------------------------------------
$('inspFetch').onclick = () => fetchBubblePrint();
$('inspOpenPkg').onclick = () => openSourcePackage();

function inspStem(ins) {
  return [doc.part.number || 'part', ins.sheetName,
          ((ins.bands?.[0]?.columns || [])[0] || [])[0]]
    .filter(Boolean).join('_').replace(/[^\w.-]+/g, '_');
}

// Bytes only; the caller decides where they land. Runs from the Inspect tab's
// Export PDF button and from File > Export….
async function inspPdfBytes(ins) {
  const pages = paginateRows(ins.rows, ins.orientation, ins.stage);
  const holder = document.createElement('div');
  pages.forEach((rows, i) =>
    holder.appendChild(buildPage(inspCtx(ins), rows, i + 1, pages.length)));

  const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>${printCss(await symbolFontDataUri())}</style></head>
    <body>${holder.innerHTML}</body></html>`;

  const bytes = await window.api.printPdf({ html, landscape: ins.orientation === 'landscape' });
  return attachRecord(bytes, ins);           // the file carries its own source
}

// The Inspect tab's Export PDF button.
async function exportInspPdf() {
  const ins = activeInsp();
  if (!ins) return;
  if (!window.api?.printPdf) {
    await notify('Printing unavailable', 'This build cannot reach the print service.');
    return;
  }
  try {
    const bytes = await inspPdfBytes(ins);
    await saveBytes(bytes, `${inspStem(ins)}.pdf`, 'application/pdf',
      [{ name: 'PDF', extensions: ['pdf'] }]);
  } catch (err) {
    await notify('Could not export inspection', err.message);
  }
}

$('inspAdd').onclick = () => {
  if (!sheets.length) {
    notify('No sheets yet', 'An inspection is a filled-in copy of a sheet, so build one first.');
    return;
  }
  popupSections($('inspAdd'), [['Base sheet', sheets.map(x => [x.id, x.name, null, x.name])]],
    'list', null, item => {
      const ins = newInspection(item[0]);
      pushHistory();
      inspections.push(ins);
      noteCreated(`Inspection \u201c${ins.sheetName || 'record'}\u201d`);
      activeInspId = ins.id;
      markDirty();
      renderInspect();
    });
};
// No repaint: the drawing pane beside these doesn't show them.
$('inspJob').oninput = e => { const i = activeInsp(); if (i) { i.jobNumber = e.target.value; markDirty(); } };
$('inspMachine').oninput = e => { const i = activeInsp(); if (i) { i.machine = e.target.value; markDirty(); } };
$('inspPrint').onclick = () => exportInspPdf();
$('inspDoc').onchange = e => { inspDocId = e.target.value; inspPageIdx = 0; renderInspDrawing(); };
$('inspBack').onclick = () => { if (inspPageIdx > 0) { inspPageIdx--; renderInspDrawing(); } };
$('inspFwd').onclick = () => {
  const d = docs.find(x => x.id === inspDocId);
  if (d && inspPageIdx < d.numPages - 1) { inspPageIdx++; renderInspDrawing(); }
};
$('inspZoom').oninput = e => {
  inspHold = inspHold || holdCentre($('inspPrevScroll'), $('inspCanvas'));
  inspScale = parseInt(e.target.value, 10) / 100;
  $('inspZoomPct').textContent = `${e.target.value}%`;
  renderInspDrawing();
};

// ---------------------------------------------------------------------------
// Sheets page wiring
// ---------------------------------------------------------------------------
// Rebuilds the whole Sheets page. Runs after any change to a sheet's list or
// settings, and when the page opens.
function renderSheets() {
  renderSheetCards();
  renderSheetRows();
  renderSheetPreview();
}

$('shAdd').onclick = () => {
  const sh = newSheet();
  pushHistory();
  sheets.push(sh);
  noteCreated(`Sheet \u201c${sh.name}\u201d`);
  activeSheetId = sh.id;
  markDirty();
  renderSheets();
};
$('shName').oninput = e => { const s = activeSheet(); if (s) { s.name = e.target.value; markDirty(); renderSheetCards(); } };
$('shStage').onchange = e => { const s = activeSheet(); if (s) { s.stage = e.target.value; markDirty(); renderSheets(); } };
$('shOrient').onchange = e => { const s = activeSheet(); if (s) { s.orientation = e.target.value; markDirty(); renderSheetPreview(); } };
$('shAuthor').oninput = e => { const s = activeSheet(); if (s) { s.author = e.target.value; markDirty(); renderSheetPreview(); } };
$('shEdited').oninput = e => { const s = activeSheet(); if (s) { s.editDate = e.target.value; markDirty(); renderSheetPreview(); } };
$('shUnits').onchange = e => {
  const s = activeSheet();
  if (!s) return;
  pushHistory();
  s.units = e.target.value === 'mm' ? 'mm' : 'in';
  markDirty();
  renderSheets();
};

$('shInvert').onclick = () => {
  const s = activeSheet();
  if (s) setIncludes(s, it => !it.include);
};

$('shAllNone').onclick = () => {
  const s = activeSheet();
  if (!s) return;
  const chars = s.items.filter(i => i.type === 'characteristic');
  const all = chars.every(i => i.include);
  setIncludes(s, () => !all);
};

// Copies a sheet, overrides included, with its inclusions inverted: the usual
// pair is an in-process sheet and a final sheet for everything it left out.
function duplicateSheet(src) {
  if (!src) return;
  pushHistory();
  const copy = {
    ...structuredClone(src),
    id: `sht_${uid++}`,
    name: `${src.name} (inverted)`,
    createdUtc: new Date().toISOString()
  };
  for (const g of sheetGroups(copy)) {
    if (g.kind !== 'char') continue;
    g.item.include = !g.item.include;
    for (const sub of g.subs) sub.include = g.item.include;
  }
  sheets.splice(sheets.indexOf(src) + 1, 0, copy);
  noteCreated(`Sheet \u201c${copy.name}\u201d`);
  activeSheetId = copy.id;
  markDirty();
  renderSheets();
}

$('shPrint').onclick = () => exportSheetPdf();
$('shZoom').oninput = e => {
  const hold = holdCentre($('shPrevScroll'), $('shPaper'));
  shZoom = +e.target.value / 100;
  $('shZoomPct').textContent = `${e.target.value}%`;
  $('shPaper').style.zoom = shZoom;
  hold();                     // gBCR flushes layout, so the new size is already up
};

// ---------------------------------------------------------------------------
// Renumber
//
// Shifts every bubble at or above a threshold by a signed amount: close a gap
// (4 and above, -2) or open one (3 and above, +1). Sheets reference
// characteristics by element id, not number, so no sheet changes. One undo step.
// ---------------------------------------------------------------------------
function renumberPreview(from, by) {
  const nums = elements.filter(e => e.type === 'bubble').map(e => e.n).sort((a, b) => a - b);
  const moved = nums.filter(n => n >= from);
  if (!moved.length) return { moved: [], after: nums, problem: `No bubble is numbered ${from} or above.` };
  const after = nums.map(n => n >= from ? n + by : n).sort((a, b) => a - b);
  let problem = null;
  if (after.some(n => n < 1)) {
    problem = 'That would push a bubble below 1.';
  } else {
    // Two bubbles sharing a number is the one outcome this must refuse.
    const dupes = [...new Set(after.filter((n, i) => after.indexOf(n) !== i))];
    if (dupes.length) problem = `That would give two bubbles the same number: ${dupes.join(', ')}.`;
  }
  return { moved, after, problem };
}

$('renumber').onclick = async () => {
  const bubbles = elements.filter(e => e.type === 'bubble');
  if (!bubbles.length) {
    await notify('Nothing to renumber', 'This package has no bubbles yet.');
    return;
  }
  const highest = Math.max(...bubbles.map(e => e.n));

  // A collision or a number below 1 reopens the dialog saying why, with what
  // was typed.
  const refCount = elements.filter(e => e.type === 'refbubble').length;
  let from = 1, dir = 'down', amount = 1, carryRefs = false, problem = null;
  for (;;) {
    const { button, values } = await dialog({
      title: 'Shift bubble numbers',
      body: `Bubbles run 1 to ${highest}. Every bubble at or above the ` +
            `threshold moves; the rest stay where they are.`,
      fields: [
        { key: 'from', label: 'At or above #', type: 'number', min: 1, value: from, width: '90px' },
        { key: 'dir', label: 'Direction', type: 'select', value: dir,
          options: [{ value: 'down', label: 'Down' }, { value: 'up', label: 'Up' }],
          hint: 'Down closes a gap left by deleting. Up opens one to insert into.' },
        { key: 'amount', label: 'By', type: 'number', min: 1, value: amount, width: '90px' },
        // Off by default: reference bubbles hold no link to the number they echo.
        { key: 'refs', label: 'Move reference bubbles too', type: 'checkbox',
          value: carryRefs,
          hint: refCount
            ? `${refCount} reference bubble${refCount === 1 ? '' : 's'} in this package share those numbers.`
            : 'This package has no reference bubbles.' }
      ],
      note: problem,
      noteTone: problem ? 'warn' : null,
      buttons: ['apply', 'cancel'],
      defaultId: 'apply'
    });
    if (button !== 'apply') return;

    from = Math.max(1, Math.round(values.from) || 1);
    dir = values.dir === 'up' ? 'up' : 'down';
    amount = Math.max(1, Math.round(values.amount) || 1);
    carryRefs = !!values.refs;
    const by = dir === 'up' ? amount : -amount;
    ({ problem } = renumberPreview(from, by));
    if (problem) continue;              // reopen showing why, rather than failing silently

    pushHistory();
    for (const e of elements) {
      // Reference bubbles move only when asked, and skip the collision check:
      // several legitimately share one number.
      const move = e.type === 'bubble' || (carryRefs && e.type === 'refbubble');
      if (move && e.n >= from) e.n += by;
    }
    nextNumber = elements.reduce(
      (mx, e) => e.type === 'bubble' ? Math.max(mx, e.n + 1) : mx, 1);
    markDirty();
    syncStage();
    renderDimTable();
    renderSheets();
    return;
  }
};

// ---------------------------------------------------------------------------
// Dimensions preview — a baked, read-only render of the bubbled drawing.
// Plain canvas 2D, no Konva: nothing here is selectable or draggable.
// ---------------------------------------------------------------------------
let prevDocId = null, prevPageIdx = 0, prevScale = 0.7, prevBusy = false, prevQueued = false;
let prevHold = null;          // centre restore owed to the zoom slider, applied once the paint lands

// Draws elements onto a 2D canvas, for both preview panes and the Library.
// Takes the elements as an argument, so the Library can pass manifest-built ones.
function paintElements(ctx, vp, s, on) {
  const toC = (x, y) => {
    const [cx, cy] = vp.convertToViewportPoint(x, y);
    return { x: cx, y: cy };
  };

  const paintOne = el => {
    ctx.save();
    if (isBalloon(el)) {
      const r = radiusOf(el), c = toC(el.x, el.y);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * s, 0, Math.PI * 2);
      if (el.style.fill !== 'none') { ctx.fillStyle = el.style.fill; ctx.fill(); }
      ctx.strokeStyle = el.style.stroke;
      ctx.lineWidth = bubbleStroke(r) * s;
      if (el.type === 'refbubble') ctx.setLineDash(refDash(r).map(v => v * s));
      ctx.stroke();
      ctx.fillStyle = el.style.stroke;
      ctx.font = `${bubbleFont(r) * s}px Helvetica, Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(el.n), c.x, c.y);
    } else if (el.type === 'rect') {
      const tl = toC(el.x, el.y + el.h), br = toC(el.x + el.w, el.y);
      ctx.beginPath();
      ctx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      if (el.style.fill !== 'none') { ctx.fillStyle = el.style.fill; ctx.fill(); }
      ctx.strokeStyle = el.style.stroke;
      ctx.lineWidth = el.style.strokeWidth * s;
      ctx.stroke();
    } else if (el.type === 'line') {
      const a = toC(el.x1, el.y1), b = toC(el.x2, el.y2);
      ctx.beginPath();
      ctx.strokeStyle = el.style.stroke;
      ctx.lineWidth = el.style.strokeWidth * s;
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (el.type === 'text') {
      const st = el.style, px = st.fontSize * s, c = toC(el.x, el.y);
      const lines = String(el.text ?? '').split('\n');
      ctx.font = fontSpec(st, px);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillStyle = st.stroke;
      lines.forEach((line, i) => {
        const y = c.y + i * px * LINE_H;
        ctx.fillText(line, c.x, y);
        if (st.underline && line.length) {
          const w = ctx.measureText(line).width;
          ctx.beginPath();
          ctx.strokeStyle = st.stroke;
          ctx.lineWidth = Math.max(0.4, px * 0.06);
          ctx.moveTo(c.x, y + px * 0.12);
          ctx.lineTo(c.x + w, y + px * 0.12);
          ctx.stroke();
        }
      });
    }
    ctx.restore();
  };

  // Same order as the editor: rectangles under everything, then leaders so
  // bubbles cover their own tails, then the rest.
  for (const el of on) if (underlay(el)) paintOne(el);
  for (const el of on) {
    if (el.type === 'bubble' && el.leader) {
      const a = toC(el.x, el.y), b = toC(el.leader.toX, el.leader.toY);
      ctx.beginPath();
      ctx.strokeStyle = el.style.stroke;
      ctx.lineWidth = bubbleStroke(radiusOf(el)) * s;
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }
  for (const el of on) if (!underlay(el)) paintOne(el);
}

// One page of one drawing onto a canvas, with its bubbles on top. Both preview
// panes use it; `overlay` draws pane-specific extras (the Dimensions find mark).
async function paintDrawingPage(canvas, d, pageIdx, scale, overlay) {
  const page = await d.pdfjs.getPage(pageIdx + 1);
  const vp = page.getViewport({ scale });

  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = `${vp.width}px`;
  canvas.style.height = `${vp.height}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx, viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
  }).promise;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paintElements(ctx, vp, scale,
    elements.filter(e => e.documentId === d.id && e.pdfPage === pageIdx));
  overlay?.(ctx, vp, scale);
}

async function renderPreview() {
  if (!previewOn('dimPrevToggle')) return;
  const canvas = $('prevCanvas');
  const d = docs.find(x => x.id === prevDocId);
  $('prevEmpty').hidden = !!d;
  canvas.hidden = !d;
  if (!d) { $('prevPage').textContent = '— / —'; return; }

  // pdf.js render calls can't overlap on one canvas; coalesce instead of racing.
  if (prevBusy) { prevQueued = true; return; }
  prevBusy = true;
  try {
    prevPageIdx = Math.min(prevPageIdx, d.numPages - 1);
    await paintDrawingPage(canvas, d, prevPageIdx, prevScale, paintFindMark);
    $('prevPage').textContent = `${prevPageIdx + 1} / ${d.numPages}`;
  } finally {
    prevBusy = false;
    // A queued repaint owns the restore, since it decides the final size.
    if (prevQueued) { prevQueued = false; renderPreview(); }
    else if (prevHold) { prevHold(); prevHold = null; }
  }
}

function syncPreviewControls() {
  const sel = $('prevDoc');
  sel.innerHTML = '';
  for (const d of docs) {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.label;
    if (d.id === prevDocId) o.selected = true;
    sel.appendChild(o);
  }
  const pct = Math.round(prevScale * 100);
  $('prevZoom').value = pct;
  $('prevPct').textContent = `${pct}%`;
}

// Called when the Dimensions page opens.
function openPreview() {
  if (!docs.some(d => d.id === prevDocId)) {
    prevDocId = activeDocId || docs[0]?.id || null;
    prevPageIdx = 0;
  }
  syncPreviewControls();
  renderPreview();
}

$('prevDoc').onchange = e => { prevDocId = e.target.value; prevPageIdx = 0; renderPreview(); };
$('prevBack').onclick = () => { if (prevPageIdx > 0) { prevPageIdx--; renderPreview(); } };
$('prevFwd').onclick = () => {
  const d = docs.find(x => x.id === prevDocId);
  if (d && prevPageIdx < d.numPages - 1) { prevPageIdx++; renderPreview(); }
};
$('prevZoom').oninput = e => {
  prevHold = prevHold || holdCentre($('prevScroll'), $('prevCanvas'));
  prevScale = parseInt(e.target.value, 10) / 100;
  $('prevPct').textContent = `${e.target.value}%`;
  renderPreview();
};

// ---------------------------------------------------------------------------
// Auto-Find
//
// Focusing a text field in a Dimensions row brings that row's bubble to the
// middle of the preview, on the right drawing and page, marked. Buttons in the
// cells don't trigger it. A per-session view preference: never marks dirty.
// ---------------------------------------------------------------------------
let autoFind = true;
let findId = null;          // the bubble the preview is pointing at, for the mark

// Glide or jump to the bubble. Starts from the system's reduced-motion setting.
let findGlide = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function paintAutoFind() {
  const btn = $('prevFind'), mo = $('prevMotion');
  if (!btn) return;
  btn.classList.toggle('on', autoFind);
  btn.title = autoFind
    ? 'Auto-Find is on: the preview follows the row being edited'
    : 'Auto-Find: scroll the preview to the bubble for the row being edited';
  if (!mo) return;
  mo.classList.toggle('on', findGlide);
  mo.disabled = !autoFind;
  mo.title = findGlide
    ? 'The preview glides to the bubble. Click for an instant jump.'
    : 'The preview jumps straight to the bubble. Click to glide instead.';
}

$('prevMotion').onclick = () => { findGlide = !findGlide; paintAutoFind(); };

$('prevFind').onclick = () => {
  autoFind = !autoFind;
  paintAutoFind();
  if (!autoFind) { findId = null; renderPreview(); return; }
  // Switching it on acts on an already-focused field at once.
  const a = document.activeElement;
  const tr = a?.closest?.('#dimBody tr[data-el-id]');
  if (tr && a.tagName === 'INPUT' && a.closest('[data-col="tol"]')) findBubble(tr.dataset.elId);
  else renderPreview();
};
paintAutoFind();

// Delegated, since the table is rebuilt wholesale; focusin because focus doesn't
// bubble.
$('dimBody').addEventListener('focusin', e => {
  if (!autoFind) return;
  if (e.target.tagName !== 'INPUT') return;      // not the buttons in the cell
  const tr = e.target.closest('tr[data-el-id]');
  if (tr) findBubble(tr.dataset.elId);
});

async function findBubble(elId) {
  if (!previewOn('dimPrevToggle')) return;       // nothing on screen to scroll
  const el = elements.find(e => e.id === elId && e.type === 'bubble');
  if (!el) return;
  const d = docs.find(x => x.id === el.documentId);
  if (!d) return;                                // its drawing left the package

  findId = el.id;
  prevDocId = el.documentId;
  prevPageIdx = Math.min(Math.max(el.pdfPage || 0, 0), d.numPages - 1);
  syncPreviewControls();
  await renderPreview();

  // The same transform paintElements uses, so the mark and the scroll agree.
  const page = await d.pdfjs.getPage(prevPageIdx + 1);
  const vp = page.getViewport({ scale: prevScale });
  const [cx, cy] = vp.convertToViewportPoint(el.x, el.y);
  centerPreviewOn(cx, cy);
}

// Scrolls the Dimensions preview to centre a point, in CSS pixels from the
// canvas's top-left. The canvas's offset in the scroller is measured, since
// margins and padding centre it.
function centerPreviewOn(cx, cy) {
  const sc = $('prevScroll'), cv = $('prevCanvas');
  if (!sc || !cv || cv.hidden) return;
  const sr = sc.getBoundingClientRect(), cr = cv.getBoundingClientRect();
  sc.scrollTo({
    left: sc.scrollLeft + (cr.left - sr.left) + cx - sc.clientWidth / 2,
    top:  sc.scrollTop  + (cr.top  - sr.top)  + cy - sc.clientHeight / 2,
    behavior: findGlide ? 'smooth' : 'auto'
  });
}

// Marks the found bubble with a translucent SEL-coloured disc, drawn after
// paintElements() so it sits on top. The Dimensions preview's overlay.
function paintFindMark(ctx, vp, s) {
  if (!autoFind || !findId) return;
  const el = elements.find(e => e.id === findId);
  if (!el || el.type !== 'bubble') return;
  if (el.documentId !== prevDocId || el.pdfPage !== prevPageIdx) return;
  const [cx, cy] = vp.convertToViewportPoint(el.x, el.y);
  const r = radiusOf(el) * s;
  ctx.save();
  ctx.globalAlpha = 0.10;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 2.4, 0, Math.PI * 2);
  ctx.fillStyle = SEL;
  ctx.fill();
  ctx.restore();
}

function showPdf(p) {
  readout.textContent = `cursor  pdf(${p.x.toFixed(1)}, ${p.y.toFixed(1)})   scale ${scale}   tool ${tool}`;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Stored Unicode as the standard PDF fonts can draw it. They only encode
// WinAnsi (Windows-1252), and pdf-lib throws on anything else, so the few
// symbols with a readable stand-in get one and the rest become '?'. Used in
// place of toFont() whenever Helvetica, not the symbol font, is stamping.
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const WINANSI_STANDIN = { '⌀': 'Ø', '≤': '<=', '≥': '>=', '\t': ' ' };
function toWinAnsi(t) {
  return [...String(t ?? '')].map(c => {
    const n = c.codePointAt(0);
    if ((n >= 0x20 && n <= 0x7E) || (n >= 0xA0 && n <= 0xFF) || WINANSI_EXTRA.includes(c)) return c;
    return WINANSI_STANDIN[c] ?? '?';
  }).join('');
}

// Cached across exports; the bytes never change.
let symbolFontBytes = null;
async function loadSymbolFont(pdfDoc) {
  try {
    if (!window.api?.readAsset || typeof fontkit === 'undefined') return null;
    if (!symbolFontBytes) symbolFontBytes = await window.api.readAsset('Verisurf.ttf');
    pdfDoc.registerFontkit(fontkit);
    return await pdfDoc.embedFont(symbolFontBytes, { subset: true });
  } catch (err) {
    console.warn('Symbol font unavailable, falling back to Helvetica:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Excel export
//
// The column layout is frozen (EXPORT-FORMAT.md): consumers hard-code positions,
// so columns are APPEND-ONLY and nothing may be reordered or removed. Rows come
// from the same deref() / specSource() / renderSpec() path as the PDF.
// ---------------------------------------------------------------------------

// One row per line of the form, headers interleaved as placed. Subs repeat
// their parent's number, since nothing else ties them to it in a spreadsheet.
function exportRows(sh) {
  const rows = [];
  for (const it of sh.items) {
    if (it.type === 'header') {
      rows.push({ rowType: 'header', number: '', isSub: '', spec: '', method: '',
                  notes: '', headerText: it.text || '', drawing: '', page: '' });
      continue;
    }
    if (!it.include) continue;
    const d = deref(it.ref);
    if (!d) continue;
    const src = specSource(d.c, sh.units);
    const doc = docs.find(x => x.id === d.el.documentId);
    rows.push({
      rowType: 'characteristic',
      number: String(d.num ?? ''),
      isSub: d.isSub ? 'TRUE' : 'FALSE',
      spec: it.override?.spec || (src ? renderSpec(src) : ''),
      method: it.override?.method || d.c.method || '',
      notes: d.c.notes || '',
      headerText: '',
      drawing: doc?.label || doc?.file || '',
      page: String((d.el.pdfPage ?? 0) + 1)
    });
  }
  return rows;
}

// A: provenance. B: reserved, header and all — written as null so the cell is
// not created at all. C onward: one dataset per column, single-value and
// row-wise side by side, ragged by design.
function sheetColumns(sh) {
  const rows = exportRows(sh);
  const per = f => rows.map(f);
  const one = v => [String(v ?? '')];
  const part = doc.part || {};

  return [
    { header: 'AppVersion&Schema', values: one(`${APP.version} ${SCHEMA_VERSION}`) },
    { header: null,                values: [] },
    { header: 'PartNumber',         values: one(part.number) },
    { header: 'PartRevision',       values: one(part.revision) },
    { header: 'PartName',           values: one(part.name) },
    { header: 'CustomerName',       values: one(part.customerName) },
    { header: 'CustomerPartNumber', values: one(part.customerPartNumber) },
    { header: 'Material',           values: one(part.material) },
    { header: 'Finish',             values: one(part.finish) },
    { header: 'PackageId',          values: one(doc.package?.id) },
    { header: 'DrawingSetHash',     values: one(doc.package?.drawingSetHash) },
    { header: 'SheetName',          values: one(sh.name) },
    { header: 'Stage',              values: one(sh.stage) },
    { header: 'Units',              values: one(sh.units === 'mm' ? 'mm' : 'in') },
    { header: 'Orientation',        values: one(sh.orientation) },
    { header: 'RowType',      values: per(x => x.rowType) },
    { header: 'Number',       values: per(x => x.number) },
    { header: 'IsSub',        values: per(x => x.isSub) },
    { header: 'Spec',         values: per(x => x.spec) },
    { header: 'Method',       values: per(x => x.method) },
    { header: 'Notes',        values: per(x => x.notes) },
    { header: 'HeaderText',   values: per(x => x.headerText) },
    { header: 'DrawingLabel', values: per(x => x.drawing) },
    { header: 'DrawingPage',  values: per(x => x.page) }
  ];
}

// A checkbox list for dialog(), over anything with an id. The selection is read
// when the dialog resolves.
function pickerNode(items, label) {
  const wrap = document.createElement('div');
  wrap.className = 'pick-list';
  for (const it of items) {
    const row = document.createElement('label');
    row.className = 'pick-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;                      // everything on: unpicking is rarer
    cb.dataset.pickId = it.id;
    const txt = document.createElement('span');
    txt.textContent = label(it);
    row.append(cb, txt);
    wrap.appendChild(row);
  }
  return wrap;
}

const pickedIds = node =>
  [...node.querySelectorAll('input[type=checkbox]')].filter(c => c.checked)
    .map(c => c.dataset.pickId);

// Shows the list, insists on at least one, and returns the chosen objects, or
// null if cancelled. The front half of every multi-pick export.
async function pickMany({ items, label, title, note, empty }) {
  if (!items.length) {
    await dialog({ title: 'Nothing to export', body: empty, buttons: ['ok'] });
    return null;
  }
  const node = pickerNode(items, label);
  const { button } = await dialog({
    title, body: node, note, buttons: ['cancel', 'next'],
    defaultId: 'next', width: '520px'
  });
  if (button !== 'next') return null;

  const ids = new Set(pickedIds(node));
  const chosen = items.filter(it => ids.has(it.id));
  if (!chosen.length) {
    await dialog({ title: 'Nothing selected',
      body: 'Pick at least one before continuing.', buttons: ['ok'] });
    return null;
  }
  return chosen;
}

// Writes every job's PDF into one picked folder. Nothing already there is
// overwritten: a taken name gets " (2)", " (3)"….
async function saveBatch(jobs, kindPlural) {
  if (!window.api?.printPdf) {
    await notify('Printing unavailable', 'This build cannot reach the print service.');
    return;
  }
  const dir = await window.api.pickFolder?.();
  if (!dir) return;

  const written = [], failed = [];
  for (const job of jobs) {
    try {
      const bytes = await job.bytes();
      const name = `${job.stem}.pdf`;
      const saved = await saveBytes(bytes, name, 'application/pdf',
        [{ name: 'PDF', extensions: ['pdf'] }], { filePath: `${dir}/${name}`, noClobber: true });
      written.push(saved.name);
    } catch (err) {
      failed.push(`${job.stem}: ${err.message}`);
    }
  }

  await dialog({
    title: failed.length ? 'Exported with problems' : `Exported ${written.length} ${kindPlural}`,
    tone: failed.length ? 'warn' : 'info',
    body: written.length ? `Written to ${dir}` : 'Nothing was written.',
    note: [...written, ...failed].join('\n'),
    noteTone: failed.length ? 'warn' : undefined,
    buttons: ['ok']
  });
}

async function exportSheetsPdf() {
  const chosen = await pickMany({
    items: sheets,
    label: sh => {
      const n = sh.items.filter(it => it.type !== 'header' && it.include).length;
      return `${sh.name}  —  ${sh.stage}, ${n} characteristic${n === 1 ? '' : 's'}`;
    },
    title: 'Export inspection sheets',
    note: 'One PDF per sheet, written into a folder you choose.',
    empty: 'This package has no inspection sheets yet.'
  });
  if (!chosen) return;
  await saveBatch(
    chosen.map(sh => ({ stem: sheetStem(sh), bytes: () => sheetPdfBytes(sh) })),
    'sheets');
}

async function exportRecordsPdf() {
  const chosen = await pickMany({
    items: inspections,
    label: ins => `${ins.sheetName || 'Record'}  —  ${ins.inspector || 'no inspector'}`
                + `, ${(ins.createdUtc || '').slice(0, 10) || 'undated'}`,
    title: 'Export filled-in records',
    note: 'One PDF per record, each carrying its own source, written into a '
        + 'folder you choose.',
    empty: 'This package has no filled-in records yet.'
  });
  if (!chosen) return;
  await saveBatch(
    chosen.map(ins => ({ stem: inspStem(ins), bytes: () => inspPdfBytes(ins) })),
    'records');
}

async function exportExcel() {
  const chosen = await pickMany({
    items: sheets,
    label: sh => {
      const n = sh.items.filter(it => it.type !== 'header' && it.include).length;
      return `${sh.name}  —  ${sh.stage}, ${n} characteristic${n === 1 ? '' : 's'}`;
    },
    title: 'Export data to workbook',
    note: 'Each sheet is added as a new worksheet of plain text. Nothing already '
        + 'in the workbook is changed, and a name that is already taken gets a '
        + 'numbered suffix rather than replacing what is there.',
    empty: 'This package has no inspection sheets yet.'
  });
  if (!chosen) return;

  const target = await window.api.pickWorkbook();
  if (!target) return;

  const payload = chosen.map(sh => ({ name: sh.name, columns: sheetColumns(sh) }));

  const res = await window.api.appendWorkbook({ file: target.path, sheets: payload });
  if (!res?.ok) {
    await dialog({ title: 'Export failed', tone: 'warn',
      body: `The workbook was not changed.`,
      note: res?.error || 'Unknown error.', noteTone: 'warn', buttons: ['ok'] });
    return;
  }

  // Lists the sheet names actually created: a suffix means the name was taken.
  await dialog({
    title: 'Export complete',
    body: `Added to ${target.name}:`,
    note: res.added.join('\n'),
    buttons: ['ok']
  });
}

// ---------------------------------------------------------------------------
// File > Export…: every export behind one dialog. The per-tab buttons are
// shortcuts for the one in front of you.
// ---------------------------------------------------------------------------
async function exportDialog() {
  const options = [{ value: 'drawing', label: 'Bubbled drawing (PDF)' }];
  if (sheets.length) options.push({ value: 'sheets', label: 'Inspection sheets (PDF)' });
  if (inspections.length) options.push({ value: 'records', label: 'Filled-in records (PDF)' });
  options.push({ value: 'excel', label: 'Excel data (workbook)' });

  const { button, values } = await dialog({
    title: 'Export',
    fields: [{ key: 'what', label: 'Export', type: 'select',
               value: 'drawing', options }],
    buttons: ['cancel', 'next'],
    defaultId: 'next'
  });
  if (button !== 'next') return;

  switch (values.what) {
    case 'drawing': return exportPdf();
    case 'sheets':  return exportSheetsPdf();
    case 'records': return exportRecordsPdf();
    case 'excel':   return exportExcel();
  }
}

// ---------------------------------------------------------------------------
// Element stamping
//
// ONE implementation for the export path here and the Library's print path.
// Anything drawn on a drawing is stamped here.
//
// `fonts` is keyed '' / b / i / bi, embedded in THIS document (pdf-lib fonts
// cannot cross documents), plus `encode`: toFont for the symbol font,
// toWinAnsi for Helvetica.
// ---------------------------------------------------------------------------
function stampElements(pages, els, fonts) {
  const font = fonts[''];
  const stampOne = el => {
    const page = pages[el.pdfPage];
    if (!page) return;
    const stroke = hexToRgb(el.style.stroke);
    const fill = el.style.fill === 'none' ? null : hexToRgb(el.style.fill);
    const sw = el.style.strokeWidth;

    // No MediaBox offset correction — convertToPdfPoint already returns absolute
    // user space, and pdf-lib draws in absolute user space. See README.
    if (isBalloon(el)) {
      const r = radiusOf(el);
      page.drawCircle({
        x: el.x, y: el.y, size: r,
        borderWidth: bubbleStroke(r), borderColor: stroke,
        ...(el.type === 'refbubble' ? { borderDashArray: refDash(r) } : {}),
        ...(fill ? { color: fill } : { opacity: 0 })
      });
      const label = String(el.n);
      const fs = bubbleFont(r);
      const w = font.widthOfTextAtSize(label, fs);
      page.drawText(label, {
        x: el.x - w / 2, y: el.y - fs * 0.35,
        size: fs, font, color: stroke
      });
    } else if (el.type === 'rect') {
      page.drawRectangle({
        x: el.x, y: el.y, width: el.w, height: el.h,
        borderWidth: sw, borderColor: stroke,
        ...(fill ? { color: fill } : { opacity: 0 })
      });
    } else if (el.type === 'line') {
      page.drawLine({
        start: { x: el.x1, y: el.y1 }, end: { x: el.x2, y: el.y2 },
        thickness: sw, color: stroke
      });
    } else if (el.type === 'text') {
      const st = el.style;
      const f = fonts[(st.bold ? 'b' : '') + (st.italic ? 'i' : '')] || fonts[''];
      const size = st.fontSize;
      // Stored Unicode, converted for whichever font is stamping.
      const lines = linesOf(el).map(fonts.encode || toFont);
      const widths = lines.map(l => f.widthOfTextAtSize(l, size));
      const maxW = Math.max(0, ...widths);

      if (fill) {
        const asc = f.heightAtSize(size, { descender: false });
        const desc = f.heightAtSize(size) - asc;
        page.drawRectangle({
          x: el.x - TEXT_PAD,
          y: el.y - desc - (lines.length - 1) * size * LINE_H - TEXT_PAD,
          width: maxW + TEXT_PAD * 2,
          height: asc + desc + (lines.length - 1) * size * LINE_H + TEXT_PAD * 2,
          color: fill
        });
      }

      lines.forEach((line, i) => {
        // el.y IS the baseline — the same anchor Konva drew from.
        const baseline = el.y - (i * size * LINE_H);
        page.drawText(line, { x: el.x, y: baseline, size, font: f, color: stroke });
        if (st.underline && line.length) {
          page.drawLine({
            start: { x: el.x, y: baseline - size * 0.12 },
            end: { x: el.x + widths[i], y: baseline - size * 0.12 },
            thickness: Math.max(0.4, size * 0.06),
            color: stroke
          });
        }
      });
    }
  };

  // The editor's order: rectangles, then every leader, then the rest.
  for (const el of els) if (underlay(el)) stampOne(el);
  for (const el of els) {
    const page = pages[el.pdfPage];
    if (!page || el.type !== 'bubble' || !el.leader) continue;
    page.drawLine({
      start: { x: el.x, y: el.y },
      end: { x: el.leader.toX, y: el.leader.toY },
      thickness: bubbleStroke(radiusOf(el)), color: hexToRgb(el.style.stroke)
    });
  }
  for (const el of els) if (!underlay(el)) stampOne(el);
}

// Rebuilds elements from a manifest for the Library's print path.
// Characteristics carry their bubble under `bubble`; annotations are already
// element-shaped.
function elementsFromManifest(m, docId) {
  const bubbles = (m.characteristics || [])
    .filter(c => c.bubble && c.bubble.documentId === docId)
    .map(c => ({
      type: 'bubble', n: c.number,
      x: c.bubble.x, y: c.bubble.y,
      pdfPage: c.bubble.pdfPage,
      leader: c.bubble.leader || null,
      style: { ...(c.bubble.style || {}), radius: c.bubble.radiusPt }
    }));
  const annos = (m.annotations || []).filter(a => a.documentId === docId);
  return [...bubbles, ...annos];
}

// The bubbled drawing, from File > Export….
async function exportPdf() {
  if (!originalBytes || !activeDocId) {
    await notify('No drawing to export', 'Add a drawing to this package first.');
    return;
  }
  const out = await PDFDocument.load(originalBytes.slice(0));

  // Everything stamps in the symbol font, so annotation text can carry GD&T
  // symbols. Falls back to Helvetica if the font can't be read.
  let font, fonts;
  const vs = await loadSymbolFont(out);
  if (vs) {
    font = vs;
    fonts = { '': vs, b: vs, i: vs, bi: vs, encode: toFont };  // one face
  } else {
    font = await out.embedFont(StandardFonts.Helvetica);
    fonts = {
      '':   font,
      'b':  await out.embedFont(StandardFonts.HelveticaBold),
      'i':  await out.embedFont(StandardFonts.HelveticaOblique),
      'bi': await out.embedFont(StandardFonts.HelveticaBoldOblique),
      encode: toWinAnsi
    };
  }
  const pages = out.getPages();

  // Only the active drawing is stamped — each PDF exports as its own file.
  stampElements(pages, elements.filter(e => e.documentId === activeDocId), fonts);

  const bytes = await out.save();
  const stem = [doc.part.number || 'drawing', doc.part.revision && `Rev${doc.part.revision}`,
                activeDoc()?.label]
    .filter(Boolean).join('_').replace(/[^\w.-]+/g, '_');
  await saveBytes(bytes, `${stem}_bubbled.pdf`, 'application/pdf',
    [{ name: 'PDF', extensions: ['pdf'] }]);
}

// ---------------------------------------------------------------------------
// Screens, modal, navigation
// ---------------------------------------------------------------------------
function showApp() {
  $('launchBack').hidden = true;
  $('library').hidden = true;
  $('app').hidden = false;
}

// ---------------------------------------------------------------------------
// Recent packages
//
// Paths, not contents: a package that moved fails honestly rather than opening
// a stale copy. Only real .insp paths are remembered.
// ---------------------------------------------------------------------------
async function rememberRecent(file, name) {
  if (!file || !window.api?.recentsAdd) return;
  try {
    await window.api.recentsAdd({
      file,
      name: name || fileNameOf(file) || 'Package',
      part: doc.part.number || '',
      revision: doc.part.revision || '',
      partName: doc.part.name || ''
    });
  } catch { /* the list is a convenience; never block a save on it */ }
}

async function renderRecents() {
  const wrap = $('recents'), list = $('rcList');
  if (!wrap || !list) return;
  if (!window.api?.recentsList) { wrap.hidden = true; return; }

  let items = [];
  try { items = await window.api.recentsList(); } catch { items = []; }
  wrap.hidden = false;
  list.textContent = '';

  if (!items.length) {
    const p = document.createElement('div');
    p.className = 'rc-empty';
    p.textContent = 'Packages you open or save will appear here.';
    list.append(p);
    $('rcClear').disabled = true;
    return;
  }
  $('rcClear').disabled = false;

  for (const it of items) {
    const btn = document.createElement('button');
    btn.className = 'rc-item' + (it.exists ? '' : ' gone');
    btn.title = it.file;

    const top = document.createElement('div');
    top.className = 't';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = [it.part, it.partName].filter(Boolean).join(' \u2014 ') || it.name;
    top.append(name);
    if (it.revision) {
      const rev = document.createElement('span');
      rev.className = 'rev';
      rev.textContent = `Rev ${it.revision}`;
      top.append(rev);
    }

    const path = document.createElement('div');
    path.className = 'path';
    path.textContent = it.file;

    btn.append(top, path);
    btn.onclick = () => openRecent(it);
    list.append(btn);
  }
}

async function openRecent(it) {
  if (!it.exists) {
    const drop = await confirmAction('Package not reachable',
      `${it.file}\n\nThe share may be offline, or the file may have been moved. ` +
      `Remove it from the list?`, 'Remove');
    if (drop) { await window.api.recentsRemove(it.file); renderRecents(); }
    return;
  }
  if (dirty && !(await confirmAction('Discard unsaved changes?',
      'The package currently open has edits that have not been saved.', 'Discard'))) return;
  try {
    const { bytes } = await window.api.readPackage(it.file);
    await loadFile(it.name, bytes.buffer, it.file);
  } catch (err) {
    await notify('Could not open the package', err.message);
    renderRecents();                  // it may have vanished since the list loaded
  }
}

$('rcClear').onclick = async () => {
  if (!(await confirmAction('Clear recent packages?',
    'This only empties the list. No package is deleted.', 'Clear'))) return;
  await window.api.recentsClear();
  renderRecents();
};
function showDrawing(on) { $('stack').hidden = !on;   $('empty').hidden = on; }

function openModal(mode) {
  modalMode = mode;
  docBackup = { ...doc.part };
  if (mode === 'new') {
    doc.part = { number: '', revision: '', name: '', customerName: '',
                 customerPartNumber: '', material: '', finish: '' };
    $('mTitle').textContent = 'New Package';
    $('mSub').textContent = 'Describes the part and revision this package covers.';
    $('mOk').textContent = 'Continue';
  } else {
    $('mTitle').textContent = 'Drawing Info';
    $('mSub').textContent = 'Applies to this package on save.';
    $('mOk').textContent = 'Done';
  }
  syncDocFields();
  $('modal').hidden = false;
  $('dNum').focus();
}

$('mCancel').onclick = () => {
  doc.part = docBackup;                    // discard edits
  syncDocFields();
  $('modal').hidden = true;
  if (modalMode === 'new' && !pdfDoc) showLauncher();
};

$('mOk').onclick = () => {
  $('modal').hidden = true;
  if (modalMode === 'new') { resetDocument(); showApp(); showDrawing(false); }
  else markDirty();
};

// Clears the workspace for a new package, keeping the part details the New
// modal just collected. Runs when the New modal is confirmed.
function resetDocument() {
  clearRecordMode();
  currentPath = null; currentName = null;
  // Nothing carries over from what was open: not read-only, not newerSchema,
  // not its lock.
  readOnly = false;
  newerSchema = null;
  fileStamp = null;
  window.api?.lockRelease?.();
  setDimUnit('in');
  pdfDoc = null; originalBytes = null; viewport = null;
  docs = []; activeDocId = null;
  sheets = []; activeSheetId = null;
  inspections = []; activeInspId = null;
  elements = []; nextNumber = 1; uid = 1; clearSel(); pageIndex = 0;
  undoStack = []; redoStack = []; updateHistoryButtons();
  doc.raw = null;
  doc.package = { id: null, createdUtc: null, createdBy: 'local', author: '', editDate: '',
                  audit: [] };
  clearRecovery();                  // starting over abandons any recovered session
  $('pageLabel').textContent = '— / —';
  renderDocList();
  markDirty();
}

$('modal').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') $('mOk').click();
  if (e.key === 'Escape') $('mCancel').click();
});

// Asks before throwing away unsaved edits. Returns false to abort.
async function confirmDiscard(action) {
  if (!dirty || !docs.length) return true;
  return await confirmAction(
    'Discard unsaved changes?',
    `"${currentName || 'This package'}" has unsaved edits that will be lost.`,
    action);
}

// Main cancels the close and asks; this answers once the user decides.
if (window.api?.onCloseRequest) {
  window.api.onCloseRequest(async () => {
    let proceed = true;
    try {
      // A clean exit — saved, or deliberately discarded — leaves nothing to
      // recover, so the next launch mustn't prompt.
      if (dirty && docs.length) {
        const { button } = await dialog({
          title: 'Save changes before closing?',
          body: `"${currentName || 'This package'}" has unsaved edits.`,
          tone: 'warn',
          // Don't Save sits apart from the other two.
          buttons: ['dontSave', 'cancel', 'save'],
          spread: 1,
          defaultId: 'save'
        });
        if (button === 'save') proceed = await saveInsp();  // false if the save dialog was cancelled
        else if (button === 'dontSave') await clearRecovery();  // discards it too
        else proceed = false;                                // Cancel, Escape, backdrop
      }
    } catch (err) {
      console.error('Close check failed:', err);
      proceed = false;        // never discard work because of a bug in here
    }
    if (proceed && !dirty) await clearRecovery();
    window.api.confirmClose(proceed);
  });
}

// Opens through main's file dialog, or a hidden <input type=file> when running
// in a plain browser.
async function pickFile(intent) {
  try {
    if (window.api?.openFile) {
      const picked = await window.api.openFile(intent);
      if (!picked) return;                       // cancelled
      await loadFile(picked.name, picked.data.buffer, picked.path);
    } else {
      fileInput.accept = intent === 'pdf' ? 'application/pdf' : '.insp,application/pdf';
      fileInput.click();
    }
  } catch (err) {
    await notify('Could not open file', err.message);
  }
}

// Loads an .insp or a PDF. Runs from pickFile(), recents, the Library, and the
// browser file input.
async function loadFile(name, buf, filePath = null) {
  // Everything opens for authoring; loadRecord and the Library's Inspect button
  // switch afterwards. Reset so the last session can't strand this one on a
  // page missing from the rail.
  setInspectOnly(false);
  pendingFork = null;               // belongs to whatever was open before this
  // Whatever was open is let go, lock and all, before anything can fail.
  await window.api?.lockRelease?.();
  readOnly = false;
  fileStamp = pendingStamp;         // set by whoever read the bytes, if anyone
  pendingStamp = null;
  try {
    if (/\.insp$/i.test(name)) {
      const manifest = await openInsp(buf);
      // A refused lock still opens the package, read-only. No lock on a
      // view-only package: this session never saves it, and a lock would block
      // the machines that can.
      if (filePath && !newerSchema) {
        const lock = await window.api?.lockAcquire?.(filePath);
        if (lock && lock.ok === false) {
          readOnly = true;
          const who = lock.by
            ? `${lock.by.user}${lock.by.host ? ' on ' + lock.by.host : ''}`
            : 'another machine';
          await notify('Opened read-only',
            `${who} has this package open. You can view, print and Save As, but ` +
            'Save is off until they close it.');
        }
      }
      markClean(filePath, name);
      await rememberRecent(filePath, name);
      // Re-heals the index for a package moved by hand. Not from an older build,
      // which would drop what the newer one indexes.
      if (!newerSchema) await publishSidecar(filePath, manifest, { onOpen: true });
      showApp();
      showDrawing(true);
      if (newerSchema) await notifyNewerSchema();
      return;
    }

    // A PDF may be an exported record; the attachment tells them apart.
    const rec = await readRecord(buf);
    if (rec) {
      await loadRecord(rec);
      markClean(null, name);
      return;
    }

    await loadPdfBytes(buf, name);
    // A bare PDF is not a package yet — Save must ask where to put it.
    currentPath = null;
    markClean(null, `${name.replace(/\.pdf$/i, '')}.insp`);
    markDirty();
    showApp();
    showDrawing(true);
  } catch (err) {
    await notify(`Could not open ${name}`, err.message);
  }
}


$('loadPdf').onclick = () => pickFile('pdf');

// Left rail page switching. Scoped to [data-page]: Home and the mode swap are
// .nav too, and a bare '.nav' selector would overwrite their handlers.
document.querySelectorAll('.nav[data-page]').forEach(btn => {
  btn.onclick = () => {
    const page = btn.dataset.page;
    currentPage = page;
    document.querySelectorAll('.nav[data-page]').forEach(b => b.classList.toggle('active', b === btn));
    const onBubbler = page === 'bubbler';
    $('toolbar').hidden = !onBubbler;
    $('defaults').hidden = !onBubbler;
    $('viewport').hidden = !onBubbler;
    $('pagebar').hidden = !onBubbler;
    $('panel').hidden = !onBubbler;
    $('app').classList.toggle('no-panel', !onBubbler);   // drop the empty track too
    $('page-dimensions').hidden = page !== 'dimensions';
    $('page-sheets').hidden = page !== 'sheets';
    $('page-inspect').hidden = page !== 'inspect';
    if (page === 'dimensions') { renderDimTable(); openPreview(); }
    if (page === 'sheets') renderSheets();
    if (page === 'inspect') renderInspect();
  };
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
initStage();
applyRailMode();         // authoring shape
// A reload (Ctrl+R) keeps main running, holding whatever lock the old page had.
// Nothing is open at boot, so it's released.
window.api?.lockRelease?.();
loadConfig();
loadLogo();
startAutosave();
showLauncher();
offerRecovery();         // and this may replace it with a recovered session

// Clicks on the grey margin around the stage deselect.
$('viewport').addEventListener('mousedown', e => {
  if (e.target.closest('#stack')) return;     // the stage handles its own clicks
  if (!selCount()) return;
  clearSel();
  syncStage();
});
syncEditor();
syncDefaultsStrip();
updateTitle();
updateHistoryButtons();
syncDocFields();
renderDocList();

// Opening a bare PDF starts a fresh package containing just that drawing.
async function loadPdfBytes(buf, name) {
  clearRecordMode();
  await releaseDocs();
  elements = []; nextNumber = 1; uid = 1; clearSel();
  sheets = []; activeSheetId = null;
  inspections = []; activeInspId = null;
  undoStack = []; redoStack = []; updateHistoryButtons();
  doc.raw = null;
  doc.package = { id: null, createdUtc: null, createdBy: 'local', author: '', editDate: '',
                  audit: [] };
  const d = await addDocument(buf, labelFor(name));
  await setActiveDoc(d.id);
}

// Adds another drawing to the package already open.
async function addDrawing(buf, name) {
  pushHistory();
  const d = await addDocument(buf, labelFor(name));
  await setActiveDoc(d.id);
}

const labelFor = name => (name || 'Drawing').replace(/\.pdf$/i, '');

fileInput.addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  await loadFile(f.name, await f.arrayBuffer());
  fileInput.value = '';                    // allow re-opening the same file
});

$('prev').onclick = async () => {
  if (pdfDoc && pageIndex > 0) { pageIndex--; clearSel(); await renderPage(); }
};
$('next').onclick = async () => {
  if (pdfDoc && pageIndex < pdfDoc.numPages - 1) { pageIndex++; clearSel(); await renderPage(); }
};
let zoomTimer = null;
let zoomHold = null;          // centre restore owed to a render that has not landed
// Sets the canvas zoom. The slider, preset dropdown, % readout and Ctrl+scroll
// all come through here.
async function setZoom(factor, { immediate = false } = {}) {
  // Captured once per burst: renders are coalesced, so the first reading holds
  // until one lands. Whoever applies it clears it.
  zoomHold = zoomHold || holdCentre($('viewport'), $('stack'));
  scale = Math.min(4, Math.max(0.5, factor));
  const pct = Math.round(scale * 100);
  $('zoomSlider').value = pct;
  $('zoomPct').textContent = `${pct}%`;
  const preset = [1, 1.5, 2, 3].includes(scale) ? String(scale) : '';
  $('scale').value = preset;
  if (!pdfDoc) { zoomHold = null; return; }
  // CSS-zooms the last render to the new size until the real one lands. `zoom`,
  // not a transform, so the scroll range grows and the anchor has room. The
  // restore measures fresh, so it runs now and again when the render lands.
  if (renderedScale) {
    $('stack').style.zoom = String(scale / renderedScale);
    zoomHold?.();
  }
  // Slider drags coalesce to the next frame unless `immediate`. A superseded
  // render doesn't settle: the newer one owns the restore.
  const settle = () => { zoomHold?.(); zoomHold = null; };
  if (immediate) { if (await renderPage()) settle(); return; }
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(async () => { if (await renderPage()) settle(); }, 60);
}

$('scale').onchange = e => { if (e.target.value) setZoom(parseFloat(e.target.value), { immediate: true }); };
$('zoomSlider').oninput = e => setZoom(parseInt(e.target.value, 10) / 100);
$('undo').onclick = undo;
$('redo').onclick = redo;

$('addDoc').onclick = async () => {
  if (!window.api?.openFile) { pickFile('pdf'); return; }
  const picked = await window.api.openFile('pdf');
  if (!picked) return;
  try {
    await addDrawing(picked.data.buffer, picked.name);
    showDrawing(true);
  } catch (err) {
    await notify('Could not add drawing', err.message);
  }
};
$('removeDoc').onclick = () => { if (activeDocId) removeDocument(activeDocId); };

// Menu actions, over the preload bridge.
if (window.api?.onMenuAction) {
  window.api.onMenuAction(action => {
    switch (action) {
      case 'new':     confirmDiscard('New').then(ok => ok && openModal('new')); break;
      case 'open':    confirmDiscard('Open').then(ok => ok && pickFile('any')); break;
      case 'save':    saveInsp().catch(err => notify('Could not save', err.message)); break;
      case 'saveas':  saveInsp({ saveAs: true }).catch(err => notify('Could not save', err.message)); break;
      case 'export':  exportDialog(); break;
      // From the menu, or an accelerator nothing in the page handled: with a
      // field focused, it means the field.
      case 'undo':    textField(document.activeElement) ? document.execCommand('undo') : undo(); break;
      case 'redo':    textField(document.activeElement) ? document.execCommand('redo') : redo(); break;
      case 'docinfo': openModal('edit'); break;
      case 'history': historyDialog(); break;
      case 'settings': settingsDialog(); break;
      case 'checkupdate': checkForUpdates({ manual: true }); break;
      case 'clear':
        if (!elements.length) break;
        pushHistory();
        // NOT uid = 1: one counter serves every id family, and drawings, sheets
        // and records survive a clear, so restarting it mints duplicate ids.
        elements = []; nextNumber = 1; clearSel();
        commitStage();
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Updates
//
// Main talks to GitHub; this side decides what's shown. One corner card, three
// states: available (Download), downloaded (Install and restart), and gone.
// Later closes the card for the session.
// ---------------------------------------------------------------------------
const UPDATE_CHECK_DELAY_MS = 2000;   // clear of the recovery prompt, still feels instant
let updateInfo = null;        // the available version, once a check has found one
let updateReady = false;      // bytes are down; the next click installs
let updateBusy = false;

async function checkForUpdates({ manual = false } = {}) {
  if (!window.api?.updateCheck) return;
  if (updateBusy) return;
  if (updateReady) { showUpdateCard(); return; }
  const r = await window.api.updateCheck();
  if (r?.status === 'available') {
    updateInfo = r;
    showUpdateCard();
    return;
  }
  if (!manual) return;        // a launch check says nothing unless there is news
  if (r?.status === 'none') {
    await notify('No update available', `Bubbler+ ${r.version} is the latest version.`);
  } else if (r?.status === 'dev') {
    await notify('Updates are off in development',
      'This copy runs from a dev folder. Updates only apply to an installed Bubbler+.');
  } else {
    await notify('Could not check for updates',
      `${r?.error || 'Unknown error'}\n\nThe app is unaffected; try again later.`);
  }
}

function showUpdateCard() {
  const bar = $('updBar');
  $('updTitle').textContent = updateReady
    ? `Bubbler+ ${updateInfo?.version} is ready to install`
    : `Bubbler+ ${updateInfo?.version} is available`;
  $('updSub').textContent = updateReady
    ? 'Installing closes the app and reopens it.'
    : `You have ${updateInfo?.current || APP.version}.`;
  $('updGo').textContent = updateReady ? 'Install and restart' : 'Download';
  $('updGo').disabled = updateBusy;
  $('updNotes').hidden = !updateInfo?.notes;
  bar.hidden = false;
}

$('updLater').onclick = () => { $('updBar').hidden = true; };

$('updNotes').onclick = () => notify(`What's new in ${updateInfo?.version}`, updateInfo?.notes || '');

$('updGo').onclick = async () => {
  if (updateReady) {
    // Installing quits the app, so it refuses while there is unsaved work.
    if (dirty) {
      await notify('Save first',
        'Installing closes Bubbler+, and this package has unsaved changes. ' +
        'Save (or discard) them, then install.');
      return;
    }
    await window.api?.lockRelease?.();
    const r = await window.api.updateInstall();
    if (!r?.ok) await notify('Could not start the installer', r?.error || 'Unknown error');
    return;
  }
  updateBusy = true;
  $('updGo').disabled = true;
  $('updSub').textContent = 'Downloading\u2026';
  const r = await window.api.updateDownload();
  updateBusy = false;
  if (!r?.ok) {
    $('updSub').textContent = 'Download failed.';
    $('updGo').disabled = false;
    await notify('Could not download the update',
      `${r?.error || 'Unknown error'}\n\nYour work is untouched; try again later.`);
    return;
  }
  updateReady = true;
  showUpdateCard();
};

window.api?.onUpdateProgress?.(p => {
  if (!updateBusy) return;
  const pct = Math.max(0, Math.min(100, Math.round(p?.percent || 0)));
  $('updSub').textContent = `Downloading\u2026 ${pct}%`;
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
// A field with its own undo. Narrower than the key handler's `typing` test:
// Ctrl+Z on a focused checkbox or button still means the package.
const TEXT_TYPES = new Set(['', 'text', 'number', 'search', 'email', 'url', 'tel', 'password']);
function textField(el) {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
}

// V/B/F/R/L/T pick a tool, on the Bubbler page, never while a field has focus.
const TOOL_KEYS = { v: 'select', b: 'bubble', f: 'refbubble', r: 'rect',
                    l: 'line', t: 'text' };

// ---------------------------------------------------------------------------
// Shift borrows the reference tool
//
// Holding Shift with the bubble tool switches to reference bubbles numbered
// after the bubble just placed; releasing it hands the bubble tool back.
// ---------------------------------------------------------------------------
const pickTool = name => document.querySelector(`.tool[data-tool="${name}"]`)?.click();

// One borrow at a time, tagged with why ('shift' or 'rmb'), so releasing one
// can't end the other.
let borrowed = null;

function borrowTool(to, why) {
  if (borrowed || tool === to) return false;
  borrowed = { from: tool, to, why };
  pickTool(to);
  return true;
}

function returnTool(why) {
  if (!borrowed || (why && borrowed.why !== why)) return;
  const b = borrowed;
  borrowed = null;
  // Not if a toolbar pick replaced the borrowed tool mid-hold.
  if (tool === b.to) pickTool(b.from);
}

window.addEventListener('keydown', e => {
  if (e.key !== 'Shift' || e.repeat || borrowed) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;      // Ctrl+Shift+Z and friends
  if (dialogOpen() || launcherOpen() || $('toolbar').hidden) return;
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  if (tool !== 'bubble' || creating) return;           // never mid-drag
  refNumber = Math.max(1, nextNumber - 1);
  borrowTool('refbubble', 'shift');
});

window.addEventListener('keyup', e => { if (e.key === 'Shift') returnTool('shift'); });

// The stage only hears mouseups over it; a release past its edge would leave
// the marquee drawn and select borrowed.
window.addEventListener('mouseup', e => {
  if (e.button !== 2 || !borrowed || borrowed.why !== 'rmb') return;
  if (marquee) {
    const m = marquee;
    marquee = null;
    ghostLayer?.destroyChildren();
    ghostLayer?.draw();
    commitMarquee(m);
  }
  returnTool('rmb');
});
// Alt-tabbing mid-hold never delivers the keyup or mouseup, so any borrow ends.
window.addEventListener('blur', () => { marquee = null; returnTool(); });

// The app's global shortcuts.
window.addEventListener('keydown', e => {
  // A dialog owns the keyboard while it is up: Escape means "dismiss", not
  // "deselect", and Delete must not reach the drawing behind it.
  if (dialogOpen()) return;
  // Same for the launcher overlay: typing 'b' over it must not switch tools.
  if (launcherOpen()) {
    if (e.key === 'Escape') { e.preventDefault(); hideLauncher(); }
    return;
  }
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  const mod = e.ctrlKey || e.metaKey;

  if (!typing && !mod && !e.altKey) {
    const want = TOOL_KEYS[e.key.toLowerCase()];
    if (want && !$('toolbar').hidden) {
      e.preventDefault();
      document.querySelector(`.tool[data-tool="${want}"]`)?.click();
      return;
    }
  }

  if (mod && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
    // A text field keeps its own undo; Chromium handles the key, so the menu
    // accelerator doesn't fire either.
    if (textField(document.activeElement)) return;
    e.preventDefault();
    e.key.toLowerCase() === 'z' && !e.shiftKey ? undo() : redo();
    return;
  }
  if (e.key === 'Escape') { clearSel(); syncStage(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selCount() && !typing) {
    pushHistory();
    elements = elements.filter(el => !isSel(el.id));
    clearSel();
    commitStage();
  }
});

// Must stay below the Updates block: UPDATE_CHECK_DELAY_MS is a const, and
// reading one before its line runs throws.
setTimeout(() => checkForUpdates(), UPDATE_CHECK_DELAY_MS);
