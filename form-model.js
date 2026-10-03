// The form editor's model: one spreadsheet-like grid, and the two-way map
// between it and the template format (TEMPLATE-FORMAT.md). Pure functions only,
// so the editor and the tests share one copy.
//
// The format keeps a header (a free grid) and a body (a column pattern) apart;
// nobody builds a form that way. The editor shows ONE grid instead:
//
//   rows 0 .. table-1                 the header, any cells at all
//   rows table .. table+headRows-1    the table's heading block
//   row  table+headRows               the data row: one cell per table column,
//                                     painted with what it holds (Dimension…)
//   anything below                    not part of the form; the table repeats
//                                     the data row instead
//
// The check column appears as many times as it repeats, side by side, the way
// it prints. Each copy is a label part and a box part in the heading rows,
// merged into one cell in the data row.
import { validateTemplate, FORMAT_VERSION } from './sheet-template.js';

const EPS = 5e-4;
const sum = a => a.reduce((s, x) => s + x, 0);
const clone = o => JSON.parse(JSON.stringify(o));
const key = (r, c) => `${r},${c}`;

// What can be painted onto a header cell. `key` is the binding; users only ever
// see `label`. Synonyms drive suggestions: lower case, punctuation stripped.
export const HEADER_FIELDS = [
  { key: 'part.number', label: 'Part Number', syn: ['part number', 'part no', 'part num', 'pn', 'p n', 'part', 'part #', 'item number', 'drawing number', 'dwg no', 'drawing no'] },
  { key: 'part.name', label: 'Part Name', syn: ['part name', 'description', 'part description', 'name'] },
  { key: 'part.revision', label: 'Revision', syn: ['revision', 'rev', 'part revision', 'part rev', 'drawing rev', 'dwg rev', 'rev level'] },
  { key: 'part.customer', label: 'Customer', syn: ['customer', 'customer name', 'client', 'cust'] },
  { key: 'part.customerPartNumber', label: 'Customer Part Number', syn: ['customer part number', 'customer part no', 'customer pn', 'cust pn', 'cust part no', 'customer part'] },
  { key: 'part.material', label: 'Material', syn: ['material', 'matl', 'mat l', 'mat'] },
  { key: 'part.finish', label: 'Finish', syn: ['finish', 'coating', 'plating', 'surface finish'] },
  { key: 'sheet.name', label: 'Sheet Name', syn: ['sheet name', 'sheet'] },
  { key: 'sheet.units', label: 'Units', syn: ['units', 'unit'] },
  { key: 'sheet.author', label: 'Author', syn: ['author', 'last author', 'prepared by', 'created by', 'inspection plan by'] },
  { key: 'sheet.editDate', label: 'Edit Date', syn: ['edit date', 'last edit date', 'date created', 'revised', 'rev date', 'plan date'] },
  { key: 'record.jobNumber', label: 'Job Number', syn: ['job number', 'job no', 'job', 'job #', 'work order', 'wo', 'w o', 'work order number', 'wo number', 'order number', 'lot', 'lot number'] },
  { key: 'record.machine', label: 'Machine', syn: ['machine', 'machine number', 'machine no', 'machine #', 'work center', 'cell', 'equipment'] }
];
export const LOGO = { key: 'logo', label: 'Logo', syn: ['logo'] };

// What can be painted onto the data row: the table's columns.
export const BODY_KINDS = [
  { key: 'number', label: 'Balloon #', syn: ['balloon', 'balloon number', 'balloon no', 'balloon #', 'item', 'item #', 'item no', 'char', 'char no', 'char #', 'ch #', 'characteristic number', 'characteristic #', 'no', 'ref', 'ref no', 'ref #', '#', 'bubble', 'bubble no', 'bubble #', 'feature', 'feature #', 'feature no', 'kc #'] },
  { key: 'spec', label: 'Dimension', syn: ['dimension', 'specification', 'spec', 'dimension specification', 'requirement', 'characteristic', 'nominal', 'dim', 'drawing requirement'] },
  { key: 'method', label: 'Method', syn: ['method', 'inspection method', 'measuring method', 'tool', 'instrument'] },
  { key: 'gage', label: 'Gage ID', syn: ['gage id', 'gauge id', 'gage', 'gauge', 'gage no', 'gauge no', 'equipment id', 'instrument id'] },
  { key: 'notes', label: 'Notes', syn: ['notes', 'note', 'comments', 'remarks'] },
  { key: 'check', label: 'Checks', syn: [] }
];

const FIELD_BY_KEY = new Map([...HEADER_FIELDS, LOGO].map(f => [f.key, f]));
const KIND_BY_KEY = new Map(BODY_KINDS.map(k => [k.key, k]));
// The built-in fields that a template must declare (the rest are always there).
const DECLARED_BUILTINS = new Set(['sheet.author', 'sheet.editDate', 'record.jobNumber', 'record.machine']);

// Look keys a cell may carry, in the format's own names.
const LOOK = ['fill', 'size', 'bold', 'italic', 'align', 'wrap', 'font'];

export const PAGE_SIZES = { letter: [8.5, 11], a4: [8.2677, 11.6929], legal: [8.5, 14] };

