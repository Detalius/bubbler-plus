// Bubbler+ Forms: the form editor, opened by `Bubbler+.exe --forms`.
//
// One spreadsheet-like grid (form-model.js) with a table line; save writes a
// template (TEMPLATE-FORMAT.md) into the data folder's templates/. The preview
// is drawn by sheet-page.js, the same code that prints every sheet, so what
// this shows is what prints.
//
// This page is deliberately not index.html: nothing package-shaped (autosave,
// recovery, locks, the update check) exists here to start by mistake.
import IPI_L from './assets/templates/ipi-landscape.json' with { type: 'json' };
import IPI_P from './assets/templates/ipi-portrait.json' with { type: 'json' };
import MPFA_L from './assets/templates/mpfa-landscape.json' with { type: 'json' };
import MPFA_P from './assets/templates/mpfa-portrait.json' with { type: 'json' };
import FAI_L from './assets/templates/fai-landscape.json' with { type: 'json' };
import FAI_P from './assets/templates/fai-portrait.json' with { type: 'json' };
import FINAL_L from './assets/templates/final-landscape.json' with { type: 'json' };
import FINAL_P from './assets/templates/final-portrait.json' with { type: 'json' };
import SYMBOLS from './assets/symbols.json' with { type: 'json' };
import { validateTemplate, rowsPerPage, bandCount } from './sheet-template.js';
import { buildPage, printCss } from './sheet-page.js';
import * as M from './form-model.js';
import { openWorkbook } from './xlsx-read.js';

const BUILTINS = [IPI_L, IPI_P, MPFA_L, MPFA_P, FAI_L, FAI_P, FINAL_L, FINAL_P];
const BUILTIN_IDS = new Set(BUILTINS.map(t => t.id));
const api = window.api || {};
const $ = id => document.getElementById(id);
const PX = 96;                       // screen pixels per inch at 100%: true size
let zoom = 1.25;                     // the grid's zoom; the preview fits its pane
const ppi = () => PX * zoom;
const clone = o => JSON.parse(JSON.stringify(o));

// Stored Unicode to the symbol font's slots, for the preview's callout column.
const UNI_TO_FONT = {};
for (const group of Object.values(SYMBOLS.groups)) {
  for (const s of group) if (!(s.unicode in UNI_TO_FONT)) UNI_TO_FONT[s.unicode] = s.slot;
}
const toFont = t => [...String(t || '')].map(c => UNI_TO_FONT[c] || c).join('');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let G = M.starterGrid('landscape');
let undoStack = [], redoStack = [];
let dirty = false;
let sel = { ar: 0, ac: 0, fr: 0, fc: 0, kind: 'cells' };    // anchor, focus, and cells/rows/cols
let painting = false, brush = null;
let units = 'in';
let shopForms = [];                           // [{ file, t, error }]
let logo = null;
let lastCheck = { template: null, problems: [] };
let suggestions = [];                         // from M.suggest(): not painted until accepted
try {
  units = localStorage.getItem('forms.units') === 'mm' ? 'mm' : 'in';
  zoom = +localStorage.getItem('forms.zoom') || zoom;
} catch { /* defaults */ }

const toUnits = v => (units === 'mm' ? +(v * 25.4).toFixed(1) : +v.toFixed(3));
const fromUnits = v => (units === 'mm' ? v / 25.4 : v);

// ---------------------------------------------------------------------------
// Edits and undo. Every change to G goes through edit(), which snapshots first.
// ---------------------------------------------------------------------------
function edit(fn) {
  const before = JSON.stringify(G);
  fn();
  if (JSON.stringify(G) === before) return;
  undoStack.push(before);
  if (undoStack.length > 300) undoStack.shift();
  redoStack = [];
  setDirty(true);
  render();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(G));
  G = JSON.parse(undoStack.pop());
  clampSel();
  setDirty(true);
  render();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(G));
  G = JSON.parse(redoStack.pop());
  clampSel();
  setDirty(true);
  render();
}
function setDirty(v) {
  dirty = v;
  const title = `${dirty ? '• ' : ''}${G.name || 'Untitled form'} — Bubbler+ Forms`;
  document.title = title;
  api.setTitle?.(title);
}

