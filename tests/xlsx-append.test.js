const test = require('node:test');
const assert = require('node:assert/strict');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');
const { appendSheets, legalName, uniqueName, colName } = require('../xlsx-append');

// The smallest workbook Excel would recognise, plus a binary part standing in
// for macros, which must come through byte for byte.
function workbook() {
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Form" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet>original form</worksheet>'),
    'xl/vbaProject.bin': new Uint8Array([0, 1, 2, 250, 251, 252])
  });
}

test('appends a sheet and leaves every other part untouched', () => {
  const { bytes, added, untouched } = appendSheets(workbook(), [
    { name: 'PN-1234', columns: [{ header: 'Dim', values: ['1.250', '.375'] }] }
  ]);
  const z = unzipSync(new Uint8Array(bytes));
  assert.deepEqual(added, ['PN-1234']);
  assert.equal(untouched, 2);
  assert.deepEqual([...z['xl/vbaProject.bin']], [0, 1, 2, 250, 251, 252]);
  assert.equal(strFromU8(z['xl/worksheets/sheet1.xml']), '<worksheet>original form</worksheet>');
  assert.match(strFromU8(z['xl/workbook.xml']), /<sheet name="PN-1234" sheetId="2" r:id="rId2"\/>/);
  assert.match(strFromU8(z['xl/_rels/workbook.xml.rels']), /Id="rId2"[^>]*Target="worksheets\/sheet2.xml"/);
  assert.match(strFromU8(z['[Content_Types].xml']), /PartName="\/xl\/worksheets\/sheet2.xml"/);
  assert.equal(Object.keys(z)[0], '[Content_Types].xml');
});

test('values are inline strings, escaped, and never re-typed', () => {
  const { bytes } = appendSheets(workbook(), [{
    name: 'S', columns: [{ header: 'A&B', values: ['1/4-20', '.250', '<x>', 'bell\u0007'] }]
  }]);
  const sheet = strFromU8(unzipSync(new Uint8Array(bytes))['xl/worksheets/sheet2.xml']);
  assert.ok(!sheet.includes('<v>'), 'no typed values');
  for (const want of ['A&amp;B', '1/4-20', '.250', '&lt;x&gt;', '>bell<']) assert.ok(sheet.includes(want), want);
});

test('ragged columns are not padded', () => {
  const { bytes } = appendSheets(workbook(), [{
    name: 'S', columns: [{ header: 'A', values: ['1', '2', '3'] }, { header: 'B', values: ['x'] }]
  }]);
  const sheet = strFromU8(unzipSync(new Uint8Array(bytes))['xl/worksheets/sheet2.xml']);
  assert.ok(sheet.includes('r="B2"'));
  assert.ok(!sheet.includes('r="B3"'));
  assert.ok(sheet.includes('<dimension ref="A1:B4"/>'));
});

test('a taken sheet name gets a suffix, case-insensitively', () => {
  const { added } = appendSheets(workbook(), [
    { name: 'form', columns: [] }, { name: 'Form', columns: [] }
  ]);
  assert.deepEqual(added, ['form (2)', 'Form (3)']);
});

test('sheet names follow Excel\'s rules', () => {
  assert.equal(legalName('a:b\\c/d?e*f[g]h'), 'abcdefgh');
  assert.equal(legalName("'quoted'"), 'quoted');
  assert.equal(legalName(''), 'Sheet');
  assert.equal(legalName('x'.repeat(40)).length, 31);
  assert.equal(uniqueName('x'.repeat(40), ['x'.repeat(31)]), 'x'.repeat(27) + ' (2)');
});

test('column letters', () => {
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(colName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
});

test('refuses something that is not a workbook', () => {
  assert.throws(() => appendSheets(zipSync({ 'a.txt': strToU8('x') }), []), /not a workbook/);
});