// What a painted designation is called on screen.
export function designationLabel(des, fields = {}) {
  if (!des) return '';
  if (des.startsWith('body.')) return KIND_BY_KEY.get(des.slice(5))?.label ?? des;
  if (FIELD_BY_KEY.has(des)) return fields[des] || FIELD_BY_KEY.get(des).label;
  return fields[des] || des.replace(/^(sheet|record)\./, '').replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Grid basics
// ---------------------------------------------------------------------------
export const dataRow = G => G.table + G.headRows;

// The merge covering (r, c), or null.
export function mergeAt(G, r, c) {
  return G.merges.find(m => r >= m.r && r < m.r + m.rs && c >= m.c && c < m.c + m.cs) || null;
}

// The top-left cell of whatever covers (r, c), and its span.
export function originOf(G, r, c) {
  const m = mergeAt(G, r, c);
  return m ? { r: m.r, c: m.c, rs: m.rs, cs: m.cs } : { r, c, rs: 1, cs: 1 };
}

export const cellAt = (G, r, c) => G.cells[key(r, c)] || null;

// Every origin in row `r`, left to right, as {c, cs, rs, r}.
function originsInRow(G, r) {
  const out = [];
  for (let c = 0; c < G.cols.length;) {
    const o = originOf(G, r, c);
    if (o.c === c) out.push(o);
    c = o.c + o.cs;
  }
  return out;
}

const lookOf = (cell, font) => {
  const out = {};
  for (const k of LOOK) {
    if (cell?.[k] == null) continue;
    if (k === 'size' && font && Math.abs(cell.size - font.size) < 1e-6) continue;
    if (k === 'wrap' && cell.wrap !== false) continue;
    if ((k === 'bold' || k === 'italic') && !cell[k]) continue;
    if (k === 'align' && cell.align === 'left') continue;
    out[k] = cell[k];
  }
  return out;
};
const lookKey = look => JSON.stringify(LOOK.filter(k => look[k] != null).map(k => [k, look[k]]));
const isEmptyLook = look => !Object.keys(look).length;

// ---------------------------------------------------------------------------
// A new, blank form
// ---------------------------------------------------------------------------
export function blankGrid(orientation = 'landscape') {
  const [w, h] = PAGE_SIZES.letter;
  const size = orientation === 'landscape' ? [h, w] : [w, h];
  const usable = size[0] - 0.65;
  const n = 8;
  const G = {
    name: 'New form', id: null, file: null, stage: null,
    page: { size, marginTop: 0.25, marginBottom: 0.5 },
    font: { family: 'Arial', size: 8 },
    cols: Array(n).fill(+(usable / n).toFixed(4)),
    rows: [0.25, 0.22, 0.22, 0.22, 0.18, 0.22],
    cells: {}, merges: [],
    table: 4, headRows: 1,
    fields: {}, bands: 1,
    section: { fill: '#ededed', bold: true },
    footer: [{ text: 'Page {page.number} of {page.count}', align: 'left', bottom: 0.13, size: 7.6 }]
  };
  return G;
}

// ---------------------------------------------------------------------------
// Template -> grid
// ---------------------------------------------------------------------------
// Lays the header and the body on the union of their column edges, the same way
// buildPage() draws them, so the grid looks like the print.
export function templateToGrid(t) {
  const styles = t.styles ?? {};
  const look = name => {
    const st = name ? styles[name] : null;
    const out = {};
    if (st) for (const k of LOOK) if (st[k] != null) out[k] = st[k];
    return out;
  };
  const hw = sum(t.header.columns);
  const segs = [];
  for (const c of t.body.columns) {
    if (c.repeat == null) segs.push(c.width);
    else for (let k = 0; k < c.repeat; k++) segs.push(c.labelWidth, c.width - c.labelWidth);
  }
  const bw = sum(segs);
  const W = Math.max(hw, bw);
  const runEdges = (ws, from) => { const e = [from]; for (const w of ws) e.push(e.at(-1) + w); return e; };
  const hE = runEdges(t.header.columns, (W - hw) / 2);
  const bE = runEdges(segs, (W - bw) / 2);
  const edges = [];
  for (const e of [...hE, ...bE].sort((a, b) => a - b)) {
    if (!edges.length || e - edges.at(-1) > EPS) edges.push(e);
  }
  const col = e => edges.findIndex(v => Math.abs(v - e) <= EPS);
  const cols = edges.slice(1).map((e, i) => +(e - edges[i]).toFixed(6));

  const chk = t.body.columns.find(c => c.repeat != null) || null;
  const headRows = chk ? chk.labels.length : 1;
  const table = t.header.rows.length;
  const rows = [...t.header.rows, ...Array(headRows).fill(t.body.labelRowHeight), t.body.rowHeight];

  const G = {
    name: t.name, id: t.id, file: null, stage: t.stage ?? null,
    page: clone(t.page),
    font: t.font ? clone(t.font) : { family: 'Arial', size: 8 },
    cols, rows, cells: {}, merges: [],
    table, headRows,
    fields: {}, bands: t.body.bands,
    section: look(t.body.sectionStyle),
    footer: clone(t.footer ?? [])
  };
  for (const f of t.fields ?? []) G.fields[f.key] = f.label;
  // A label the editor would show anyway isn't worth keeping.
  for (const [k, v] of Object.entries(G.fields)) if (FIELD_BY_KEY.get(k)?.label === v) delete G.fields[k];

  const put = (r, c, rs, cs, cell) => {
    if (rs > 1 || cs > 1) G.merges.push({ r, c, rs, cs });
    if (cell && Object.keys(cell).length) G.cells[key(r, c)] = cell;
  };

  // Header
  for (const hc of t.header.cells) {
    const [r, k] = hc.at, [rs, cs] = hc.span ?? [1, 1];
    const a = col(hE[k]), z = col(hE[k + cs]);
    const cell = look(hc.style);
    if (hc.logo) cell.des = 'logo';
    else if (hc.bind != null) cell.des = hc.bind;
    else if (hc.text != null) {
      // A lone {binding} is a painted field; anything else stays literal text.
      const m = /^\{([^{}]+)\}$/.exec(hc.text.trim());
      if (m) cell.des = m[1].trim(); else cell.text = hc.text;
    }
    put(r, a, rs, z - a, cell);
  }
  // Header cells split by body edges still read as one cell: merge the gaps
  // no template cell covered, so they draw as the blank cells they print as.
  for (let r = 0; r < table; r++) {
    for (let k = 0; k < t.header.columns.length; k++) {
      const a = col(hE[k]), z = col(hE[k + 1]);
      if (z - a > 1 && !mergeAt(G, r, a)) G.merges.push({ r, c: a, rs: 1, cs: z - a });
    }
  }

  // Body: heading block, then the data row.
  const dr = table + headRows;
  let x = (W - bw) / 2;
  t.body.columns.forEach((c, ci) => {
    if (c.repeat == null) {
      const a = col(x), z = col(x + c.width);
      put(dr, a, 1, z - a, { ...look(c.style), des: `body.${c.bind}` });
      if (c.heading != null || !t.body.columns.slice(0, ci).some((p, pi) =>
        p.repeat == null && (p.headingSpan ?? 1) > ci - pi)) {
        const span = c.headingSpan ?? 1;
        const end = x + sum(t.body.columns.slice(ci, ci + span).map(p => p.width));
        const cell = look(t.body.headingStyle);
        if (c.heading != null) cell.text = c.heading;
        put(table, a, headRows, col(end) - a, cell);
      }
      x += c.width;
      return;
    }
    for (let k = 0; k < c.repeat; k++) {
      const a = col(x), m = col(x + c.labelWidth), z = col(x + c.width);
      c.labels.forEach((label, li) => {
        put(table + li, a, 1, m - a, { ...look(c.labelStyle), text: label });
        put(table + li, m, 1, z - m, look(c.headStyle));
      });
      put(dr, a, 1, z - a, { ...look(c.style), des: 'body.check' });
      x += c.width;
    }
  });
  return G;
}

// ---------------------------------------------------------------------------
// Grid -> template
// ---------------------------------------------------------------------------
// Returns { template, problems }. `problems` are the editor's own, each with the
// cell to select ([row, col]) where there is one; `template` is null when the
// grid can't be mapped at all. Run validateTemplate() on the result for the
// format's rules.
export function gridToTemplate(G) {
  const problems = [];
  const bad = (msg, at = null, fix = null) => problems.push(fix ? { msg, at, fix } : { msg, at });
  const C = G.cols.length;
  const dr = dataRow(G);

  if (G.table < 1) bad('The header needs at least one row above the table line.');
  if (dr >= G.rows.length) { bad('The table needs a row below its heading for the columns to repeat.'); return { template: null, problems }; }

  // A merge may not cross the table line, or the line between heading and data row.
  for (const m of G.merges) {
    const end = m.r + m.rs;
    if (m.r < G.table && end > G.table) bad('A merged cell crosses the table line.', [m.r, m.c]);
    else if (m.r < dr && end > dr && m.r >= G.table) bad('A merged cell crosses into the table’s data row.', [m.r, m.c]);
    else if (m.r <= dr && end > dr + 1 && m.r >= G.table) bad('A merged cell in the data row reaches below it.', [m.r, m.c]);
  }
  if (problems.length) return { template: null, problems };

  // ---- styles: direct formatting folded into named looks ----
  const styles = {};
  const byLook = new Map();
  const styleFor = (cell, base) => {
    const look = lookOf(cell, G.font);
    if (isEmptyLook(look)) return undefined;
    const k = lookKey(look);
    if (byLook.has(k)) return byLook.get(k);
    let name = base, n = 2;
    while (styles[name]) name = `${base}${n++}`;
    styles[name] = look;
    byLook.set(k, name);
    return name;
  };

  // ---- the data row: one body column per cell ----
  const segs = originsInRow(G, dr).map(o => ({
    ...o, width: sum(G.cols.slice(o.c, o.c + o.cs)), cell: cellAt(G, dr, o.c)
  }));
  const kindOf = s => (s.cell?.des?.startsWith('body.') ? s.cell.des.slice(5) : null);
  const first = segs.findIndex(kindOf), last = segs.findLastIndex(kindOf);
  if (first < 0) {
    bad('Paint the table’s columns in the row below its heading: at least a Dimension.', [dr, 0]);
    return { template: null, problems };
  }
  const body = segs.slice(first, last + 1);
  for (const s of body) if (!kindOf(s)) bad('This table column isn’t painted with what it holds.', [dr, s.c]);
  if (problems.length) return { template: null, problems };

  // Checks: one run, side by side, all the same.
  const checkIdx = body.map((s, i) => (kindOf(s) === 'check' ? i : -1)).filter(i => i >= 0);
  if (checkIdx.length && checkIdx.at(-1) - checkIdx[0] + 1 !== checkIdx.length) {
    bad('Check columns have to sit side by side.', [dr, body[checkIdx[0]].c]);
  }
  const headRow = li => G.table + li;
  const columns = [];
  let headingStyle, labelStyle, headStyle;
  let i = 0;
  while (i < body.length) {
    const s = body[i];
    const kind = kindOf(s);
    if (kind === 'check') {
      const run = [];
      while (i < body.length && kindOf(body[i]) === 'check') run.push(body[i++]);
      const s0 = run[0];
      if (run.some(r => Math.abs(r.width - s0.width) > EPS)) {
        bad('Check columns have to be the same width.', [dr, run[0].c],
          run.every(r => r.cs === s0.cs) ? 'equalize' : null);
      }
      // The label part: the heading cell that starts at the column's left edge.
      // A heading that fills the whole column (as on most spreadsheets) prints
      // with its label over the left part and a box beside it.
      const lab = originOf(G, headRow(0), s0.c);
      if (lab.c !== s0.c || lab.cs > s0.cs) {
        bad('A check column’s heading has to start at its left edge and stay inside it.', [headRow(0), s0.c]);
        continue;
      }
      const whole = lab.cs === s0.cs;
      const labels = [];
      for (let li = 0; li < G.headRows; li++) {
        const o = originOf(G, headRow(li), s0.c);
        if (o.c !== s0.c || o.cs !== lab.cs || o.rs !== 1) {
          bad('Every heading row of a check column needs its own label.', [headRow(li), s0.c]);
          break;
        }
        labels.push(cellAt(G, o.r, o.c)?.text ?? '');
      }
      const boxCell = whole ? null : cellAt(G, headRow(0), s0.c + lab.cs);
      labelStyle ??= styleFor(cellAt(G, headRow(0), s0.c), 'checkLabel');
      headStyle ??= whole ? styleFor(cellAt(G, headRow(0), s0.c), 'checkValue') : styleFor(boxCell, 'checkValue');
      const col = {
        repeat: run.length, width: +s0.width.toFixed(6),
        labelWidth: +(whole ? s0.width * 0.45 : sum(G.cols.slice(s0.c, s0.c + lab.cs))).toFixed(6),
        labels, bind: 'check'
      };
      const st = styleFor(s0.cell, 'check');
      if (st) col.style = st;
      if (labelStyle) col.labelStyle = labelStyle;
      if (headStyle) col.headStyle = headStyle;
      columns.push(col);
      continue;
    }
    const col = { width: +s.width.toFixed(6), bind: kind };
    const st = styleFor(s.cell, kind);
    if (st) col.style = st;
    // A heading starts at this column's left edge, or this column sits under
    // the heading of one to its left.
    const h = originOf(G, headRow(0), s.c);
    if (h.c === s.c) {
      const hc = cellAt(G, h.r, h.c);
      const end = h.c + h.cs;
      const covered = body.slice(i).filter(b => b.c + b.cs <= end);
      if (body.slice(i).some(b => b.c < end && b.c + b.cs > end)) {
        bad('A table heading has to line up with the columns below it.', [h.r, h.c]);
      } else if (covered.some(b => kindOf(b) === 'check')) {
        bad('A heading can’t reach over the check columns.', [h.r, h.c]);
      }
      if (hc?.text) col.heading = hc.text;
      if (covered.length > 1) col.headingSpan = covered.length;
      headingStyle ??= styleFor(hc, 'heading');
    }
    columns.push(col);
    i++;
  }

  // ---- header ----
  // Column edges no row needs are folded away, so a header laid on the shared
  // edges saves as the header it was.
  const keep = [true];
  for (let k = 1; k < C; k++) {
    let needed = false;
    for (let r = 0; r < G.table && !needed; r++) {
      const m = mergeAt(G, r, k);
      if (!m || m.c === k) needed = true;
    }
    keep.push(needed);
  }
  const hCols = [], toH = [];
  for (let k = 0; k < C; k++) {
    if (keep[k]) hCols.push(0);
    hCols[hCols.length - 1] += G.cols[k];
    toH.push(hCols.length - 1);
  }
  const cells = [];
  const fields = new Map();
  const declare = des => {
    if (DECLARED_BUILTINS.has(des) || /^(sheet|record)\./.test(des) && !FIELD_BY_KEY.has(des)) {
      fields.set(des, G.fields[des] || FIELD_BY_KEY.get(des)?.label || designationLabel(des, G.fields));
    }
  };
  for (let r = 0; r < G.table; r++) {
    for (const o of originsInRow(G, r)) {
      if (o.r !== r) continue;
      const cell = cellAt(G, r, o.c);
      const out = { at: [r, toH[o.c]] };
      const span = [o.rs, toH[o.c + o.cs - 1] - toH[o.c] + 1];
      if (span[0] > 1 || span[1] > 1) out.span = span;
      if (cell?.des === 'logo') out.logo = true;
      else if (cell?.des?.startsWith('body.')) bad('Table columns are painted below the table line, not in the header.', [r, o.c]);
      else if (cell?.des) { out.bind = cell.des; declare(cell.des); }
      else if (cell?.text) out.text = cell.text;
      const st = styleFor(cell, 'header');
      if (st) out.style = st;
      if (Object.keys(out).length > 1) cells.push(out);
    }
  }
  // Painted body kinds in the heading rows or header are mistakes, not text.
  for (let r = G.table; r < dr; r++) {
    for (const o of originsInRow(G, r)) {
      if (cellAt(G, r, o.c)?.des) bad('Only the row below the heading is painted with table columns.', [r, o.c]);
    }
  }

  const sectionStyle = styleFor(G.section, 'section');
  const t = {
    formatVersion: FORMAT_VERSION,
    id: G.id || 'new-form',
    name: G.name,
    ...(G.stage ? { stage: G.stage } : {}),
    page: clone(G.page),
    font: clone(G.font),
    styles,
    fields: [...fields].map(([k, label]) => ({ key: k, label })),
    header: {
      columns: hCols.map(w => +w.toFixed(6)),
      rows: G.rows.slice(0, G.table),
      cells
    },
    body: {
      axis: 'rows',
      rowHeight: G.rows[dr],
      labelRowHeight: checkIdx.length ? G.rows[G.table]
        : +sum(G.rows.slice(G.table, dr)).toFixed(6),
      bands: G.bands,
      ...(headingStyle ? { headingStyle } : {}),
      ...(sectionStyle ? { sectionStyle } : {}),
      columns
    },
    footer: clone(G.footer ?? [])
  };
  // Declared fields with nothing placed (a footer may still use them).
  for (const f of G.footer ?? []) {
    for (const m of String(f.text).matchAll(/\{([^{}]+)\}/g)) {
      const k = m[1].trim();
      if (!fields.has(k) && (DECLARED_BUILTINS.has(k) || /^(sheet|record)\.[a-z]/.test(k) && !FIELD_BY_KEY.has(k))) {
        declare(k);
        t.fields.push({ key: k, label: fields.get(k) });
      }
    }
  }
  if (!t.fields.length) delete t.fields;
  if (!t.footer.length) delete t.footer;
  return { template: t, problems };
}

// Everything wrong with a grid, in words for a quality tech: the editor's own
// mapping problems first, then the format's, which can't point at a cell.
export function checkGrid(G) {
  const { template, problems } = gridToTemplate(G);
  // A form with any problem is never handed out: it would save, and print wrong.
  if (!template || problems.length) return { template: null, problems };
  const raw = validateTemplate(template);
  const wide = raw.filter(msg => /wider than the page/.test(msg));
  // Header and table too wide are one problem with one fix, not two.
  const fmt = raw.filter(msg => !/wider than the page/.test(msg)).map(msg => ({ msg: friendly(msg), at: null }));
  if (wide.length) {
    fmt.unshift({ msg: wide.length > 1 ? 'The form is wider than the page. Narrow some columns, or turn the page.'
      : friendly(wide[0]), at: null, fix: 'fit' });
  }
  return { template: fmt.length ? null : template, problems: fmt };
}

function friendly(msg) {
  if (/header is wider than the page/.test(msg)) return 'The header is wider than the page. Narrow some columns, or turn the page.';
  if (/body is wider than the page/.test(msg)) return 'The table is wider than the page. Narrow some columns, or turn the page.';
  if (/no room for a single row/.test(msg)) return 'There’s no room on the page for a single table row. Shorten the header or the margins.';
  if (/^name is missing/.test(msg)) return 'Give the form a name.';
  if (/labelWidth must be less than width/.test(msg)) return 'A check column’s label part must be narrower than the column.';
  return msg;
}

// The form's checklist: every field it could hold, placed or not.
export function checklist(G) {
  const placed = new Set();
  for (const [k, cell] of Object.entries(G.cells)) {
    if (!cell.des) continue;
    const [r] = k.split(',').map(Number);
    placed.add(cell.des.startsWith('body.') && r !== dataRow(G) ? null : cell.des);
  }
  const header = [...HEADER_FIELDS, LOGO].map(f => ({ key: f.key, label: G.fields[f.key] || f.label, placed: placed.has(f.key) }));
  const custom = [...placed].filter(k => k && !k.startsWith('body.') && !FIELD_BY_KEY.has(k))
    .map(k => ({ key: k, label: designationLabel(k, G.fields), placed: true, custom: true }));
  const table = BODY_KINDS.map(k => ({ key: `body.${k.key}`, label: k.label, placed: placed.has(`body.${k.key}`), required: k.key === 'spec' }));
  return { header: [...header, ...custom], table };
}

// A custom field's key from the label a user typed: "Heat Lot:" -> sheet.heat_lot.
export function customKeyFor(label, scope, taken = new Set()) {
  let name = String(label).toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, ' ')
    .trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, '');
  if (!name) name = 'field';
  name = name.slice(0, 40);
  let k = `${scope}.${name}`, n = 2;
  while (taken.has(k) || FIELD_BY_KEY.has(k)) k = `${scope}.${name}_${n++}`;
  return k;
}