// Replaces the form being edited.
function load(grid) {
  G = grid;
  suggestions = [];
  undoStack = []; redoStack = [];
  sel = { ar: 0, ac: 0, fr: 0, fc: 0, kind: 'cells' };
  setDirty(false);
  render();
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
function clampSel() {
  const R = G.rows.length - 1, C = G.cols.length - 1;
  for (const k of ['ar', 'fr']) sel[k] = Math.max(0, Math.min(sel[k], R));
  for (const k of ['ac', 'fc']) sel[k] = Math.max(0, Math.min(sel[k], C));
}
// The selection as the user made it. A whole row or column (`kind` 'rows' or
// 'cols') stays exactly that, passing through merged cells; a block of cells
// grows to take in any merge it cuts, as in Excel.
const rawBox = () => ({
  r0: Math.min(sel.ar, sel.fr), c0: Math.min(sel.ac, sel.fc),
  r1: Math.max(sel.ar, sel.fr), c1: Math.max(sel.ac, sel.fc)
});
const isBand = () => sel.kind === 'cols' || sel.kind === 'rows';
const grownBox = () => { const b = rawBox(); return M.growToMerges(G, b.r0, b.c0, b.r1, b.c1); };
const selBox = () => (isBand() ? rawBox() : grownBox());

// Every cell the selection touches, once each, by its top-left corner.
function selOrigins() {
  const b = selBox(), seen = new Set(), out = [];
  for (let r = b.r0; r <= b.r1; r++) for (let c = b.c0; c <= b.c1; c++) {
    const o = M.originOf(G, r, c);
    const k = `${o.r},${o.c}`;
    if (!seen.has(k)) { seen.add(k); out.push(o); }
  }
  return out;
}
const activeCell = () => {
  const o = M.originOf(G, sel.ar, sel.ac);
  return M.cellAt(G, o.r, o.c) || {};
};

function selectCell(r, c) {
  sel = { ar: r, ac: c, fr: r, fc: c, kind: 'cells' };
  clampSel();
  paintSel();
  scrollToCell(r, c);
}

function scrollToCell(r, c) {
  const o = M.originOf(G, r, c);
  tdAt(o.r, o.c)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
const tdAt = (r, c) => $('grid').querySelector(`td[data-r="${r}"][data-c="${c}"]`);

// Pixel edges of a block of grid rows and columns, inside #gridBox.
function boxRect(b) {
  const g = $('grid');
  const th0 = g.querySelector(`th.colhead[data-c="${b.c0}"]`), th1 = g.querySelector(`th.colhead[data-c="${b.c1}"]`);
  const tr0 = g.querySelector(`tr[data-r="${b.r0}"]`), tr1 = g.querySelector(`tr[data-r="${b.r1}"]`);
  if (!th0 || !th1 || !tr0 || !tr1) return null;
  return {
    left: g.offsetLeft + th0.offsetLeft, right: g.offsetLeft + th1.offsetLeft + th1.offsetWidth,
    top: g.offsetTop + tr0.offsetTop, bottom: g.offsetTop + tr1.offsetTop + tr1.offsetHeight
  };
}

function paintSel() {
  const g = $('grid');
  g.querySelectorAll('.sel, .active, .sel-h').forEach(e => e.classList.remove('sel', 'active', 'sel-h'));
  const b = selBox();
  const band = $('selBand');
  if (isBand()) {
    // Drawn over the grid: lighting the cells would light a whole title merge.
    const rc = boxRect(b);
    band.hidden = !rc;
    if (rc) Object.assign(band.style, { left: rc.left + 'px', top: rc.top + 'px',
      width: (rc.right - rc.left) + 'px', height: (rc.bottom - rc.top) + 'px' });
  } else {
    band.hidden = true;
    for (const td of g.querySelectorAll('td[data-r]')) {
      const r = +td.dataset.r, c = +td.dataset.c;
      if (r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1) td.classList.add('sel');
    }
    const a = M.originOf(G, sel.ar, sel.ac);
    tdAt(a.r, a.c)?.classList.add('active');
  }
  g.querySelectorAll('th.colhead').forEach(th => {
    const c = +th.dataset.c;
    if (c >= b.c0 && c <= b.c1) th.classList.add('sel-h');
  });
  g.querySelectorAll('th.rowhead').forEach(th => {
    const r = +th.dataset.r;
    if (r >= b.r0 && r <= b.r1) th.classList.add('sel-h');
  });
  renderRibbonState();
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------
const colName = c => {
  let s = '';
  for (c += 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + (c - 1) % 26) + s;
  return s;
};
const desClass = des => (!des ? '' : des === 'logo' ? 'logo' : des.startsWith('body.') ? 'body'
  : M.HEADER_FIELDS.some(f => f.key === des) ? 'field' : 'custom');
// Written out, so the CSS audit can see each one is used.
const DES_TD = { logo: 'des-logo', body: 'des-body', field: 'des-field', custom: 'des-custom' };

// A cell's look on screen, from its formatting and the form's default font.
function styleTd(td, inner, cell, height) {
  const size = cell.size ?? G.font.size;
  td.style.fontSize = (size * zoom).toFixed(2) + 'pt';
  td.style.fontFamily = cell.font === 'symbol' ? "'SimpleGeoDim', Arial, sans-serif"
    : `${cell.font || G.font.family}, Arial, sans-serif`;
  if (cell.fill) td.style.background = cell.fill;
  if (cell.bold) td.style.fontWeight = 'bold';
  if (cell.italic) td.style.fontStyle = 'italic';
  if (cell.wrap === false) td.classList.add('nowrap');
  inner.style.height = height + 'px';
  inner.style.display = 'flex';
  inner.style.alignItems = 'center';
  inner.style.overflow = 'hidden';
  inner.style.justifyContent = { center: 'center', right: 'flex-end' }[cell.align] || 'flex-start';
  inner.style.textAlign = cell.align || 'left';
}

function renderGrid() {
  const g = $('grid');
  g.innerHTML = '';
  const dr = M.dataRow(G);
  const cg = document.createElement('colgroup');
  const gut = document.createElement('col');
  gut.style.width = '46px';
  cg.appendChild(gut);
  for (const w of G.cols) {
    const col = document.createElement('col');
    col.style.width = (w * ppi()).toFixed(2) + 'px';
    cg.appendChild(col);
  }
  g.appendChild(cg);
  // Stated, not left to the cells: a fixed-layout table with no width lets
  // wide content push a column past the width it was given. Text clips instead,
  // as the print does.
  g.style.width = (46 + G.cols.reduce((a, w) => a + w * ppi(), 0)).toFixed(2) + 'px';

  const head = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'corner';
  head.appendChild(corner);
  G.cols.forEach((_, c) => {
    const th = document.createElement('th');
    th.className = 'colhead';
    th.dataset.c = c;
    th.textContent = colName(c);
    const rz = document.createElement('span');
    rz.className = 'rz';
    rz.dataset.c = c;
    th.appendChild(rz);
    head.appendChild(th);
  });
  g.appendChild(head);

  const run = M.checkRun(G);
  G.rows.forEach((h, r) => {
    const tr = document.createElement('tr');
    tr.dataset.r = r;
    tr.className = r < G.table ? 'hdr' : r < dr ? 'head' : r === dr ? 'data' : 'extra';
    tr.style.height = (h * ppi()).toFixed(2) + 'px';
    const th = document.createElement('th');
    th.className = 'rowhead';
    th.dataset.r = r;
    th.textContent = r === dr ? `${r + 1} ↻` : String(r + 1);
    th.title = r < G.table ? 'Header' : r < dr ? 'Table heading'
      : r === dr ? 'The table row: repeats once per characteristic' : 'Below the table: not part of the form';
    const rz = document.createElement('span');
    rz.className = 'rz';
    rz.dataset.r = r;
    th.appendChild(rz);
    tr.appendChild(th);
    for (let c = 0; c < G.cols.length; c++) {
      const o = M.originOf(G, r, c);
      if (o.r !== r || o.c !== c) continue;
      const cell = M.cellAt(G, r, c) || {};
      const td = document.createElement('td');
      td.dataset.r = r;
      td.dataset.c = c;
      if (o.rs > 1) td.rowSpan = o.rs;
      if (o.cs > 1) td.colSpan = o.cs;
      const inner = document.createElement('div');
      const height = M.originOf(G, r, c).rs > 1
        ? G.rows.slice(r, r + o.rs).reduce((a, b) => a + b, 0) * ppi() : h * ppi();
      styleTd(td, inner, cell, height - 2);
      if (run && r >= G.table && r < dr && c >= run.c0 && c < run.c0 + run.n * run.w && (c - run.c0) % run.w === 0 && o.cs < run.w) {
        td.classList.add('chklabel');
      }
      const si = suggestions.findIndex(x => x.r === r && x.c === c);
      if (si >= 0 && !cell.des && !cell.text) {
        td.classList.add('sugg');
        const chip = document.createElement('span');
        chip.className = 'chip sugg';
        chip.dataset.s = si;
        chip.textContent = `${suggestions[si].label}?`;
        chip.title = suggestions[si].field
          ? `Click to add a new field, “${suggestions[si].field.label}”, here`
          : `Click to paint ${suggestions[si].label} here`;
        inner.appendChild(chip);
      }
      if (cell.des) {
        td.classList.add(DES_TD[desClass(cell.des)]);
        const chip = document.createElement('span');
        chip.className = `chip ${desClass(cell.des)}`;
        chip.textContent = M.designationLabel(cell.des, G.fields);
        inner.appendChild(chip);
      } else if (cell.text) {
        inner.textContent = cell.text;
      }
      if (run && r === dr && c === run.c0 && run.n > 1) {
        const rep = document.createElement('span');
        rep.className = 'rep';
        rep.textContent = `×${run.n}`;
        td.appendChild(rep);
      }
      td.appendChild(inner);
      tr.appendChild(td);
    }
    g.appendChild(tr);
  });

  // Faded rows showing how the table fills in, when nothing real is below it.
  if (dr === G.rows.length - 1) {
    for (let k = 0; k < 3; k++) {
      const tr = document.createElement('tr');
      tr.className = 'ghost';
      tr.style.height = (G.rows[dr] * ppi()).toFixed(2) + 'px';
      const th = document.createElement('th');
      th.className = 'rowhead';
      th.textContent = '↻';
      th.title = 'Preview: the table row repeats like this';
      tr.appendChild(th);
      for (let c = 0; c < G.cols.length;) {
        const o = M.originOf(G, dr, c);
        const td = document.createElement('td');
        if (o.cs > 1) td.colSpan = o.cs;
        const des = M.cellAt(G, dr, o.c)?.des;
        if (des) td.textContent = M.designationLabel(des, G.fields);
        td.style.fontSize = (7 * zoom).toFixed(2) + 'pt';
        td.style.color = '#888';
        tr.appendChild(td);
        c = o.c + o.cs;
      }
      g.appendChild(tr);
    }
  }
  placeLines();
  paintSel();
}

// The table line and the heading/data divider, over the grid.
function placeLines() {
  const g = $('grid');
  const rowTop = r => {
    const tr = g.querySelector(`tr[data-r="${r}"]`);
    return tr ? g.offsetTop + tr.offsetTop : 0;
  };
  $('tline').style.top = rowTop(G.table) + 'px';
  $('tline').style.width = g.offsetWidth + 'px';
  $('hline').style.top = rowTop(M.dataRow(G)) + 'px';
  $('hline').style.width = g.offsetWidth + 'px';
}

// ---------------------------------------------------------------------------
// Mouse on the grid
// ---------------------------------------------------------------------------
let dragSel = null;              // 'cells' | 'cols' | 'rows'

$('grid').addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const sc = e.target.closest('.chip.sugg');
  if (sc) {
    e.preventDefault();
    const s = suggestions[+sc.dataset.s];
    if (s) { suggestions = suggestions.filter(x => x !== s); edit(() => M.acceptSuggestion(G, s)); }
    return;
  }
  const rz = e.target.closest('.rz');
  if (rz) { startResize(e, rz); return; }
  commitEdit();
  const th = e.target.closest('th');
  if (th?.classList.contains('colhead')) {
    const c = +th.dataset.c;
    if (e.shiftKey && sel.kind === 'cols') { sel.fc = c; } else sel = { ar: 0, ac: c, fr: G.rows.length - 1, fc: c, kind: 'cols' };
    sel.ar = 0; sel.fr = G.rows.length - 1;
    dragSel = 'cols';
    paintSel();
    e.preventDefault();
    return;
  }
  if (th?.classList.contains('rowhead') && th.dataset.r != null) {
    const r = +th.dataset.r;
    if (e.shiftKey && sel.kind === 'rows') { sel.fr = r; } else sel = { ar: r, ac: 0, fr: r, fc: G.cols.length - 1, kind: 'rows' };
    sel.ac = 0; sel.fc = G.cols.length - 1;
    dragSel = 'rows';
    paintSel();
    e.preventDefault();
    return;
  }
  const td = e.target.closest('td[data-r]');
  if (!td) return;
  const r = +td.dataset.r, c = +td.dataset.c;
  if (e.shiftKey) { sel.fr = r; sel.fc = c; sel.kind = 'cells'; } else sel = { ar: r, ac: c, fr: r, fc: c, kind: 'cells' };
  dragSel = 'cells';
  paintSel();
  e.preventDefault();
});

$('grid').addEventListener('mouseover', e => {
  if (!dragSel) return;
  if (dragSel === 'cols') {
    const th = e.target.closest('th.colhead, td[data-c]');
    if (th) { sel.fc = +th.dataset.c; paintSel(); }
  } else if (dragSel === 'rows') {
    const th = e.target.closest('th.rowhead, td[data-r]');
    if (th?.dataset.r != null) { sel.fr = +th.dataset.r; paintSel(); }
  } else {
    const td = e.target.closest('td[data-r]');
    if (td) { sel.fr = +td.dataset.r; sel.fc = +td.dataset.c; paintSel(); }
  }
});

window.addEventListener('mouseup', () => {
  if (!dragSel) return;
  const was = dragSel;
  dragSel = null;
  if (painting && brush != null && was === 'cells') applyBrush();
});

$('grid').addEventListener('dblclick', e => {
  const td = e.target.closest('td[data-r]');
  if (td && !painting) startEdit(false);
});

// Column and row borders: drag to resize, like Excel.
function startResize(e, rz) {
  e.preventDefault();
  e.stopPropagation();
  const isCol = rz.dataset.c != null;
  const i = +(isCol ? rz.dataset.c : rz.dataset.r);
  const before = JSON.stringify(G);
  const start = isCol ? e.clientX : e.clientY;
  const w0 = isCol ? G.cols[i] : G.rows[i];
  // A border dragged inside a selection resizes every selected column (or row).
  const b = rawBox();
  const many = isCol ? (i >= b.c0 && i <= b.c1 && b.c1 > b.c0) : (i >= b.r0 && i <= b.r1 && b.r1 > b.r0);
  const picked = many ? (isCol ? range(b.c0, b.c1) : range(b.r0, b.r1)) : [i];
  // A part of one check column is the same part of all of them.
  const targets = isCol ? [...new Set(picked.flatMap(c => M.checkTwinCols(G, c)))] : picked;
  const move = ev => {
    const d = ((isCol ? ev.clientX : ev.clientY) - start) / ppi();
    const v = Math.max(0.05, +(w0 + d).toFixed(4));
    for (const t of targets) (isCol ? G.cols : G.rows)[t] = v;
    renderGrid();
    showSizeTip(ev, v);
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    hideToast();
    if (isCol) M.fitWidth(G);
    if (JSON.stringify(G) !== before) {
      undoStack.push(before);
      redoStack = [];
      setDirty(true);
      render();
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
const range = (a, z) => Array.from({ length: z - a + 1 }, (_, k) => a + k);
function showSizeTip(_ev, v) {
  toast(`${toUnits(v)} ${units}`, 0);
}

// The table line drags between rows, like Excel's page break.
$('tline').addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  commitEdit();
  const line = $('tline');
  line.classList.add('dragging');
  const g = $('grid');
  const box = $('gridBox').getBoundingClientRect();
  const tops = G.rows.map((_, r) => g.offsetTop + g.querySelector(`tr[data-r="${r}"]`).offsetTop);
  let at = G.table;
  const max = G.rows.length - G.headRows - 1;
  const move = ev => {
    const y = ev.clientY - box.top;
    let best = 1;
    for (let r = 1; r <= max; r++) if (Math.abs(tops[r] - y) < Math.abs(tops[best] - y)) best = r;
    at = best;
    line.style.top = tops[at] + 'px';
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    line.classList.remove('dragging');
    if (at !== G.table) edit(() => M.setTableLine(G, at));
    else placeLines();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

// ---------------------------------------------------------------------------
// Typing into a cell
// ---------------------------------------------------------------------------
let editor = null;               // { r, c, el }

function startEdit(replace, initial = '') {
  if (painting) return;
  commitEdit();
  const o = M.originOf(G, sel.ar, sel.ac);
  const td = tdAt(o.r, o.c);
  if (!td) return;
  const cell = M.cellAt(G, o.r, o.c) || {};
  const el = document.createElement('textarea');
  el.id = 'cellEdit';
  el.spellcheck = false;
  const box = $('gridBox').getBoundingClientRect(), rc = td.getBoundingClientRect();
  Object.assign(el.style, {
    left: (rc.left - box.left) + 'px', top: (rc.top - box.top) + 'px',
    width: Math.max(rc.width, 60) + 'px', height: rc.height + 'px',
    fontSize: ((cell.size ?? G.font.size) * zoom).toFixed(2) + 'pt',
    fontWeight: cell.bold ? 'bold' : 'normal', fontStyle: cell.italic ? 'italic' : 'normal',
    textAlign: cell.align || 'left'
  });
  el.value = replace ? initial : (cell.text ?? '');
  $('gridBox').appendChild(el);
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  editor = { r: o.r, c: o.c, el, start: cell.text ?? '' };
  el.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.altKey) { ev.preventDefault(); commitEdit(); move(ev.shiftKey ? -1 : 1, 0); }
    else if (ev.key === 'Enter' && ev.altKey) {
      ev.preventDefault();
      const p = el.selectionStart;
      el.value = el.value.slice(0, p) + '\n' + el.value.slice(el.selectionEnd);
      el.setSelectionRange(p + 1, p + 1);
    } else if (ev.key === 'Tab') { ev.preventDefault(); commitEdit(); move(0, ev.shiftKey ? -1 : 1); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); }
    ev.stopPropagation();
  });
  el.addEventListener('blur', () => commitEdit());
}

function commitEdit() {
  if (!editor) return;
  const { r, c, el, start } = editor;
  editor = null;
  const v = el.value;
  el.remove();
  if (v !== start) edit(() => M.forEachCheckTwin(G, r, c, (rr, cc) => M.setText(G, rr, cc, v)));
}
function cancelEdit() {
  if (!editor) return;
  // Cleared first: removing the box blurs it, and blur commits.
  const { el } = editor;
  editor = null;
  el.remove();
}

// Moves the active cell by whole cells, stepping over merges.
function move(dr, dc, extend = false) {
  const from = extend ? { r: sel.fr, c: sel.fc } : { r: sel.ar, c: sel.ac };
  const o = M.originOf(G, from.r, from.c);
  let r = from.r, c = from.c;
  if (dr > 0) r = o.r + o.rs;
  if (dr < 0) r = o.r - 1;
  if (dc > 0) c = o.c + o.cs;
  if (dc < 0) c = o.c - 1;
  r = Math.max(0, Math.min(r, G.rows.length - 1));
  c = Math.max(0, Math.min(c, G.cols.length - 1));
  if (extend) { sel.fr = r; sel.fc = c; sel.kind = 'cells'; paintSel(); scrollToCell(r, c); }
  else selectCell(r, c);
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
document.addEventListener('keydown', e => {
  if (!$('dlgBack').hidden) {
    if (e.key === 'Escape') closeDialog(null);
    return;
  }
  if (editor) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const inField = e.target.matches?.('input, select, textarea');
  const k = e.key.toLowerCase();
  if (ctrl && k === 's') { e.preventDefault(); save(e.shiftKey); return; }
  if (inField) return;
  if (ctrl && (k === 'z' && !e.shiftKey)) { e.preventDefault(); undo(); return; }
  if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (ctrl && k === 'b') { e.preventDefault(); toggle('bold'); return; }
  if (ctrl && k === 'i') { e.preventDefault(); toggle('italic'); return; }
  if (ctrl || e.altKey) return;
  switch (e.key) {
    case 'ArrowUp': e.preventDefault(); move(-1, 0, e.shiftKey); return;
    case 'ArrowDown': e.preventDefault(); move(1, 0, e.shiftKey); return;
    case 'ArrowLeft': e.preventDefault(); move(0, -1, e.shiftKey); return;
    case 'ArrowRight': e.preventDefault(); move(0, 1, e.shiftKey); return;
    case 'Tab': e.preventDefault(); move(0, e.shiftKey ? -1 : 1); return;
    case 'Enter': e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); return;
    case 'F2': e.preventDefault(); startEdit(false); return;
    case 'Delete': case 'Backspace': e.preventDefault(); clearSel(); return;
    case 'Escape': if (painting) setPainting(false); return;
  }
  if (e.key.length === 1 && !painting) { e.preventDefault(); startEdit(true, e.key); }
});

function clearSel() {
  edit(() => {
    for (const o of selOrigins()) {
      M.forEachCheckTwin(G, o.r, o.c, (r, c) => { M.setText(G, r, c, ''); M.paint(G, r, c, null); });
    }
  });
}

// ---------------------------------------------------------------------------
// The ribbon
// ---------------------------------------------------------------------------
const SIZES = [5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 10, 11, 12, 14, 16, 18, 20, 24];

function formatSel(props) {
  edit(() => {
    for (const o of selOrigins()) {
      M.forEachCheckTwin(G, o.r, o.c, (r, c) => M.format(G, r, c, r, c, props));
    }
  });
}
function toggle(prop) {
  formatSel({ [prop]: activeCell()[prop] ? null : true });
}

$('bBold').onclick = () => toggle('bold');
$('bItalic').onclick = () => toggle('italic');
$('bWrap').onclick = () => formatSel({ wrap: activeCell().wrap === false ? null : false });
$('bSymbol').onclick = () => formatSel({ font: activeCell().font === 'symbol' ? null : 'symbol' });
$('bLeft').onclick = () => formatSel({ align: null });
$('bCenter').onclick = () => formatSel({ align: 'center' });
$('bRight').onclick = () => formatSel({ align: 'right' });
$('bFillApply').onclick = () => formatSel({ fill: $('bFill').value });
$('bFill').onchange = () => formatSel({ fill: $('bFill').value });
$('bNoFill').onclick = () => formatSel({ fill: null });
$('bSize').onchange = () => {
  const v = +$('bSize').value;
  formatSel({ size: Math.abs(v - G.font.size) < 1e-6 ? null : v });
};
$('bMerge').onclick = () => {
  const b = grownBox();
  if (b.r0 === b.r1 && b.c0 === b.c1) return;
  if (b.r0 < G.table && b.r1 >= G.table) { toast('A merged cell can’t cross the table line.'); return; }
  edit(() => M.merge(G, b.r0, b.c0, b.r1, b.c1));
  sel = { ar: b.r0, ac: b.c0, fr: b.r0, fc: b.c0, kind: 'cells' };
  paintSel();
};
$('bUnmerge').onclick = () => {
  const b = grownBox();
  edit(() => M.unmerge(G, b.r0, b.c0, b.r1, b.c1));
};
$('bInsRow').onclick = () => { hideInsMark(); edit(() => M.insertRows(G, rawBox().r0, 1)); };
$('bDelRow').onclick = () => {
  const b = rawBox();
  if (b.r1 - b.r0 + 1 >= G.rows.length) { toast('A form needs at least some rows.'); return; }
  edit(() => M.deleteRows(G, b.r0, b.r1 - b.r0 + 1));
  clampSel();
};
$('bInsCol').onclick = () => { hideInsMark(); const c = rawBox().c0; edit(() => { M.insertCols(G, c, 1); M.fitWidth(G); }); };
$('bDelCol').onclick = () => {
  const b = rawBox();
  if (b.c1 - b.c0 + 1 >= G.cols.length) { toast('A form needs at least one column.'); return; }
  edit(() => M.deleteCols(G, b.c0, b.c1 - b.c0 + 1));
  clampSel();
};
// While hovering + Row or + Col, a bar shows where the new one goes.
function showInsMark(kind) {
  const b = rawBox(), g = $('grid'), m = $('insMark');
  const rc = boxRect({ r0: kind === 'row' ? b.r0 : 0, c0: kind === 'col' ? b.c0 : 0,
    r1: kind === 'row' ? b.r0 : G.rows.length - 1, c1: kind === 'col' ? b.c0 : G.cols.length - 1 });
  if (!rc) return;
  Object.assign(m.style, kind === 'row'
    ? { left: (g.offsetLeft) + 'px', top: (rc.top - 2) + 'px', width: g.offsetWidth + 'px', height: '4px' }
    : { left: (rc.left - 2) + 'px', top: g.offsetTop + 'px', width: '4px', height: g.offsetHeight + 'px' });
  m.hidden = false;
}
function hideInsMark() { $('insMark').hidden = true; }
$('bInsRow').onmouseenter = () => showInsMark('row');
$('bInsCol').onmouseenter = () => showInsMark('col');
$('bInsRow').onmouseleave = hideInsMark;
$('bInsCol').onmouseleave = hideInsMark;

$('bW').onchange = () => {
  const v = fromUnits(+$('bW').value);
  if (!(v >= 0.05)) return renderRibbonState();
  const b = rawBox();
  const cols = [...new Set(range(b.c0, b.c1).flatMap(c => M.checkTwinCols(G, c)))];
  edit(() => { for (const c of cols) G.cols[c] = +v.toFixed(4); M.fitWidth(G); });
};
$('bH').onchange = () => {
  const v = fromUnits(+$('bH').value);
  if (!(v >= 0.05)) return renderRibbonState();
  const b = rawBox();
  edit(() => { for (let r = b.r0; r <= b.r1; r++) G.rows[r] = +v.toFixed(4); });
};
$('tHead').onchange = () => edit(() => M.setHeadRows(G, Math.round(+$('tHead').value || 1)));
$('tChecks').onchange = () => {
  const n = Math.round(+$('tChecks').value);
  if (n >= 1 && n <= 40) edit(() => M.setCheckRepeat(G, n));
  else renderRibbonState();
};
$('tBands').onchange = () => edit(() => { G.bands = $('tBands').value === 'fill' ? 'fill' : 1; });
$('fName').oninput = () => {
  const before = JSON.stringify(G);
  G.name = $('fName').value;
  // Typing a name is one undo step per pause, not per key.
  clearTimeout($('fName')._t);
  $('fName')._t = setTimeout(() => { undoStack.push(before); redoStack = []; }, 0);
  setDirty(true);
  renderChecks();
};
$('pSize').onchange = () => setPage($('pSize').value, $('pOrient').value);
$('pOrient').onchange = () => setPage($('pSize').value === 'custom' ? null : $('pSize').value, $('pOrient').value);
function setPage(size, orient) {
  edit(() => {
    const [w, h] = size ? M.PAGE_SIZES[size] : [...G.page.size].sort((a, b) => a - b);
    G.page.size = orient === 'landscape' ? [h, w] : [w, h];
  });
}
$('pFit').onclick = () => edit(() => M.fitWidth(G, { grow: true }));
$('pTop').onchange = () => {
  const v = fromUnits(+$('pTop').value);
  if (v >= 0) edit(() => { G.page.marginTop = +v.toFixed(4); });
};
$('pBottom').onchange = () => {
  const v = fromUnits(+$('pBottom').value);
  if (v >= 0) edit(() => { G.page.marginBottom = +v.toFixed(4); });
};
$('pUnits').onchange = () => {
  units = $('pUnits').value === 'mm' ? 'mm' : 'in';
  try { localStorage.setItem('forms.units', units); } catch { /* per-viewer only */ }
  renderRibbonState();
};
$('bPaint').onclick = () => setPainting(!painting);
$('saveBtn').onclick = () => save(false);
$('sample').onchange = () => renderPreview();
$('pvZoom').onchange = () => {
  try { localStorage.setItem('forms.pvZoom', $('pvZoom').value); } catch { /* per-viewer only */ }
  renderPreview();
};
try {
  const pz = localStorage.getItem('forms.pvZoom');
  if (pz && [...$('pvZoom').options].some(o => o.value === pz)) $('pvZoom').value = pz;
} catch { /* default: fit */ }
const ZOOMS = [0.75, 1, 1.25, 1.5, 2];
function setZoom(z) {
  zoom = Math.max(0.5, Math.min(3, z));
  try { localStorage.setItem('forms.zoom', String(zoom)); } catch { /* per-viewer only */ }
  commitEdit();
  renderGrid();
  renderRibbonState();
}
$('gZoom').onchange = () => setZoom(+$('gZoom').value);
// Ctrl+wheel zooms the grid, as in Excel.
$('gridWrap').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const i = ZOOMS.findIndex(z => z >= zoom - 1e-6);
  setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + (e.deltaY < 0 ? 1 : -1)))]);
}, { passive: false });

