// Sheet templates: the built-ins, validation, bindings and page arithmetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'assets', 'templates');
const builtins = fs.readdirSync(DIR).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const clone = o => JSON.parse(JSON.stringify(o));
const ipi = () => clone(builtins.find(t => t.id === 'ipi-landscape'));

let T;
test.before(async () => { T = await import('../sheet-template.js'); });

test('eight built-ins, all valid', () => {
  assert.equal(builtins.length, 8);
  for (const t of builtins) assert.deepEqual(T.validateTemplate(t), [], t.id);
});

test('built-ins fit today\'s 28 rows landscape, 41 portrait', () => {
  for (const t of builtins) {
    assert.equal(T.rowsPerPage(t), t.id.endsWith('landscape') ? 28 : 41, t.id);
  }
});

test('built-in header and body are the same width', () => {
  for (const t of builtins) assert.ok(Math.abs(T.headerWidth(t) - T.bodyWidth(t)) < 1e-4, t.id);
});

// The hard-coded rule the templates replaced, kept as the reference.
const LEGACY = {
  landscape: { checkRow: 0.1683, dataRow: 0.2167, rows: 28 },
  portrait:  { checkRow: 0.1633, dataRow: 0.2117, rows: 41 }
};
function legacyBandCount(stage, orientation, rowCount) {
  if (stage !== 'in-process' || !rowCount) return 1;
  const G = LEGACY[orientation];
  if (rowCount > G.rows) return 1;
  const available = 3 * G.checkRow + G.rows * G.dataRow;
  return Math.max(1, Math.floor((available + 1e-6) / (3 * G.checkRow + rowCount * G.dataRow)));
}

test('banding matches the hard-coded rule it replaced', () => {
  for (const t of builtins) {
    const orientation = t.id.endsWith('landscape') ? 'landscape' : 'portrait';
    for (let n = 0; n <= 60; n++) {
      assert.equal(T.bandCount(t, n), legacyBandCount(t.stage, orientation, n), `${t.id}, ${n} rows`);
    }
  }
});

const rows = (n, subsEvery = 0) => Array.from({ length: n }, (_, i) =>
  ({ number: i, isSub: subsEvery > 0 && i % subsEvery !== 0 }));
const fai = () => builtins.find(t => t.id === 'fai-landscape');

test('a short in-process sheet bands onto one page', () => {
  assert.ok(T.bandCount(ipi(), 5) > 1);
  assert.equal(T.paginateRows(rows(5), ipi()).length, 1);
});

test('pages hold at most rowsPerPage rows', () => {
  for (const t of builtins.filter(x => x.stage === 'final')) {
    const cap = T.rowsPerPage(t);
    const pages = T.paginateRows(rows(cap * 2 + 3), t);
    assert.equal(pages.length, 3);
    for (const p of pages) assert.ok(p.length <= cap);
    assert.equal(pages.flat().length, cap * 2 + 3);
  }
});

test('a characteristic and its subs are never split across pages', () => {
  const cap = T.rowsPerPage(fai());
  const pages = T.paginateRows(rows(cap * 3, 4), fai());
  for (const p of pages) assert.equal(p[0].isSub, false);
  assert.equal(pages.flat().length, cap * 3);
});

test('an empty sheet is one empty page', () => {
  assert.deepEqual(T.paginateRows([], fai()), [[]]);
});

test('single-entry forms have one wide check column', () => {
  const fai = builtins.find(t => t.id === 'fai-landscape');
  const chk = T.checkColumn(fai);
  assert.equal(chk.repeat, 1);
  assert.equal(chk.labels.length, 2);
  assert.equal(T.checkColumn(ipi()).repeat, 8);
});

// ---- validation -------------------------------------------------------------

const errorsFor = mutate => { const t = ipi(); mutate(t); return T.validateTemplate(t); };
const expectError = (mutate, pattern) => {
  const errs = errorsFor(mutate);
  assert.ok(errs.some(e => pattern.test(e)), `expected ${pattern}, got ${JSON.stringify(errs)}`);
};

test('overlapping header cells are rejected, naming the cell', () => {
  expectError(t => t.header.cells.push({ at: [2, 0], text: 'x' }), /cell \[2,0\]: overlaps the cell at \[0,0\]/);
});