// ---------------------------------------------------------------------------
// Edits. Each returns nothing and changes G in place; the editor snapshots G
// before an edit for undo.
// ---------------------------------------------------------------------------
// Merges a rectangle. Excel keeps only the top-left value; so does this.
export function merge(G, r0, c0, r1, c1) {
  const box = growToMerges(G, r0, c0, r1, c1);
  G.merges = G.merges.filter(m => !(m.r >= box.r0 && m.c >= box.c0 && m.r + m.rs - 1 <= box.r1 && m.c + m.cs - 1 <= box.c1));
  for (let r = box.r0; r <= box.r1; r++) {
    for (let c = box.c0; c <= box.c1; c++) if (r !== box.r0 || c !== box.c0) delete G.cells[key(r, c)];
  }
  if (box.r1 > box.r0 || box.c1 > box.c0) {
    G.merges.push({ r: box.r0, c: box.c0, rs: box.r1 - box.r0 + 1, cs: box.c1 - box.c0 + 1 });
  }
}

export function unmerge(G, r0, c0, r1, c1) {
  G.merges = G.merges.filter(m => m.r + m.rs - 1 < r0 || m.r > r1 || m.c + m.cs - 1 < c0 || m.c > c1);
}

// A selection grown until no merge straddles its edge.
export function growToMerges(G, r0, c0, r1, c1) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of G.merges) {
      const mr1 = m.r + m.rs - 1, mc1 = m.c + m.cs - 1;
      if (m.r > r1 || mr1 < r0 || m.c > c1 || mc1 < c0) continue;
      if (m.r < r0) { r0 = m.r; changed = true; }
      if (m.c < c0) { c0 = m.c; changed = true; }
      if (mr1 > r1) { r1 = mr1; changed = true; }
      if (mc1 > c1) { c1 = mc1; changed = true; }
    }
  }
  return { r0, c0, r1, c1 };
}