function renderRibbonState() {
  const cell = activeCell();
  $('bBold').classList.toggle('on', !!cell.bold);
  $('bItalic').classList.toggle('on', !!cell.italic);
  $('bWrap').classList.toggle('on', cell.wrap !== false);
  $('bSymbol').classList.toggle('on', cell.font === 'symbol');
  $('bLeft').classList.toggle('on', !cell.align || cell.align === 'left');
  $('bCenter').classList.toggle('on', cell.align === 'center');
  $('bRight').classList.toggle('on', cell.align === 'right');
  const size = cell.size ?? G.font.size;
  const sizes = [...new Set([...SIZES, size])].sort((a, b) => a - b);
  $('bSize').innerHTML = sizes.map(s => `<option value="${s}">${s}</option>`).join('');
  $('bSize').value = String(size);
  $('uCap').textContent = units;
  const step = units === 'mm' ? '0.5' : '0.01';
  for (const id of ['bW', 'bH', 'pTop', 'pBottom']) $(id).step = step;
  $('bW').value = toUnits(G.cols[sel.fc] ?? 0);
  $('bH').value = toUnits(G.rows[sel.fr] ?? 0);
  $('pTop').value = toUnits(G.page.marginTop);
  $('pBottom').value = toUnits(G.page.marginBottom);
  $('pUnits').value = units;
  const [w, h] = G.page.size;
  const sorted = [Math.min(w, h), Math.max(w, h)];
  const named = Object.entries(M.PAGE_SIZES)
    .find(([, s]) => Math.abs(s[0] - sorted[0]) < 0.02 && Math.abs(s[1] - sorted[1]) < 0.02);
  $('pSize').value = named ? named[0] : 'custom';
  $('pOrient').value = w > h ? 'landscape' : 'portrait';
  $('tHead').value = G.headRows;
  const run = M.checkRun(G);
  $('tChecksL').hidden = !run;
  if (run) $('tChecks').value = run.n;
  $('tBands').value = G.bands === 'fill' ? 'fill' : '1';
  if (document.activeElement !== $('fName')) $('fName').value = G.name || '';
  $('bPaint').classList.toggle('on', painting);
  const zs = [...new Set([...ZOOMS, zoom])].sort((a, b) => a - b);
  $('gZoom').innerHTML = zs.map(z => `<option value="${z}">${Math.round(z * 100)}%</option>`).join('');
  $('gZoom').value = String(zoom);
}