test('a cell past the grid is rejected', () => {
  expectError(t => t.header.cells.push({ at: [4, 4], span: [2, 1], text: 'x' }), /reaches past the grid/);
});

test('bindings must be known or declared', () => {
  expectError(t => { t.header.cells[3].bind = 'record.due_date'; }, /\{record\.due_date\} is not a known or declared/);
  assert.deepEqual(errorsFor(t => {
    t.fields.push({ key: 'record.due_date', label: 'Due Date' });
    t.header.cells[3].bind = 'record.due_date';
  }), []);
});

test('custom keys are lowercase and never duplicated', () => {
  expectError(t => t.fields.push({ key: 'record.DueDate', label: 'x' }), /lowercase name/);
  expectError(t => t.fields.push({ key: 'part.color', label: 'x' }), /sheet\. or record\./);
  expectError(t => t.fields.push({ key: 'record.machine', label: 'again' }), /declared twice/);
});

test('page numbers only in the footer', () => {
  expectError(t => { t.header.cells[1].text = 'Page {page.number}'; }, /only works in the footer/);
});

test('a missing style is named', () => {
  expectError(t => { t.header.cells[2].style = 'lable'; }, /no style named "lable"/);
});

test('body rules', () => {
  expectError(t => { t.body.axis = 'columns'; }, /not supported yet/);
  expectError(t => t.body.columns.push(clone(t.body.columns[4])), /only one column may repeat/);
  expectError(t => { t.body.columns[3].headingSpan = 2; }, /headingSpan/);
  expectError(t => { t.body.columns[2].bind = 'tolerance'; }, /bind must be one of/);
  expectError(t => { t.body.columns[4].labelWidth = 5; }, /labelWidth must be less than width/);
});

test('page size limits', () => {
  expectError(t => { t.body.columns[1].width = 20; }, /body is wider than the page/);
  expectError(t => { t.page.marginBottom = 7; }, /no room for a single row/);
});

test('a newer format asks for a newer Bubbler+', () => {
  expectError(t => { t.formatVersion = 2; }, /needs a newer Bubbler\+/);
});

// ---- bindings ---------------------------------------------------------------

test('bindings resolve built-in and custom values', () => {
  const ctx = {
    part: { number: 'PN-1234', customer: 'Acme' },
    sheet: { name: 'OP20', author: 'JH', custom: { station: '4' } },
    record: { jobNumber: 'J-55', custom: { due_date: '2026-10-01' } },
    page: { number: 2, count: 3 }
  };
  assert.equal(T.resolveBinding('part.number', ctx), 'PN-1234');
  assert.equal(T.resolveBinding('sheet.author', ctx), 'JH');
  assert.equal(T.resolveBinding('record.due_date', ctx), '2026-10-01');
  assert.equal(T.resolveBinding('sheet.station', ctx), '4');
  assert.equal(T.resolveBinding('record.machine', ctx), '');
  assert.equal(T.fillText('Page {page.number} of {page.count}', ctx), 'Page 2 of 3');
  assert.equal(T.fillText('{record.jobNumber}', { ...ctx, record: null }), '');
});

test('a custom field can never read a built-in property', () => {
  const ctx = { sheet: { items: ['secret'], custom: {} } };
  assert.equal(T.resolveBinding('sheet.items', ctx), '');
});

// ---- versions and package storage -------------------------------------------

test('canonicalJson is independent of key order', () => {
  const a = T.canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } });
  const b = T.canonicalJson({ a: { c: null, d: [2, { x: 2, y: 1 }] }, b: 1 });
  assert.equal(a, b);
  assert.equal(T.canonicalJson({ u: undefined }), '{"u":null}');
});

test('a template hash ignores key order and formatting, and sees any edit', () => {
  const t = ipi();
  const h = T.templateHash(t);
  assert.match(h, /^[0-9a-f]{16}$/);
  const reordered = Object.fromEntries(Object.entries(t).reverse());
  assert.equal(T.templateHash(reordered), h);
  assert.equal(T.templateHash(JSON.parse(JSON.stringify(t, null, 2))), h);
  const edited = ipi();
  edited.body.rowHeight += 0.0001;
  assert.notEqual(T.templateHash(edited), h);
});