// Applies `props` to every origin in a rectangle; null clears a property.
export function format(G, r0, c0, r1, c1, props) {
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const o = originOf(G, r, c);
      if (o.r !== r || o.c !== c) continue;
      const cell = { ...(G.cells[key(r, c)] || {}) };
      for (const [k, v] of Object.entries(props)) {
        if (v == null) delete cell[k]; else cell[k] = v;
      }
      if (Object.keys(cell).length) G.cells[key(r, c)] = cell; else delete G.cells[key(r, c)];
    }
  }
}

export function setText(G, r, c, text) {
  const o = originOf(G, r, c);
  const cell = { ...(G.cells[key(o.r, o.c)] || {}) };
  if (text) cell.text = text; else delete cell.text;
  if (text) delete cell.des;
  if (Object.keys(cell).length) G.cells[key(o.r, o.c)] = cell; else delete G.cells[key(o.r, o.c)];
}

// Paints (or, with null, erases) a designation onto a cell.
export function paint(G, r, c, des) {
  const o = originOf(G, r, c);
  const cell = { ...(G.cells[key(o.r, o.c)] || {}) };
  if (des) { cell.des = des; delete cell.text; } else delete cell.des;
  if (Object.keys(cell).length) G.cells[key(o.r, o.c)] = cell; else delete G.cells[key(o.r, o.c)];
}