// ---------------------------------------------------------------------------
// Designation: painting what cells hold
// ---------------------------------------------------------------------------
function setPainting(on) {
  painting = on;
  if (on) commitEdit();
  document.body.classList.toggle('painting', on);
  $('palette').hidden = !on;
  if (on && !brush) brush = 'part.number';
  renderPalette();
  renderRibbonState();
  requestAnimationFrame(placeLines);
}

function renderPalette() {
  const host = $('brushes');
  host.innerHTML = '';
  const placed = new Set(Object.values(G.cells).map(c => c.des).filter(Boolean));
  const add = (des, label, cls, title) => {
    const b = document.createElement('button');
    b.className = 'brush' + (brush === des ? ' on' : '');
    b.title = title || '';
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = `var(--des-${cls})`;
    const t = document.createElement('span');
    t.textContent = label;
    b.append(sw, t);
    if (placed.has(des)) {
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.textContent = '✓';
      tick.title = 'On the form';
      b.appendChild(tick);
    }
    b.onclick = () => { brush = des; renderPalette(); };
    host.appendChild(b);
  };
  const h3 = text => { const e = document.createElement('h3'); e.textContent = text; host.appendChild(e); };
  h3('Header fields');
  for (const f of M.HEADER_FIELDS) add(f.key, M.designationLabel(f.key, G.fields), 'field');
  add('logo', 'Logo', 'logo', 'The shop logo, scaled to fit');
  const customs = new Set([...Object.keys(G.fields).filter(k => !M.HEADER_FIELDS.some(f => f.key === k)),
    ...[...placed].filter(d => /^(sheet|record)\./.test(d) && !M.HEADER_FIELDS.some(f => f.key === d))]);
  if (customs.size) {
    h3('Your fields');
    for (const k of customs) add(k, M.designationLabel(k, G.fields), 'custom',
      k.startsWith('sheet.') ? 'Filled in once per sheet' : 'Filled in at each inspection');
  }
  const nf = document.createElement('button');
  nf.className = 'brush';
  nf.textContent = '+ New field…';
  nf.onclick = newField;
  host.appendChild(nf);
  h3('Table columns');
  for (const k of M.BODY_KINDS) add(`body.${k.key}`, k.label, 'body');
  h3('');
  const er = document.createElement('button');
  er.className = 'brush' + (brush === '' ? ' on' : '');
  er.textContent = '✕ Eraser';
  er.title = 'Remove what a cell is painted with';
  er.onclick = () => { brush = ''; renderPalette(); };
  host.appendChild(er);
}

