// The index's per-form sheet counts, behind the form editor's "N existing
// sheets use this form".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMain } = require('./helpers/load-main');

const { publishSidecar, countFormUsage, formsOfSheets } = loadMain();
console.info = () => {};

// Sheets as a manifest stores them, written out by hand rather than through
// formsOfSheets, so the count is checked against an independent shape.
const sheet = id => ({ name: 'S', template: id ? { id, hash: '0123456789abcdef' } : undefined });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbler-forms-'));
const entry = (id, sheets) => ({
  packageId: id, file: path.join(dir, `${id}.insp`), partNumber: 'PN',
  drawings: [], sheets: sheets.length, inspections: 0, forms: formsOfSheets(sheets)
});

test('sheets per form, ignoring built-in-era sheets with no reference', () => {
  assert.deepEqual(formsOfSheets([sheet('shop-a'), sheet('shop-a'), sheet('ipi-landscape'), sheet(null), null]),
                   { 'shop-a': 2, 'ipi-landscape': 1 });
  assert.deepEqual(formsOfSheets(undefined), {});
  // Not a template id: never becomes a key.
  assert.deepEqual(formsOfSheets([sheet('__proto__'), sheet('Bad Id')]), {});
});

test('the count adds across packages and leaves missing ones out', async () => {
  await publishSidecar(entry('pkg_a', [sheet('shop-a'), sheet('shop-a'), sheet('shop-b')]));
  await publishSidecar(entry('pkg_b', [sheet('shop-a')]));
  await publishSidecar(entry('pkg_c', [sheet('shop-b')]));
  assert.deepEqual(await countFormUsage('shop-a'), { sheets: 3, packages: 2, uncounted: 0 });
  assert.deepEqual(await countFormUsage('shop-b'), { sheets: 2, packages: 2, uncounted: 0 });
  assert.deepEqual(await countFormUsage('nobody'), { sheets: 0, packages: 0, uncounted: 0 });
});

test('a renderer-sent map is cleaned before it is written', async () => {
  const e = entry('pkg_d', []);
  e.forms = { 'shop-z': 2, 'BAD': 1, 'shop-y': 1.5, 'shop-x': -1 };
  await publishSidecar(e);
  assert.deepEqual(await countFormUsage('shop-z'), { sheets: 2, packages: 1, uncounted: 0 });
  assert.equal((await countFormUsage('shop-y')).sheets, 0);
});

test('records from before the field are reported as uncounted, not as zero', async () => {
  // An older build's record: no `forms`.
  const root = path.join(process.env.APPDATA, 'Bubbler+', '.bubbler-index', 'pkg');
  fs.writeFileSync(path.join(root, 'pkg_old.json'),
    JSON.stringify({ packageId: 'pkg_old', path: path.join(dir, 'old.insp'), sheets: 4 }));
  const r = await countFormUsage('shop-a');
  assert.equal(r.sheets, 3);
  assert.equal(r.uncounted, 1);
});

test('a package flagged missing is not counted', async () => {
  const root = path.join(process.env.APPDATA, 'Bubbler+', '.bubbler-index', 'pkg');
  fs.writeFileSync(path.join(root, 'pkg_gone.json'), JSON.stringify({
    packageId: 'pkg_gone', path: path.join(dir, 'gone.insp'), sheets: 5,
    forms: { 'shop-a': 5 }, missing: true }));
  assert.equal((await countFormUsage('shop-a')).sheets, 3);
});

test('an old record with no sheets has nothing to count', async () => {
  const root = path.join(process.env.APPDATA, 'Bubbler+', '.bubbler-index', 'pkg');
  fs.writeFileSync(path.join(root, 'pkg_empty.json'),
    JSON.stringify({ packageId: 'pkg_empty', path: path.join(dir, 'e.insp'), sheets: 0 }));
  assert.equal((await countFormUsage('shop-a')).uncounted, 1);
});
