// Sheet templates: the printed form as data (TEMPLATE-FORMAT.md). Pure
// functions only, so the renderer, the Library and the tests share one copy.

export const FORMAT_VERSION = 1;

// Always available; never declared in `fields`.
const ALWAYS = new Set([
  'part.customer', 'part.number', 'part.name', 'part.revision',
  'part.customerPartNumber', 'part.material', 'part.finish',
  'sheet.name', 'sheet.units', 'page.number', 'page.count'
]);
// Known to Bubbler+, but a template must declare them to get an input box.
const BUILTIN_FIELDS = new Set([
  'sheet.author', 'sheet.editDate', 'record.jobNumber', 'record.machine'
]);
const CUSTOM_KEY = /^(sheet|record)\.[a-z][a-z0-9_]*$/;
const BODY_BINDS = new Set(['number', 'spec', 'method', 'gage', 'notes']);
const ALIGN = new Set(['left', 'center', 'right']);
const STYLE_KEYS = new Set(['fill', 'size', 'bold', 'italic', 'align', 'wrap', 'font']);
const PLACEHOLDER = /\{([^{}]+)\}/g;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;
const isInt = v => Number.isInteger(v);
const sum = a => a.reduce((s, x) => s + x, 0);

// The check column, or null for a form without checks.
export const checkColumn = t => t.body.columns.find(c => c.repeat != null) || null;

// Height of the body's heading block: one row per check label.
export function headingHeight(t) {
  const chk = checkColumn(t);
  return (chk ? chk.labels.length : 1) * t.body.labelRowHeight;
}

export const headerWidth = t => sum(t.header.columns);
export const headerHeight = t => sum(t.header.rows);
export const bodyWidth = t =>
  sum(t.body.columns.map(c => c.width * (c.repeat ?? 1)));

// Characteristic rows that fit on one page, after the margins, the header and
// the heading block.
export function rowsPerPage(t) {
  const [, pageH] = t.page.size;
  const free = pageH - t.page.marginTop - t.page.marginBottom
             - headerHeight(t) - headingHeight(t);
  return Math.floor(free / t.body.rowHeight + 1e-9);
}

// How many times the heading block and rows repeat down one page. Only a
// "fill" template bands, and only when the whole sheet fits on one page.
export function bandCount(t, rowCount) {
  if (t.body.bands !== 'fill' || !rowCount) return 1;
  const max = rowsPerPage(t);
  if (rowCount > max) return 1;
  const available = headingHeight(t) + max * t.body.rowHeight;
  const band = headingHeight(t) + rowCount * t.body.rowHeight;
  return Math.max(1, Math.floor((available + 1e-6) / band));
}

// Splits rows into pages of at most rowsPerPage(t). A characteristic and its
// sub-dimensions are never split; a banded sheet is always one page.
export function paginateRows(rows, t, isSub = r => r.isSub) {
  if (bandCount(t, rows.length) > 1) return [rows];
  const cap = rowsPerPage(t);
  const units = [];
  for (const r of rows) {
    const last = units[units.length - 1];
    if (isSub(r) && last) { last.push(r); continue; }
    units.push([r]);
  }
  const pages = [];
  let cur = [];
  for (const u of units) {
    if (cur.length && cur.length + u.length > cap) { pages.push(cur); cur = []; }
    cur.push(...u);
  }
  if (cur.length || !pages.length) pages.push(cur);
  return pages;
}

// JSON with keys sorted recursively, so equal content serialises equal whatever
// order its keys were written in.
export function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