function applyBrush() {
  const dr = M.dataRow(G);
  const isBody = brush.startsWith('body.');
  let refused = null;
  edit(() => {
    for (const o of selOrigins()) {
      if (brush === '') { M.forEachCheckTwin(G, o.r, o.c, (r, c) => M.paint(G, r, c, null)); continue; }
      if (isBody && o.r !== dr) {
        refused = `Table columns are painted in row ${dr + 1}, marked ↻, below the table’s heading.`;
        continue;
      }
      if (!isBody && o.r >= G.table) {
        refused = 'Header fields go above the table line.';
        continue;
      }
      M.paint(G, o.r, o.c, brush);
    }
  });
  if (refused) toast(refused);
  renderPalette();
}

async function newField() {
  const r = await dialog(`
    <h2>New field</h2>
    <label class="f" for="nfLabel">What is it called?</label>
    <input id="nfLabel" type="text" placeholder="Heat Lot" spellcheck="false">
    <label class="f">When is it filled in?</label>
    <label class="opt"><input type="radio" name="nfScope" value="record" checked>
      <span>At each inspection<small>On the Inspect page, like Job Number</small></span></label>
    <label class="opt"><input type="radio" name="nfScope" value="sheet">
      <span>Once for the sheet<small>On the Sheets page, like Author</small></span></label>
    <div class="acts"><button data-v="">Cancel</button><button class="primary" data-v="ok">Add field</button></div>`,
    () => $('nfLabel').focus());
  if (r !== 'ok') return;
  const label = $('nfLabel').value.trim();
  if (!label) return;
  const scope = $('dlg').querySelector('input[name=nfScope]:checked')?.value === 'sheet' ? 'sheet' : 'record';
  const taken = new Set([...Object.keys(G.fields), ...Object.values(G.cells).map(c => c.des).filter(Boolean)]);
  const k = M.customKeyFor(label, scope, taken);
  edit(() => { G.fields[k] = label; });
  brush = k;
  renderPalette();
}

