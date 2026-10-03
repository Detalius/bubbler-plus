// Reads one worksheet of an .xlsx as the form editor needs it: cell text,
// merges, column widths, row heights, fills, bold/italic, size, alignment and
// wrap. Pure, with the unzip passed in, so the editor (fflate's browser build)
// and the tests (fflate in Node) share it.
//
// Only what a printed form's look depends on is read. Borders aren't: every
// cell of a form prints with one. Number formats aren't: a form is labels.

// ---------------------------------------------------------------------------
// A small XML reader: elements, attributes and text. Workbook parts are
// machine-written and regular; this covers what Excel and LibreOffice write.
// ---------------------------------------------------------------------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
    : ENT[e] ?? m);

export function parseXml(text) {
  const root = { name: '#root', attrs: {}, kids: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (let m; (m = re.exec(text));) {
    const top = stack[stack.length - 1];
    if (m[1] != null) { top.text += m[1]; continue; }
    if (m[6] != null) { top.text += unescape(m[6]); continue; }
    if (!m[3]) continue;                                   // comment, PI, doctype
    if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
    const el = { name: m[3].replace(/^\w+:/, ''), attrs: {}, kids: [], text: '' };
    for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      el.attrs[a[1].replace(/^(?!xmlns)\w+:/, '')] = unescape(a[2] ?? a[3]);
    }
    top.kids.push(el);
    if (!m[5]) stack.push(el);
  }
  return root;
}
const kids = (el, name) => (el?.kids ?? []).filter(k => k.name === name);
const kid = (el, name) => (el?.kids ?? []).find(k => k.name === name) || null;
const deep = (el, name) => {
  const out = [];
  const walk = e => { for (const k of e?.kids ?? []) { if (k.name === name) out.push(k); walk(k); } };
  walk(el);
  return out;
};
const textOf = el => {
  if (!el) return '';
  let s = el.text;
  for (const k of el.kids) s += textOf(k);
  return s;
};

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------
export function decodeRef(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + ch.charCodeAt(0) - 64;
  return { r: +m[2] - 1, c: c - 1 };
}
export function decodeRange(ref) {
  const [a, b] = ref.split(':');
  const p = decodeRef(a), q = decodeRef(b ?? a);
  if (!p || !q) return null;
  return { r0: Math.min(p.r, q.r), c0: Math.min(p.c, q.c), r1: Math.max(p.r, q.r), c1: Math.max(p.c, q.c) };
}

// ---------------------------------------------------------------------------
// Colours: rgb, theme with tint, and the legacy indexed palette
// ---------------------------------------------------------------------------
const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'];