// Identifies one exact version of a template: 16 hex digits of FNV-1a (64-bit)
// over its canonical JSON. Not a security hash; it only tells versions apart.
export function templateHash(t) {
  const s = canonicalJson(t);
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h = ((h ^ BigInt(s.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

const TEMPLATE_FILE = /^templates\/([0-9a-f]{16})\.json$/;

// A package's templates/ folder as zip entries: one templates/<hash>.json per
// template in `used`, skipping any whose hash is in `skip` (the built-ins).
export function packageTemplateFiles(used, skip = new Set()) {
  const out = {};
  for (const t of used) {
    const hash = templateHash(t);
    if (skip.has(hash)) continue;
    out[`templates/${hash}.json`] = new TextEncoder().encode(JSON.stringify(t, null, 2));
  }
  return out;
}

// The templates a package carries, from its unzipped files: { templates, problems }.
// `templates` maps hash -> template. A file that isn't valid, or whose content
// doesn't match its name, goes to `problems` instead.
export function readPackageTemplates(files) {
  const templates = new Map(), problems = [];
  for (const [name, bytes] of Object.entries(files || {})) {
    const m = TEMPLATE_FILE.exec(name);
    if (!m) continue;
    let t, errors;
    try {
      t = JSON.parse(new TextDecoder().decode(bytes));
      errors = validateTemplate(t);
    } catch (err) {
      errors = [`not valid JSON: ${err.message}`];
    }
    if (!errors.length && templateHash(t) !== m[1]) errors = ['content does not match its name'];
    if (errors.length) problems.push({ file: name, errors });
    else templates.set(m[1], t);
  }
  return { templates, problems };
}

// A template reference as stored on a sheet or record, or null if malformed.
export function readTemplateRef(r) {
  if (!r || typeof r.id !== 'string' || !r.id) return null;
  return { id: r.id, hash: /^[0-9a-f]{16}$/.test(r.hash ?? '') ? r.hash : null };
}

// A binding's value from `ctx`:
//   { part: {...}, sheet: {..., custom}, record: {..., custom} | null, page: {...} }
// Missing values come back as ''.
export function resolveBinding(key, ctx) {
  const dot = key.indexOf('.');
  const scope = key.slice(0, dot), name = key.slice(dot + 1);
  const src = ctx?.[scope];
  if (!src) return '';
  const builtin = ALWAYS.has(key) || BUILTIN_FIELDS.has(key);
  const v = builtin ? src[name] : src.custom?.[name];
  return v == null ? '' : String(v);
}

// `text` with every {binding} filled in.
export const fillText = (text, ctx) =>
  String(text ?? '').replace(PLACEHOLDER, (_, key) => resolveBinding(key.trim(), ctx));

const bindingsIn = text => [...String(text ?? '').matchAll(PLACEHOLDER)].map(m => m[1].trim());

// Checks a template against TEMPLATE-FORMAT.md. Returns a list of problems,
// empty when the template is usable. Never repairs anything.
export function validateTemplate(t) {
  const errs = [];
  const bad = msg => errs.push(msg);
  if (!t || typeof t !== 'object') return ['not a JSON object'];

  if (t.formatVersion !== FORMAT_VERSION) {
    bad(isNum(t.formatVersion) && t.formatVersion > FORMAT_VERSION
      ? `formatVersion ${t.formatVersion} needs a newer Bubbler+`
      : `formatVersion must be ${FORMAT_VERSION}`);
    return errs;
  }
  if (typeof t.id !== 'string' || !/^[a-z0-9-]+$/.test(t.id)) bad('id: lowercase letters, digits and - only');
  if (typeof t.name !== 'string' || !t.name.trim()) bad('name is missing');
  if (t.stage != null && (typeof t.stage !== 'string' || !t.stage.trim())) bad('stage must be text');

  const p = t.page;
  if (!p || !Array.isArray(p.size) || p.size.length !== 2 || !p.size.every(isPos)) {
    bad('page.size must be [width, height]');
    return errs;                       // everything below measures against it
  }
  for (const k of ['marginTop', 'marginBottom']) {
    if (!isNum(p[k]) || p[k] < 0) bad(`page.${k} must be a length`);
  }
  if (t.font != null && (typeof t.font.family !== 'string' || !isPos(t.font.size))) {
    bad('font needs a family and a size');
  }

  // Styles
  const styles = t.styles ?? {};
  for (const [name, st] of Object.entries(styles)) {
    const where = `styles.${name}`;
    if (!st || typeof st !== 'object') { bad(`${where} is not an object`); continue; }
    for (const k of Object.keys(st)) if (!STYLE_KEYS.has(k)) bad(`${where}: unknown key "${k}"`);
    if (st.fill != null && !/^#[0-9a-f]{6}$/i.test(st.fill)) bad(`${where}.fill must be #rrggbb`);
    if (st.size != null && !isPos(st.size)) bad(`${where}.size must be a positive number`);
    if (st.align != null && !ALIGN.has(st.align)) bad(`${where}.align must be left, center or right`);
    for (const k of ['bold', 'italic', 'wrap']) {
      if (st[k] != null && typeof st[k] !== 'boolean') bad(`${where}.${k} must be true or false`);
    }
    if (st.font != null && (typeof st.font !== 'string' || !st.font.trim())) bad(`${where}.font must be text`);
  }
  const styleOk = (name, where) => {
    if (name != null && !Object.hasOwn(styles, name)) bad(`${where}: no style named "${name}"`);
  };

  // Fields
  const declared = new Set();
  for (const [i, f] of (t.fields ?? []).entries()) {
    const where = `fields[${i}]`;
    if (!f || typeof f.key !== 'string') { bad(`${where}: key is missing`); continue; }
    if (!BUILTIN_FIELDS.has(f.key) && !CUSTOM_KEY.test(f.key)) {
      bad(`${where}: "${f.key}" must be sheet. or record. and a lowercase name`);
    }
    if (declared.has(f.key)) bad(`${where}: "${f.key}" is declared twice`);
    if (typeof f.label !== 'string' || !f.label.trim()) bad(`${where}: label is missing`);
    declared.add(f.key);
  }
  const bindingOk = (key, where, { page = false } = {}) => {
    if (key.startsWith('page.') && !page) bad(`${where}: {${key}} only works in the footer`);
    else if (!ALWAYS.has(key) && !declared.has(key)) bad(`${where}: {${key}} is not a known or declared field`);
  };

  // Header
  const h = t.header;
  if (!h || !Array.isArray(h.columns) || !h.columns.every(isPos) || !h.columns.length ||
      !Array.isArray(h.rows) || !h.rows.every(isPos) || !h.rows.length) {
    bad('header needs columns and rows, as positive lengths');
  } else {
    const taken = new Map();
    for (const [i, c] of (h.cells ?? []).entries()) {
      const at = Array.isArray(c?.at) ? `[${c.at}]` : `cells[${i}]`;
      const where = `header cell ${at}`;
      if (!Array.isArray(c?.at) || c.at.length !== 2 || !c.at.every(v => isInt(v) && v >= 0)) {
        bad(`${where}: "at" must be [row, column]`); continue;
      }
      const span = c.span ?? [1, 1];
      if (!Array.isArray(span) || span.length !== 2 || !span.every(v => isInt(v) && v >= 1)) {
        bad(`${where}: "span" must be [rows, columns]`); continue;
      }
      const [r, col] = c.at, [rs, cs] = span;
      if (r + rs > h.rows.length || col + cs > h.columns.length) { bad(`${where}: reaches past the grid`); continue; }
      for (let y = r; y < r + rs; y++) {
        for (let x = col; x < col + cs; x++) {
          const k = `${y},${x}`;
          if (taken.has(k)) bad(`${where}: overlaps the cell at [${taken.get(k)}]`);
          else taken.set(k, c.at);
        }
      }
      if (['text', 'bind', 'logo'].filter(k => c[k] != null).length > 1) bad(`${where}: only one of text, bind or logo`);
      if (c.bind != null) bindingOk(c.bind, where);
      for (const key of bindingsIn(c.text)) bindingOk(key, where);
      styleOk(c.style, where);
    }
  }

  // Body
  const b = t.body;
  if (!b || !Array.isArray(b.columns) || !b.columns.length) {
    bad('body needs columns');
  } else {
    if (b.axis !== 'rows') bad(b.axis === 'columns' ? 'body.axis "columns" is not supported yet' : 'body.axis must be "rows"');
    if (!isPos(b.rowHeight)) bad('body.rowHeight must be a positive length');
    if (!isPos(b.labelRowHeight)) bad('body.labelRowHeight must be a positive length');
    if (b.bands !== 1 && b.bands !== 'fill') bad('body.bands must be 1 or "fill"');
    styleOk(b.headingStyle, 'body.headingStyle');
    styleOk(b.sectionStyle, 'body.sectionStyle');
    const checks = b.columns.filter(c => c?.repeat != null);
    if (checks.length > 1) bad('body: only one column may repeat');
    b.columns.forEach((c, i) => {
      const where = `body.columns[${i}]`;
      if (!c || !isPos(c.width)) { bad(`${where}: width must be a positive length`); return; }
      styleOk(c.style, where);
      if (c.repeat != null) {
        if (!isInt(c.repeat) || c.repeat < 1) bad(`${where}: repeat must be a whole number, 1 or more`);
        if (c.bind !== 'check') bad(`${where}: a repeating column binds "check"`);
        if (!Array.isArray(c.labels) || !c.labels.length || !c.labels.every(l => typeof l === 'string')) {
          bad(`${where}: labels must be a list of text`);
        }
        if (!isPos(c.labelWidth) || c.labelWidth >= c.width) bad(`${where}: labelWidth must be less than width`);
        styleOk(c.labelStyle, where);
        styleOk(c.headStyle, where);
      } else if (!BODY_BINDS.has(c.bind)) {
        bad(`${where}: bind must be one of ${[...BODY_BINDS].join(', ')}`);
      }
      if (c.headingSpan != null) {
        const end = i + c.headingSpan;
        if (!isInt(c.headingSpan) || c.headingSpan < 1 || end > b.columns.length ||
            b.columns.slice(i, end).some(x => x?.repeat != null)) {
          bad(`${where}: headingSpan must stay within the ordinary columns`);
        }
      }
    });
  }

  // Footer
  for (const [i, f] of (t.footer ?? []).entries()) {
    const where = `footer[${i}]`;
    if (typeof f?.text !== 'string') { bad(`${where}: text is missing`); continue; }
    if (f.align != null && !ALIGN.has(f.align)) bad(`${where}: align must be left, center or right`);
    if (f.bottom != null && (!isNum(f.bottom) || f.bottom < 0)) bad(`${where}: bottom must be a length`);
    if (f.size != null && !isPos(f.size)) bad(`${where}: size must be a positive number`);
    styleOk(f.style, where);
    for (const key of bindingsIn(f.text)) bindingOk(key, where, { page: true });
  }

  // The page has to hold it all.
  if (!errs.length) {
    const [pageW] = p.size;
    if (headerWidth(t) > pageW + 1e-6) bad('header is wider than the page');
    if (bodyWidth(t) > pageW + 1e-6) bad('body is wider than the page');
    if (rowsPerPage(t) < 1) bad('no room for a single row below the header');
  }
  return errs;
}