// Rows and columns. Merges that span the insertion point grow; Excel does the same.
export function insertRows(G, at, n = 1, height = null) {
  const h = height ?? G.rows[Math.min(at, G.rows.length - 1)] ?? 0.22;
  G.rows.splice(at, 0, ...Array(n).fill(h));
  G.cells = shiftKeys(G.cells, (r, c) => [r >= at ? r + n : r, c]);
  for (const m of G.merges) {
    if (m.r >= at) m.r += n;
    else if (m.r + m.rs > at) m.rs += n;
  }
  if (G.table >= at && at > 0) G.table += n;
  else if (at === 0) G.table += n;
}

export function deleteRows(G, at, n = 1) {
  n = Math.min(n, G.rows.length - at);
  if (n <= 0 || G.rows.length - n < 2) return false;
  G.rows.splice(at, n);
  G.cells = shiftKeys(G.cells, (r, c) => (r < at ? [r, c] : r < at + n ? null : [r - n, c]));
  G.merges = G.merges.map(m => clipSpan(m, 'r', 'rs', at, n)).filter(Boolean).filter(m => m.rs > 1 || m.cs > 1);
  // The table line moves with the rows above it; it never leaves the grid.
  if (G.table > at) G.table = Math.max(at, G.table - n);
  if (G.table < 1) G.table = 1;
  const minRows = G.table + G.headRows + 1;
  if (G.rows.length < minRows) G.rows.push(...Array(minRows - G.rows.length).fill(0.22));
  return true;
}

export function insertCols(G, at, n = 1, width = null) {
  const w = width ?? G.cols[Math.min(at, G.cols.length - 1)] ?? 1;
  G.cols.splice(at, 0, ...Array(n).fill(w));
  G.cells = shiftKeys(G.cells, (r, c) => [r, c >= at ? c + n : c]);
  for (const m of G.merges) {
    if (m.c >= at) m.c += n;
    else if (m.c + m.cs > at) m.cs += n;
  }
}

export function deleteCols(G, at, n = 1) {
  n = Math.min(n, G.cols.length - at);
  if (n <= 0 || G.cols.length - n < 1) return false;
  G.cols.splice(at, n);
  G.cells = shiftKeys(G.cells, (r, c) => (c < at ? [r, c] : c < at + n ? null : [r, c - n]));
  G.merges = G.merges.map(m => clipSpan(m, 'c', 'cs', at, n)).filter(Boolean).filter(m => m.rs > 1 || m.cs > 1);
  return true;
}

function shiftKeys(cells, fn) {
  const out = {};
  for (const [k, v] of Object.entries(cells)) {
    const [r, c] = k.split(',').map(Number);
    const to = fn(r, c);
    if (to) out[key(...to)] = v;
  }
  return out;
}