test('every built-in has its own hash', () => {
  assert.equal(new Set(builtins.map(T.templateHash)).size, builtins.length);
});

const custom = () => {
  const t = ipi();
  t.id = 'shop-ipi';
  t.name = 'Our IPI';
  t.fields.push({ key: 'record.due_date', label: 'Due Date' });
  return t;
};

test('a package carries its custom templates and reads them back', () => {
  const skip = new Set(builtins.map(T.templateHash));
  const files = T.packageTemplateFiles([custom(), ipi()], skip);
  const names = Object.keys(files);
  assert.equal(names.length, 1, 'built-ins are never copied into a package');
  assert.equal(names[0], `templates/${T.templateHash(custom())}.json`);
  const { templates, problems } = T.readPackageTemplates({ ...files, 'manifest.json': new Uint8Array() });
  assert.deepEqual(problems, []);
  assert.deepEqual(templates.get(T.templateHash(custom())), custom());
});

test('a package template that is invalid or renamed is left out', () => {
  const enc = o => new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o));
  const good = custom(), hash = T.templateHash(good);
  const broken = custom(); broken.body.axis = 'sideways';
  const { templates, problems } = T.readPackageTemplates({
    [`templates/${hash}.json`]: enc(good),
    'templates/0000000000000000.json': enc(good),
    [`templates/${T.templateHash(broken)}.json`]: enc(broken),
    'templates/1111111111111111.json': enc('{ not json'),
    'templates/notes.txt': enc('ignored')
  });
  assert.deepEqual([...templates.keys()], [hash]);
  assert.equal(problems.length, 3);
  assert.ok(problems.some(p => /does not match its name/.test(p.errors[0])));
  assert.ok(problems.some(p => /body\.axis/.test(p.errors[0])));
  assert.ok(problems.some(p => /not valid JSON/.test(p.errors[0])));
});

test('stored template references are read defensively', () => {
  assert.deepEqual(T.readTemplateRef({ id: 'ipi-landscape', hash: '0123456789abcdef' }),
                   { id: 'ipi-landscape', hash: '0123456789abcdef' });
  assert.deepEqual(T.readTemplateRef({ id: 'x', hash: 'nope' }), { id: 'x', hash: null });
  assert.equal(T.readTemplateRef(null), null);
  assert.equal(T.readTemplateRef({ hash: '0123456789abcdef' }), null);
});

// ---- custom values ----------------------------------------------------------

test('a custom binding never reads an inherited property', () => {
  const ctx = { sheet: { custom: {} }, record: { custom: { lot: 42 } } };
  assert.equal(T.resolveBinding('sheet.constructor', ctx), '');
  assert.equal(T.fillText('[{sheet.constructor}]', ctx), '[]');
  assert.equal(T.resolveBinding('record.lot', ctx), '', 'only text is printed');
});

test('stored custom values keep declarable names and text only', () => {
  const read = v => JSON.stringify(T.readCustom(v));
  assert.equal(read({ heat_lot: 'H-7', station2: '4' }), '{"heat_lot":"H-7","station2":"4"}');
  assert.equal(read({ Heat: 'x', '2nd': 'x', 'a-b': 'x', __proto__x: 'x' }), '{}');
  assert.equal(read({ n: 5, b: true, o: {}, blank: '' }), '{}');
  for (const junk of [null, undefined, 'text', 7, ['a']]) assert.equal(read(junk), '{}');
});

test('customNames lists one scope\'s custom fields, never built-ins', () => {
  const t = { fields: [
    { key: 'sheet.author', label: 'A' }, { key: 'sheet.station', label: 'S' },
    { key: 'record.heat_lot', label: 'H' }, { key: 'record.machine', label: 'M' },
    { key: 'sheet.name', label: 'N' }
  ] };
  assert.deepEqual(T.customNames(t, 'sheet'), ['station']);
  assert.deepEqual(T.customNames(t, 'record'), ['heat_lot']);
  assert.deepEqual(T.customNames({}, 'sheet'), []);
});