// ---------------------------------------------------------------------------
// Problems, checklist and preview
// ---------------------------------------------------------------------------
function renderChecks() {
  lastCheck = M.checkGrid(G);
  const host = $('problems');
  host.innerHTML = '';
  const dr = M.dataRow(G);
  const notes = [];
  if (G.rows.length - 1 > dr) {
    notes.push({ msg: `${G.rows.length - 1 - dr} row(s) below the table aren’t part of the form: the table repeats row ${dr + 1} instead.`, at: [dr + 1, 0], note: true, trim: true });
  }
  if (!lastCheck.problems.length) {
    const ok = document.createElement('div');
    ok.className = 'ok';
    ok.textContent = '✓ Ready to save.';
    host.appendChild(ok);
  }
  for (const p of [...lastCheck.problems, ...notes]) {
    const b = document.createElement('button');
    b.className = 'p' + (p.at ? '' : ' nocell');
    b.textContent = (p.note ? 'ⓘ ' : '⚠ ') + p.msg;
    if (p.note) b.style.color = 'var(--ink-dim)';
    if (p.at) b.onclick = () => selectCell(p.at[0], p.at[1]);
    host.appendChild(b);
    if (p.fix === 'fit') {
      const f = document.createElement('button');
      f.className = 'trim';
      f.textContent = 'Fit to page';
      f.title = 'Shrink the whole form, text and all, to fit the page';
      f.onclick = () => edit(() => M.fitWidth(G));
      host.appendChild(f);
    }
    if (p.fix === 'equalize') {
      const f = document.createElement('button');
      f.className = 'trim';
      f.textContent = 'Make them equal';
      f.title = 'Give every check column the same widths, keeping their total';
      f.onclick = () => edit(() => M.equalizeChecks(G));
      host.appendChild(f);
    }
    if (p.trim) {
      const t = document.createElement('button');
      t.className = 'trim';
      t.textContent = 'Remove them';
      t.onclick = () => edit(() => M.trimBelowTable(G));
      host.appendChild(t);
    }
  }
  $('saveBtn').disabled = !lastCheck.template;
  $('saveBtn').title = lastCheck.template ? 'Save (Ctrl+S)' : 'Fix the problems listed above the grid first';

  // Checklist
  const list = M.checklist(G);
  const cl = $('checklist');
  cl.innerHTML = '';
  const sec = (title, items) => {
    if (!items.length) return;
    const h = document.createElement('h3');
    h.textContent = title;
    cl.appendChild(h);
    for (const it of items) {
      const d = document.createElement('div');
      d.className = `it ${it.placed ? 'yes' : 'no'}${it.required ? ' req' : ''}`;
      const m = document.createElement('span');
      m.className = 'm';
      m.textContent = it.placed ? '✓' : '—';
      const t = document.createElement('span');
      t.textContent = it.label + (it.placed ? '' : it.required ? ' — needed' : ' — not placed');
      d.append(m, t);
      cl.appendChild(d);
    }
  };
  sec('On this form', list.header.filter(i => i.placed));
  sec('Not placed', list.header.filter(i => !i.placed));
  sec('Table', list.table);
}