// A merge after removing [at, at+n) along one axis, or null if it's gone.
function clipSpan(m, p, s, at, n) {
  const a = m[p], z = m[p] + m[s];
  if (z <= at) return m;
  if (a >= at + n) return { ...m, [p]: a - n };
  const na = Math.min(a, at);
  const nz = z > at + n ? z - n : at;
  return nz > na ? { ...m, [p]: na, [s]: nz - na } : null;
}

// Moves the table line to sit above row `at`.
export function setTableLine(G, at) {
  const max = G.rows.length - G.headRows - 1;
  G.table = Math.max(1, Math.min(at, max));
}

export function setHeadRows(G, n) {
  const max = G.rows.length - G.table - 1;
  G.headRows = Math.max(1, Math.min(n, max));
}

// The check run in the data row: { c0, w, n } (first column, columns per copy,
// copies), or null.
export function checkRun(G) {
  const dr = dataRow(G);
  const segs = originsInRow(G, dr).filter(o => cellAt(G, dr, o.c)?.des === 'body.check');
  if (!segs.length) return null;
  return { c0: segs[0].c, w: segs[0].cs, n: segs.length, segs };
}

// Sets how many times the check column repeats. Copies are made from the first
// one, and the run keeps its total width, so the form still fits its page.
export function setCheckRepeat(G, n) {
  const run = checkRun(G);
  if (!run || n < 1 || n === run.n) return false;
  const { c0, w } = run;
  const total = sum(G.cols.slice(c0, run.segs.at(-1).c + run.segs.at(-1).cs));
  const runEnd = c0 + run.n * w;
  // Header merges that end at the run's right edge grow with it.
  const edgeMerges = G.merges.filter(m => m.r < G.table && m.c < runEnd && m.c + m.cs === runEnd);
  if (n < run.n) {
    deleteCols(G, c0 + n * w, (run.n - n) * w);
  } else {
    const at = runEnd;
    const add = (n - run.n) * w;
    insertCols(G, at, add);
    for (const m of edgeMerges) {
      const live = G.merges.find(x => x.r === m.r && x.c === m.c);
      if (live) live.cs += add;
    }
    // Header rows above the new columns, with no merge covering them, are
    // blank cells: give their merged neighbours to them rather than new boxes.
    for (let k = 0; k < (n - run.n); k++) {
      const dst = at + k * w;
      for (let r = G.table; r < G.rows.length; r++) {
        for (let j = 0; j < w; j++) {
          const src = G.cells[key(r, c0 + j)];
          if (src) G.cells[key(r, dst + j)] = clone(src); else delete G.cells[key(r, dst + j)];
        }
      }
      for (const m of G.merges.filter(m => m.r >= G.table && m.c >= c0 && m.c + m.cs <= c0 + w)) {
        G.merges.push({ ...m, c: dst + (m.c - c0) });
      }
    }
  }
  // Keep the total width: each copy gets an equal share, split the way the
  // first copy is split.
  const first = G.cols.slice(c0, c0 + w);
  const fw = sum(first);
  const per = total / n;
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < w; j++) G.cols[c0 + k * w + j] = +(first[j] * per / fw).toFixed(6);
  }
  return true;
}

// The same column in every copy of the check column, for `c` inside the check
// run; just [c] otherwise. Resizing one part of a check resizes them all.
export function checkTwinCols(G, c) {
  const run = checkRun(G);
  if (!run || c < run.c0 || c >= run.c0 + run.n * run.w || run.segs.some(s => s.cs !== run.w)) return [c];
  const off = (c - run.c0) % run.w;
  return Array.from({ length: run.n }, (_, k) => run.c0 + k * run.w + off);
}

// Makes every check copy the same widths: each part becomes the average of
// that part across the copies, so the run keeps its total width. False when
// the copies aren't built alike (different numbers of columns).
export function equalizeChecks(G) {
  const run = checkRun(G);
  if (!run || run.segs.some(s => s.cs !== run.w)) return false;
  for (let j = 0; j < run.w; j++) {
    const cols = Array.from({ length: run.n }, (_, k) => run.c0 + k * run.w + j);
    const avg = sum(cols.map(c => G.cols[c])) / run.n;
    for (const c of cols) G.cols[c] = +avg.toFixed(6);
  }
  return true;
}

// The widest a form may be on its page: a quarter inch kept clear each side.
export const usableWidth = G => G.page.size[0] - 0.5;

// Scales the whole form to its page: every column, every row and every text
// size by one factor, so it keeps exactly the shape it was given. What the user
// sets is the design; the page only decides the scale. On its own it only
// shrinks a form that's too wide; with `grow` (the Fit button) it also grows
// one that's narrower, to fill the page. False when nothing changes.
export function fitWidth(G, { grow = false } = {}) {
  const limit = usableWidth(G);
  const total = sum(G.cols);
  // Columns are rounded to a millionth, so "fits" is to a ten-thousandth.
  if (total <= 0 || Math.abs(total - limit) < 1e-4 || (!grow && total < limit)) return false;
  const k = limit / total;
  const scale = v => Math.floor(v * k * 1e6) / 1e6;
  const pt = v => Math.max(1, Math.round(v * k * 100) / 100);
  G.cols = G.cols.map(scale);
  G.rows = G.rows.map(scale);
  G.font = { ...G.font, size: pt(G.font.size) };
  for (const cell of Object.values(G.cells)) if (cell.size != null) cell.size = pt(cell.size);
  if (G.section?.size != null) G.section = { ...G.section, size: pt(G.section.size) };
  G.footer = (G.footer ?? []).map(f => (f.size != null ? { ...f, size: pt(f.size) } : f));
  return true;
}

// Copies an edit made to one check copy onto all of them. `fn(r, c)` is the
// edit for one cell. Cells outside the check run get it once.
export function forEachCheckTwin(G, r, c, fn) {
  const run = checkRun(G);
  if (!run || r < G.table || c < run.c0 || c >= run.c0 + run.n * run.w) return fn(r, c);
  const off = (c - run.c0) % run.w;
  for (let k = 0; k < run.n; k++) fn(r, run.c0 + k * run.w + off);
}