function tinted(hex, tint) {
  if (!tint) return hex;
  let [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const f = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  if (s === 0) r = g = b = l;
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
  }
  return [r, g, b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function colour(el, theme) {
  if (!el) return null;
  const a = el.attrs;
  let hex = null;
  if (a.rgb) hex = a.rgb.slice(-6);
  else if (a.theme != null) hex = theme[+a.theme] ?? null;
  else if (a.indexed != null) hex = INDEXED[+a.indexed] ?? null;
  if (!hex) return null;
  return '#' + tinted(hex.toUpperCase(), +(a.tint || 0)).toLowerCase();
}

// Excel numbers theme colours lt1, dk1, lt2, dk2 — the file lists dk1 first.
function themeColours(xml) {
  if (!xml) return [];
  const scheme = deep(parseXml(xml), 'clrScheme')[0];
  if (!scheme) return [];
  const get = name => {
    const el = kid(scheme, name);
    const c = el?.kids[0];
    return c?.attrs.val && c.name === 'srgbClr' ? c.attrs.val : c?.attrs.lastClr ?? null;
  };
  return ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(get);
}

// ---------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------
const dec = u => new TextDecoder().decode(u);

// Opens a workbook. `unzip` is fflate's unzipSync. Returns { sheets: [names], read(i) }.
export function openWorkbook(bytes, unzip) {
  let files;
  try { files = unzip(bytes); } catch { throw new Error('This isn’t an Excel workbook (.xlsx).'); }
  const part = p => (files[p] ? dec(files[p]) : null);
  const wbXml = part('xl/workbook.xml');
  if (!wbXml) throw new Error('This isn’t an Excel workbook (.xlsx).');
  const wb = parseXml(wbXml);
  const rels = parseXml(part('xl/_rels/workbook.xml.rels') || '');
  const target = id => {
    const r = deep(rels, 'Relationship').find(x => x.attrs.Id === id);
    if (!r) return null;
    const t = r.attrs.Target.replace(/^\//, '');
    return t.startsWith('xl/') ? t : 'xl/' + t.replace(/^\.\//, '');
  };
  const sheets = deep(wb, 'sheet').map(s => ({
    name: s.attrs.name, path: target(s.attrs.id), hidden: s.attrs.state && s.attrs.state !== 'visible'
  })).filter(s => s.path && files[s.path]);
  const printAreas = {};
  for (const d of deep(wb, 'definedName')) {
    if (d.attrs.name === '_xlnm.Print_Area' && d.attrs.localSheetId != null) {
      const first = textOf(d).split(',')[0];
      printAreas[+d.attrs.localSheetId] = first.slice(first.lastIndexOf('!') + 1);
    }
  }
  const allSheets = deep(wb, 'sheet');

  const shared = deep(parseXml(part('xl/sharedStrings.xml') || ''), 'si').map(si => {
    const t = kid(si, 't');
    return t ? textOf(t) : kids(si, 'r').map(r => textOf(kid(r, 't'))).join('');
  });
  const theme = themeColours(part('xl/theme/theme1.xml'));
  const styles = parseXml(part('xl/styles.xml') || '');
  const fonts = kids(kid(deep(styles, 'styleSheet')[0], 'fonts'), 'font').map(f => ({
    bold: !!kid(f, 'b') && kid(f, 'b').attrs.val !== '0' && kid(f, 'b').attrs.val !== 'false',
    italic: !!kid(f, 'i') && kid(f, 'i').attrs.val !== '0' && kid(f, 'i').attrs.val !== 'false',
    size: +(kid(f, 'sz')?.attrs.val ?? 11),
    name: kid(f, 'name')?.attrs.val ?? 'Calibri'
  }));
  const fills = kids(kid(deep(styles, 'styleSheet')[0], 'fills'), 'fill').map(f => {
    const p = kid(f, 'patternFill');
    if (!p || !p.attrs.patternType || p.attrs.patternType === 'none') return null;
    return colour(kid(p, 'fgColor'), theme) ?? colour(kid(p, 'bgColor'), theme);
  });
  const xfs = kids(kid(deep(styles, 'styleSheet')[0], 'cellXfs'), 'xf').map(x => {
    const al = kid(x, 'alignment');
    return {
      font: fonts[+(x.attrs.fontId ?? 0)] ?? fonts[0],
      fill: fills[+(x.attrs.fillId ?? 0)] ?? null,
      align: al?.attrs.horizontal ?? null,
      wrap: al?.attrs.wrapText === '1' || al?.attrs.wrapText === 'true'
    };
  });
  const defaultFont = fonts[0] ?? { size: 11, name: 'Calibri' };

  function read(i) {
    const s = sheets[i];
    const ws = parseXml(part(s.path));
    const sheetIndex = allSheets.findIndex(x => x.attrs.name === s.name);
    return readSheet(ws, { shared, xfs, defaultFont, printArea: printAreas[sheetIndex] ?? null });
  }
  return { sheets: sheets.map(s => s.name), hidden: sheets.map(s => !!s.hidden), read };
}

// Excel's column width is in characters of the default font's widest digit;
// for Calibri 11 that's 7 px at 96 dpi, with 5 px of padding.
const charsToIn = w => Math.trunc(((256 * w + Math.trunc(128 / 7)) / 256) * 7) / 96;

function readSheet(ws, { shared, xfs, defaultFont, printArea }) {
  const root = deep(ws, 'worksheet')[0] ?? ws;
  const fmt = kid(root, 'sheetFormatPr')?.attrs ?? {};
  const defColIn = fmt.defaultColWidth != null ? charsToIn(+fmt.defaultColWidth)
    : (8 * 7 + 5 + (fmt.baseColWidth ? (+fmt.baseColWidth - 8) * 7 : 0)) / 96;
  const defRowIn = +(fmt.defaultRowHeight ?? 15) / 72;

  const colW = new Map(), colHidden = new Set();
  for (const c of deep(kid(root, 'cols'), 'col')) {
    for (let k = +c.attrs.min - 1; k <= +c.attrs.max - 1 && k < 16384; k++) {
      if (c.attrs.width != null) colW.set(k, charsToIn(+c.attrs.width));
      if (c.attrs.hidden === '1' || c.attrs.hidden === 'true') colHidden.add(k);
      if (k > 1000) break;
    }
  }
  const rowH = new Map(), rowHidden = new Set();
  const cells = new Map();
  let maxR = -1, maxC = -1;
  for (const row of deep(kid(root, 'sheetData'), 'row')) {
    const r = +row.attrs.r - 1;
    if (row.attrs.ht != null) rowH.set(r, +row.attrs.ht / 72);
    if (row.attrs.hidden === '1' || row.attrs.hidden === 'true') rowHidden.add(r);
    let next = 0;
    for (const c of kids(row, 'c')) {
      const at = c.attrs.r ? decodeRef(c.attrs.r) : { r, c: next };
      next = at.c + 1;
      const t = c.attrs.t;
      let text = '';
      if (t === 's') text = shared[+textOf(kid(c, 'v'))] ?? '';
      else if (t === 'inlineStr') text = textOf(kid(c, 'is'));
      else if (kid(c, 'v')) text = textOf(kid(c, 'v'));
      const xf = xfs[+(c.attrs.s ?? 0)] ?? null;
      const look = {};
      if (xf) {
        if (xf.fill && xf.fill !== '#ffffff') look.fill = xf.fill;
        if (xf.font.bold) look.bold = true;
        if (xf.font.italic) look.italic = true;
        if (xf.font.size !== defaultFont.size) look.size = xf.font.size;
        if (xf.font.name !== defaultFont.name) look.font = xf.font.name;
        if (xf.align === 'center' || xf.align === 'centerContinuous') look.align = 'center';
        else if (xf.align === 'right') look.align = 'right';
        // General alignment puts numbers on the right, text on the left.
        else if (!xf.align && t !== 's' && t !== 'inlineStr' && t !== 'str' && /^-?[\d.]+(e-?\d+)?$/i.test(text)) look.align = 'right';
        if (text && !xf.wrap) look.wrap = false;
      }
      // A formatted cell is part of the form even when empty: the blank rows of
      // a table usually carry nothing but borders. Excel counts them as used too.
      if (text || look.fill || +(c.attrs.s ?? 0) > 0) { maxR = Math.max(maxR, at.r); maxC = Math.max(maxC, at.c); }
      if (!text && !Object.keys(look).length) continue;
      cells.set(`${at.r},${at.c}`, { ...(text ? { text } : {}), ...look });
    }
  }
  const merges = deep(kid(root, 'mergeCells'), 'mergeCell').map(m => decodeRange(m.attrs.ref)).filter(Boolean);
  for (const m of merges) {
    if (cells.get(`${m.r0},${m.c0}`)) { maxR = Math.max(maxR, m.r1); maxC = Math.max(maxC, m.c1); }
  }

  // The part to bring across: the print area if one is set, else everything
  // used, which is at least what the sheet's own dimension says.
  const dim = decodeRange(kid(root, 'dimension')?.attrs.ref ?? '');
  if (dim) { maxR = Math.max(maxR, dim.r1); maxC = Math.max(maxC, dim.c1); }
  let area = { r0: 0, c0: 0, r1: Math.max(0, maxR), c1: Math.max(0, maxC) };
  if (printArea) area = decodeRange(printArea) ?? area;
  area.r1 = Math.min(area.r1, area.r0 + 400);
  area.c1 = Math.min(area.c1, area.c0 + 100);

  // Hidden rows and columns don't print, so they don't come across.
  const rowsIdx = [], colsIdx = [];
  for (let r = area.r0; r <= area.r1; r++) if (!rowHidden.has(r)) rowsIdx.push(r);
  for (let c = area.c0; c <= area.c1; c++) if (!colHidden.has(c)) colsIdx.push(c);
  const rMap = new Map(rowsIdx.map((r, i) => [r, i])), cMap = new Map(colsIdx.map((c, i) => [c, i]));

  const out = {
    cols: colsIdx.map(c => +(colW.get(c) ?? defColIn).toFixed(4)),
    rows: rowsIdx.map(r => +(rowH.get(r) ?? defRowIn).toFixed(4)),
    cells: {}, merges: [],
    font: { family: defaultFont.name, size: defaultFont.size }
  };
  for (const [k, v] of cells) {
    const [r, c] = k.split(',').map(Number);
    if (rMap.has(r) && cMap.has(c)) out.cells[`${rMap.get(r)},${cMap.get(c)}`] = v;
  }
  for (const m of merges) {
    // A merge keeps whichever of its rows and columns are visible and in the area.
    const rs = rowsIdx.filter(r => r >= m.r0 && r <= m.r1), cs = colsIdx.filter(c => c >= m.c0 && c <= m.c1);
    if (!rs.length || !cs.length || (rs.length === 1 && cs.length === 1)) continue;
    const r0 = rMap.get(rs[0]), c0 = cMap.get(cs[0]);
    // Its value sits in the top-left cell, which may have been hidden.
    const src = cells.get(`${m.r0},${m.c0}`);
    if (src && !out.cells[`${r0},${c0}`]) out.cells[`${r0},${c0}`] = src;
    for (let r = r0; r < r0 + rs.length; r++) for (let c = c0; c < c0 + cs.length; c++) {
      if (r !== r0 || c !== c0) delete out.cells[`${r},${c}`];
    }
    out.merges.push({ r: r0, c: c0, rs: rs.length, cs: cs.length });
  }

  const ps = kid(root, 'pageSetup')?.attrs ?? {};
  const pm = kid(root, 'pageMargins')?.attrs ?? {};
  out.page = {
    paper: { 1: 'letter', 5: 'legal', 9: 'a4' }[ps.paperSize ?? '1'] ?? 'letter',
    orientation: ps.orientation === 'landscape' ? 'landscape' : 'portrait',
    marginTop: pm.top != null ? +pm.top : 0.75,
    marginBottom: pm.bottom != null ? +pm.bottom : 0.75
  };
  return out;
}