let shadow = null;
let previewTimer = 0;
function renderPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(drawPreview, 120);
}
function drawPreview() {
  shadow ??= $('prevHost').attachShadow({ mode: 'open' });
  shadow.innerHTML = '';
  const style = document.createElement('style');
  style.textContent = printCss('') +
    '.paper{box-shadow:0 2px 12px rgba(0,0,0,.5);margin:0 auto 14px;background:#fff;color:#000}' +
    '.msg{color:#bbb;font:13px system-ui,sans-serif;padding:20px;text-align:center}';
  shadow.appendChild(style);
  const t = lastCheck.template;
  if (!t) {
    const m = document.createElement('div');
    m.className = 'msg';
    m.textContent = 'The preview appears once the problems listed above the grid are fixed.';
    shadow.appendChild(m);
    return;
  }
  const sample = $('sample').checked;
  const blank = { type: 'characteristic', number: '', spec: '', method: '', bands: [] };
  const rows = sample ? clone(M.SAMPLE_ROWS)
    : Array.from({ length: Math.max(1, rowsPerPage(t)) }, () => ({ ...blank }));
  const chk = t.body.columns.find(c => c.repeat);
  const ctx = {
    template: t,
    bandCount: sample ? bandCount(t, rows.length) : 1,
    bands: sample && chk ? [{ columns: [chk.labels.map((l, i) => ['10/03', 'JS', '20'][i] ?? '')] }] : [],
    bind: sample ? M.sampleBindings(G) : { part: {}, sheet: { custom: {} }, record: { custom: {} } }
  };
  const page = buildPage(ctx, rows, 1, 1, { logo, toFont });
  const avail = $('prevHost').clientWidth - 30;
  const pz = $('pvZoom').value;
  const zoom = pz === 'fit' ? Math.min(1, avail / (t.page.size[0] * PX)) : +pz;
  const wrap = document.createElement('div');
  wrap.style.zoom = zoom;
  wrap.appendChild(page);
  shadow.appendChild(wrap);
}
new ResizeObserver(() => renderPreview()).observe($('prevHost'));

function render() {
  if (editor) cancelEdit();
  clampSel();
  // A suggestion whose cell has since been filled, or has gone, is dropped.
  suggestions = suggestions.filter(x => {
    if (x.r >= G.rows.length || x.c >= G.cols.length) return false;
    const o = M.originOf(G, x.r, x.c);
    const cell = M.cellAt(G, x.r, x.c);
    return o.r === x.r && o.c === x.c && !cell?.text && !cell?.des
      && (x.des?.startsWith('body.') ? x.r === M.dataRow(G) : x.r < G.table);
  });
  renderSuggBar();
  renderGrid();
  renderChecks();
  if (painting) renderPalette();
  renderPreview();
}

// ---------------------------------------------------------------------------
// Dialogs and toasts
// ---------------------------------------------------------------------------
let dialogDone = null;
// Shows `html` and resolves with the clicked button's data-v. Inputs in the
// dialog are read into the result's own properties when it's 'ok'.
function dialog(html, onOpen) {
  $('dlg').innerHTML = html;
  $('dlgBack').hidden = false;
  return new Promise(resolve => {
    dialogDone = resolve;
    $('dlg').querySelectorAll('[data-v]').forEach(b => {
      b.onclick = () => closeDialog(b.dataset.v);
    });
    onOpen?.();
  });
}
function closeDialog(v) {
  if (!dialogDone) return;
  const done = dialogDone;
  dialogDone = null;
  $('dlgBack').hidden = true;
  done(v);
}