// ---------------------------------------------------------------------------
// Sample values for the preview
// ---------------------------------------------------------------------------
export function sampleBindings(G) {
  const custom = { sheet: {}, record: {} };
  for (const cell of Object.values(G.cells)) {
    const m = /^(sheet|record)\.(.+)$/.exec(cell.des || '');
    if (m && !FIELD_BY_KEY.has(cell.des)) custom[m[1]][m[2]] = `Sample ${designationLabel(cell.des, G.fields)}`;
  }
  return {
    part: { customer: 'Acme Corp', number: 'PN-12345', name: 'Mounting Bracket', revision: 'C',
            customerPartNumber: 'AC-889-01', material: '6061-T6 Aluminium', finish: 'Clear Anodise' },
    sheet: { name: 'Sheet 1', units: 'in', author: 'J. Smith', editDate: '2026-10-03', custom: custom.sheet },
    record: { jobNumber: 'J-0042', machine: 'Haas VF-2', custom: custom.record }
  };
}

export const SAMPLE_ROWS = [
  { type: 'characteristic', number: '1', spec: '2.500 ±.005', method: 'Caliper', notes: '', bands: [{ gageId: 'CAL-07', values: ['2.502'] }] },
  { type: 'characteristic', number: '2', spec: '.750 +.002/-.000', method: 'Pin gage', notes: '', bands: [{ gageId: 'PG-12', values: ['OK'] }] },
  { type: 'header', text: 'Section A' },
  { type: 'characteristic', number: '3', spec: '1.125 ±.010', method: 'Height gage', notes: 'Datum A', bands: [{ gageId: 'HG-02', values: [] }] },
  { type: 'characteristic', number: '', isSub: true, spec: '.010 flatness', method: 'Indicator', notes: '', bands: [] }
];

// A new form that already works: a title, the usual fields, and a table with
// two checks. Nobody should face an empty grid and wonder where to start.
export function starterGrid(orientation = 'landscape') {
  const G = blankGrid(orientation);
  const usable = G.page.size[0] - 0.65;
  // Balloon, Dimension, Method, Gage ID, then three checks of label + box.
  const base = [0.45, 2.6, 1.1, 1.0, 0.35, 1.383, 0.35, 1.383, 0.35, 1.383];
  const k = usable / sum(base);
  G.cols = base.map(w => +(w * k).toFixed(4));
  G.rows = [0.3, 0.22, 0.22, 0.17, 0.17, 0.22];
  G.table = 3;
  G.headRows = 2;
  G.cells = {};
  G.merges = [];
  const label = { fill: '#d9d9d9' };
  merge(G, 0, 0, 0, 9);
  G.cells['0,0'] = { text: 'Inspection Report', bold: true, align: 'center', size: 12, fill: '#d9d9d9' };
  const pair = (r, c0, c1, text, c2, c3, des) => {
    merge(G, r, c0, r, c1); G.cells[key(r, c0)] = { text, ...label };
    merge(G, r, c2, r, c3); G.cells[key(r, c2)] = { des };
  };
  pair(1, 0, 1, 'Part Number', 2, 3, 'part.number');
  pair(1, 4, 5, 'Job Number', 6, 9, 'record.jobNumber');
  pair(2, 0, 1, 'Part Name', 2, 3, 'part.name');
  pair(2, 4, 5, 'Machine', 6, 9, 'record.machine');
  const head = { fill: '#d9d9d9', align: 'center' };
  const t = G.table, dr = t + G.headRows;
  [['Balloon', 'number'], ['Dimension', 'spec'], ['Method', 'method'], ['Gage ID', 'gage']].forEach(([text, kind], c) => {
    merge(G, t, c, t + 1, c);
    G.cells[key(t, c)] = { text, ...head };
    G.cells[key(dr, c)] = { des: `body.${kind}`, align: 'center', ...(kind === 'spec' ? { font: 'symbol' } : {}) };
  });
  for (let n = 0; n < 3; n++) {
    const c = 4 + n * 2;
    G.cells[key(t, c)] = { text: 'Date:', fill: '#d9d9d9', size: 6 };
    G.cells[key(t + 1, c)] = { text: 'Initials:', fill: '#d9d9d9', size: 6 };
    G.cells[key(t, c + 1)] = { fill: '#d9d9d9', align: 'center' };
    G.cells[key(t + 1, c + 1)] = { fill: '#d9d9d9', align: 'center' };
    merge(G, dr, c, dr, c + 1);
    G.cells[key(dr, c)] = { des: 'body.check', align: 'center' };
  }
  G.name = 'New form';
  return G;
}

// ---------------------------------------------------------------------------
// Excel import and suggestions
// ---------------------------------------------------------------------------
// Text compared the way synonyms are written: lower case, punctuation gone.
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
const matches = (text, item) => {
  const n = norm(text);
  return !!n && (item.syn.includes(n) || norm(item.label) === n);
};
// Words that head the parts of a check column.
const CHECK_WORDS = ['date', 'initials', 'init', 'op', 'op #', 'operator', 'inspector', 'technician', 'tech',
  'result', 'results', 'actual', 'measured', 'reading', 'pass fail', 'accept', 'part #', 'shift', 'time', 'sample', 'piece'];
const isCheckWord = t => CHECK_WORDS.includes(norm(t));

// A grid from a sheet read by xlsx-read.js. Designations come in blank; the
// table line goes where the sheet's table heading seems to be. Columns are
// scaled down if the sheet is wider than the page; `scaled` says by how much.
export function gridFromSheet(sheet, name) {
  const landscape = sheet.page?.orientation === 'landscape';
  const G = blankGrid(landscape ? 'landscape' : 'portrait');
  const paper = PAGE_SIZES[sheet.page?.paper] ?? PAGE_SIZES.letter;
  G.page.size = landscape ? [paper[1], paper[0]] : [...paper];
  G.page.marginTop = Math.min(1, Math.max(0, +(sheet.page?.marginTop ?? 0.25)));
  G.page.marginBottom = Math.min(1, Math.max(0.3, +(sheet.page?.marginBottom ?? 0.5)));
  G.font = { family: sheet.font?.family || 'Arial', size: sheet.font?.size || 10 };
  G.name = name || 'Imported form';
  G.cols = sheet.cols.length ? [...sheet.cols] : [1];
  G.rows = [...sheet.rows];
  G.cells = clone(sheet.cells);
  G.merges = clone(sheet.merges);
  while (G.rows.length < 3) G.rows.push(0.2);
  let scaled = 1;
  const usable = G.page.size[0] - 0.5;
  const w = sum(G.cols);
  if (w > usable) {
    scaled = usable / w;
    G.cols = G.cols.map(x => +(x * scaled).toFixed(4));
  }
  guessTable(G);
  return { G, scaled };
}

// Puts the table line above the row that reads most like a table heading.
export function guessTable(G) {
  let best = -1, bestScore = 1;
  for (let r = 1; r < G.rows.length - 1; r++) {
    let score = 0;
    for (const o of originsInRow(G, r)) {
      if (o.r !== r) continue;
      const t = cellAt(G, r, o.c)?.text;
      if (!t) continue;
      if (BODY_KINDS.some(k => matches(t, k)) || /dimension|specification|characteristic/i.test(t)) score += 2;
      else if (isCheckWord(t)) score += 1;
    }
    if (score > bestScore) { best = r; bestScore = score; }
  }
  if (best < 0) {
    G.table = Math.max(1, G.rows.length - 2);
    G.headRows = 1;
    return false;
  }
  G.table = best;
  // The heading is as tall as its tallest merged heading, and takes in the
  // rows of check labels stacked under it.
  let h = 1;
  for (const o of originsInRow(G, best)) if (o.r === best) h = Math.max(h, o.rs);
  for (let r = best + 1; r < G.rows.length && r < best + 6; r++) {
    const texts = originsInRow(G, r).filter(o => o.r === r).map(o => cellAt(G, r, o.c)?.text).filter(Boolean);
    if (texts.length && texts.every(isCheckWord)) h = Math.max(h, r - best + 1); else break;
  }
  // A sheet that ends at its heading still needs the row that repeats.
  while (G.rows.length < best + h + 1) G.rows.push(G.rows.at(-1) ?? 0.22);
  G.headRows = h;
  return true;
}

// What the editor would paint, given the labels on the form. Each suggestion
// is { r, c, des, label } for an existing field, or { r, c, field: { label,
// scope }, label } for a new one. Nothing is painted until it's accepted.
export function suggest(G) {
  const out = [];
  const dr = dataRow(G);
  const placed = new Set(Object.values(G.cells).map(c => c.des).filter(Boolean));
  const target = new Set();
  const empty = (r, c) => {
    const o = originOf(G, r, c);
    const cell = cellAt(G, o.r, o.c);
    return o.r === r && o.c === c && !cell?.text && !cell?.des && !target.has(key(r, c));
  };
  const add = s => { out.push(s); target.add(key(s.r, s.c)); if (s.des) placed.add(s.des); };

  // Header: a label, and the empty cell beside it (or under it).
  for (let r = 0; r < G.table; r++) {
    for (const o of originsInRow(G, r)) {
      if (o.r !== r) continue;
      const cell = cellAt(G, r, o.c);
      const t = cell?.text;
      // Labels are short. A title isn't one: it's long, wide or large.
      if (!t || t.length > 32 || t.trim().split(/\s+/).length > 5
          || (o.cs >= 3 && cell.align === 'center') || (cell.size ?? G.font.size) >= 12) continue;
      let at = null;
      if (o.c + o.cs < G.cols.length && empty(r, o.c + o.cs)) at = { r, c: o.c + o.cs };
      else if (o.r + o.rs < G.table && empty(o.r + o.rs, o.c)) at = { r: o.r + o.rs, c: o.c };
      if (!at) continue;
      const f = HEADER_FIELDS.find(x => matches(t, x));
      if (f) { if (!placed.has(f.key)) add({ ...at, des: f.key, label: f.label }); continue; }
      const label = t.replace(/[\s:#.–—-]+$/, '').trim();
      if (label && /[a-z]/i.test(label)) add({ ...at, field: { label, scope: 'record' }, label });
    }
  }
  // An empty merged block at the top left is where logos go.
  if (!placed.has('logo')) {
    const o = originOf(G, 0, 0);
    if (o.rs > 1 && empty(0, 0)) add({ r: 0, c: 0, des: 'logo', label: 'Logo' });
  }

  // Table: headings say what the data row below them holds.
  if (dr < G.rows.length) {
    const under = (a, z) => originsInRow(G, dr).filter(x => x.c >= a && x.c + x.cs <= z);
    for (const h of originsInRow(G, G.table)) {
      if (h.r !== G.table) continue;
      const t = cellAt(G, h.r, h.c)?.text;
      if (!t) continue;
      const kind = BODY_KINDS.find(k => matches(t, k))
        ?? (/dimension|specification|characteristic|requirement/i.test(t) ? KIND_BY_KEY.get('spec') : null);
      if (!kind || kind.key === 'check') continue;
      const cells = under(h.c, h.c + h.cs).filter(x => empty(dr, x.c));
      if (!cells.length) continue;
      // "Dimension / Specification" over a narrow column and a wide one is
      // the balloon number and the dimension, as on Bubbler+'s own forms.
      if (kind.key === 'spec' && cells.length === 2 && !placed.has('body.number')
          && sum(G.cols.slice(cells[0].c, cells[0].c + cells[0].cs)) < 0.6) {
        add({ r: dr, c: cells[0].c, des: 'body.number', label: 'Balloon #' });
        add({ r: dr, c: cells[1].c, des: 'body.spec', label: 'Dimension' });
        continue;
      }
      if (!placed.has(`body.${kind.key}`)) add({ r: dr, c: cells[0].c, des: `body.${kind.key}`, label: kind.label });
    }
    // A run of identical columns left over is the checks.
    const width = x => sum(G.cols.slice(x.c, x.c + x.cs));
    let run = [];
    const flush = () => {
      if (run.length >= 2 && !placed.has('body.check')) {
        for (const x of run) add({ r: dr, c: x.c, des: 'body.check', label: 'Checks' });
      }
      run = [];
    };
    for (const x of originsInRow(G, dr).filter(x => empty(dr, x.c))) {
      const prev = run.at(-1);
      if (prev && (prev.c + prev.cs !== x.c || Math.abs(width(prev) - width(x)) > 0.01)) flush();
      run.push(x);
    }
    flush();
  }
  return out;
}

// Paints one suggestion; a new field is declared first.
export function acceptSuggestion(G, s) {
  let des = s.des;
  if (s.field) {
    const taken = new Set([...Object.keys(G.fields), ...Object.values(G.cells).map(c => c.des).filter(Boolean)]);
    des = customKeyFor(s.field.label, s.field.scope, taken);
    G.fields[des] = s.field.label;
  }
  paint(G, s.r, s.c, des);
  return des;
}

// Rows below the data row aren't part of the form; this removes them.
export function trimBelowTable(G) {
  const dr = dataRow(G);
  if (G.rows.length - 1 > dr) deleteRows(G, dr + 1, G.rows.length - 1 - dr);
}