let toastTimer = 0;
function toast(msg, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function hideToast() { $('toast').hidden = true; }

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function loadLogo() {
  try {
    logo = null;
    const bytes = await api.readLogo?.();
    if (!bytes) return;
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    logo = 'data:image/png;base64,' + btoa(bin);
  } catch {
    logo = null;
  }
}

render();
setDirty(false);
loadLogo().then(renderPreview);
window.addEventListener('resize', placeLines);

// Exposed for the end-to-end harness, which drives the editor without Electron.
window.__forms = { get G() { return G; }, M, render, load };

// ---------------------------------------------------------------------------
// Forms on this machine, opening, saving
// ---------------------------------------------------------------------------
async function loadShopForms() {
  const files = (await api.listTemplates?.()) || [];
  shopForms = files.map(f => {
    if (f.error) return { file: f.file, error: f.error };
    try {
      const t = JSON.parse(f.text);
      const errs = validateTemplate(t);
      return errs.length ? { file: f.file, error: errs[0], t } : { file: f.file, t };
    } catch (err) {
      return { file: f.file, error: `not valid JSON (${err.message})` };
    }
  });
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

// Asks before throwing away unsaved work.
async function okToDiscard() {
  if (!dirty) return true;
  const r = await dialog(`<h2>Discard your changes?</h2>
    <p>“${esc(G.name)}” has changes that aren’t saved.</p>
    <div class="acts"><button data-v="ok">Discard</button><button class="primary" data-v="">Keep editing</button></div>`);
  return r === 'ok';
}

// The start screen, File > New and File > Open: one list of everything.
async function chooseForm({ title = 'Open a form', intro = '' } = {}) {
  if (!(await okToDiscard())) return;
  await loadShopForms();
  const mine = shopForms.map((f, i) => f.error
    ? `<div class="bad">${esc(f.file)}: ${esc(f.error)}</div>`
    : `<button data-v="shop:${i}">${esc(f.t.name)}<span class="k">${esc(f.file)}</span></button>`).join('');
  const built = BUILTINS.map((t, i) => `<button data-v="builtin:${i}">${esc(t.name)}<span class="k">copy</span></button>`).join('');
  const r = await dialog(`<h2>${esc(title)}</h2>${intro}
    <h3 class="dh">Start fresh</h3>
    <div class="flist">
      <button data-v="new:landscape">New form, landscape</button>
      <button data-v="new:portrait">New form, portrait</button>
      <button data-v="import">Import from Excel…<span class="k">.xlsx</span></button>
    </div>
    <h3 class="dh">This machine’s forms</h3>
    <div class="flist">${mine || '<div class="hint">None yet. Saved forms appear here.</div>'}</div>
    <h3 class="dh">Built-in forms <span class="hint">— open a copy to make your own</span></h3>
    <div class="flist">${built}</div>
    <div class="acts"><button data-v="">Cancel</button></div>`);
  if (!r) return;
  const [kind, arg] = r.split(':');
  if (kind === 'new') load(M.starterGrid(arg));
  else if (kind === 'shop') {
    const f = shopForms[+arg];
    const g = M.templateToGrid(clone(f.t));
    g.file = f.file;
    load(g);
  } else if (kind === 'builtin') {
    const g = M.templateToGrid(clone(BUILTINS[+arg]));
    g.id = null;
    g.name = `${BUILTINS[+arg].name} (copy)`;
    load(g);
    setDirty(true);
  } else if (kind === 'import') {
    importExcel();
  }
}

// An id for a new form, from its name: never a built-in's, never another file's.
function newId(name) {
  const stem = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48) || 'form';
  const taken = new Set([...BUILTIN_IDS, ...shopForms.filter(f => f.t && f.file !== G.file).map(f => f.t.id)]);
  let id = stem;
  for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;
  return id;
}

async function save(asNew = false) {
  commitEdit();
  const { template } = M.checkGrid(G);
  if (!template) { toast('Fix the problems listed above the grid first.'); return; }
  if (!api.saveTemplate) { toast('Saving needs Bubbler+ Forms.'); return; }
  if (!G.name?.trim()) { toast('Give the form a name first.'); $('fName').focus(); return; }
  await loadShopForms();
  if (asNew) { G.file = null; G.id = null; }
  if (!G.id || BUILTIN_IDS.has(G.id)) G.id = newId(G.name);
  template.id = G.id;

  // Saving over a form in use never blocks: records are frozen, and sheets
  // pick the new version up next time they're opened. Say so first.
  if (G.file && api.formUsage) {
    const u = await api.formUsage(G.id).catch(() => null);
    if (u?.sheets || u?.uncounted) {
      const n = u.sheets;
      const head = n === 1 ? '1 existing sheet uses this form'
        : n ? `${n} existing sheets use this form` : 'This form may be in use';
      const more = u.uncounted
        ? `${u.uncounted} older package${u.uncounted === 1 ? ' hasn’t' : 's haven’t'} been counted yet; Settings › Rebuild index counts them.`
        : '';
      const r = await dialog(`<h2>${esc(head)}</h2>
        ${more ? `<p>${esc(more)}</p>` : ''}
        <p>Sheets on this form print with your changes the next time they’re opened. Inspection records already taken keep the form they were filled on.</p>
        <div class="acts"><button data-v="">Cancel</button><button class="primary" data-v="ok">Save</button></div>`);
      if (r !== 'ok') return;
    }
  }
  const text = JSON.stringify(template, null, 2) + '\n';
  const r = await api.saveTemplate({ file: G.file, id: G.id, text });
  if (!r?.ok) { toast(`Could not save: ${r?.error || 'unknown error'}`); return; }
  G.file = r.file;
  setDirty(false);
  await loadShopForms();
  toast(`Saved as ${r.file}. In Bubbler+, Settings › Sheet templates › Reload picks it up.`, 7000);
}

// ---------------------------------------------------------------------------
// Suggestions and Excel import
// ---------------------------------------------------------------------------
function renderSuggBar() {
  const n = suggestions.length;
  $('suggBar').hidden = !n;
  if (n) $('suggText').textContent = `✨ ${n} suggestion${n === 1 ? '' : 's'} from the labels on this form. Click a dashed chip to accept one, or:`;
}
function runSuggest() {
  commitEdit();
  suggestions = M.suggest(G);
  if (!suggestions.length) toast('Nothing to suggest: no unpainted cell sits beside a label it recognises.');
  render();
}
$('bSuggest').onclick = runSuggest;
$('suggAll').onclick = () => {
  const all = suggestions;
  suggestions = [];
  edit(() => { for (const s of all) M.acceptSuggestion(G, s); });
};
$('suggNone').onclick = () => { suggestions = []; render(); };

async function importExcel() {
  if (!api.openFile) { toast('Importing needs Bubbler+ Forms.'); return; }
  const f = await api.openFile('workbook');
  if (!f) return;
  let wb;
  try {
    wb = openWorkbook(new Uint8Array(f.data), window.fflate.unzipSync);
  } catch (err) {
    toast(`Could not read ${f.name}: ${err.message}`, 7000);
    return;
  }
  const visible = wb.sheets.map((name, i) => ({ name, i })).filter(x => !wb.hidden[x.i]);
  if (!visible.length) { toast(`${f.name} has no worksheets to import.`); return; }
  let pick = visible[0];
  if (visible.length > 1) {
    const r = await dialog(`<h2>Which worksheet?</h2><p>${esc(f.name)} has ${visible.length}.</p>
      <div class="flist">${visible.map(x => `<button data-v="${x.i}">${esc(x.name)}</button>`).join('')}</div>
      <div class="acts"><button data-v="">Cancel</button></div>`);
    if (!r) return;
    pick = visible.find(x => x.i === +r);
  }
  let made;
  try {
    const stem = f.name.replace(/\.[^.]+$/, '');
    made = M.gridFromSheet(wb.read(pick.i), visible.length > 1 ? `${stem} – ${pick.name}` : stem);
  } catch (err) {
    toast(`Could not import that worksheet: ${err.message}`, 7000);
    return;
  }
  load(made.G);
  setDirty(true);
  suggestions = M.suggest(G);
  render();
  const scaled = made.scaled < 1 ? ` It was wider than the page, so its columns were narrowed to ${Math.round(made.scaled * 100)}%.` : '';
  toast(`Imported ${pick.name}. Check where the table line sits, then accept the suggestions you want.${scaled}`, 9000);
}

// ---------------------------------------------------------------------------
// Menu, closing, startup
// ---------------------------------------------------------------------------
api.onMenuAction?.(action => {
  const el = document.activeElement;
  const typing = el?.matches?.('input, textarea') && el.id !== 'cellEdit';
  switch (action) {
    case 'new': chooseForm({ title: 'New form' }); break;
    case 'open': chooseForm(); break;
    case 'import': okToDiscard().then(ok => ok && importExcel()); break;
    case 'save': save(false); break;
    case 'saveas': save(true); break;
    case 'folder': api.openTemplatesFolder?.(); break;
    case 'undo': typing ? document.execCommand('undo') : undo(); break;
    case 'redo': typing ? document.execCommand('redo') : redo(); break;
  }
});

api.onCloseRequest?.(async () => {
  commitEdit();
  api.confirmClose(await okToDiscard());
});

// The dialog's main button answers Enter in a text box.
$('dlg').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('input[type=text]')) {
    e.preventDefault();
    $('dlg').querySelector('.primary')?.click();
  }
});

loadShopForms().then(() => {
  if (new URLSearchParams(location.search).has('nostart')) return;
  chooseForm({ title: 'Bubbler+ Forms',
    intro: '<p class="hint">Make your shop’s own inspection forms. Saved forms appear in Bubbler+’s form picker on the Sheets page.</p>' });
});
