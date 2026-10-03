// Forms as Excel: the workbook writer, from hand-built page models. Read back
// through xlsx-read.js (tested separately against hand-written workbooks) and
// by looking at the XML itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { zipSync, unzipSync, strFromU8 } = require('fflate');

let W, X;
test.before(async () => {
  W = await import('../xlsx-form.js');
  X = await import('../xlsx-read.js');
});

const look = (o = {}) => ({ fill: null, size: 8, bold: false, italic: false, align: 'left', wrap: true, symbol: false, font: 'Arial', ...o });
// One page: a logo over two rows, a title, a label/value pair, and a check
// label beside its box.
const page = text => ({
  cols: [1, 2, 0.5, 1],
  rows: [0.3, 0.25, 0.2],
  cells: [
    { r: 0, c: 0, rs: 2, cs: 1, text: '', logo: true, border: 'all', look: look({ align: 'center' }) },
    { r: 0, c: 1, rs: 1, cs: 3, text, logo: false, border: 'all', look: look({ bold: true, size: 12, fill: '#d9d9d9', align: 'center' }) },
    { r: 1, c: 1, rs: 1, cs: 1, text: 'Part Number', logo: false, border: 'all', look: look() },
    { r: 1, c: 2, rs: 1, cs: 2, text: 'PN-1 ±', logo: false, border: 'all', look: look({ symbol: true }) },
    { r: 2, c: 0, rs: 1, cs: 1, text: '', logo: false, border: 'none', look: look() },
    { r: 2, c: 1, rs: 1, cs: 1, text: 'Date:', logo: false, border: 'noRight', look: look({ wrap: false, size: 5 }) },
    { r: 2, c: 2, rs: 1, cs: 2, text: '9/28', logo: false, border: 'noLeft', look: look() }
  ]
});
const LOGO = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'assets', 'forms-icon.png')));
const opts = (o = {}) => ({
  sheetName: 'Final', page: { size: [8.5, 11], marginTop: 0.25, marginBottom: 0.5 },
  footer: [{ text: 'Page {page.number} of {page.count} — A & B', align: 'left', size: 7.6, bottom: 0.13 }],
  logo: LOGO, ...o
});
const files = bytes => unzipSync(bytes);
const part = (bytes, name) => strFromU8(files(bytes)[name]);

test('two pages: stacked, a manual break between them, each read back', () => {
  const bytes = W.formWorkbook([page('One'), page('Two')], opts(), zipSync);
  const s = X.openWorkbook(bytes, unzipSync).read(0);
  assert.equal(s.rows.length, 6);
  assert.equal(s.cells['0,1'].text, 'One');
  assert.equal(s.cells['3,1'].text, 'Two');
  assert.deepEqual(s.merges.filter(m => m.cs === 3).map(m => m.r), [0, 3]);
  const sheet = part(bytes, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /<rowBreaks count="1" manualBreakCount="1"><brk id="3" max="16383" man="1"\/><\/rowBreaks>/);
});

test('sizes, fills, fonts and alignment come back as they went in', () => {
  const s = X.openWorkbook(W.formWorkbook([page('T')], opts(), zipSync), unzipSync).read(0);
  s.cols.forEach((w, i) => assert.ok(Math.abs(w - [1, 2, 0.5, 1][i]) <= 1 / 96 + 1e-9, `col ${i}: ${w}`));
  s.rows.forEach((h, i) => assert.ok(Math.abs(h - [0.3, 0.25, 0.2][i]) < 1e-3, `row ${i}`));
  assert.equal(s.cells['0,1'].fill, '#d9d9d9');
  assert.equal(s.cells['0,1'].bold, true);
  assert.equal(s.cells['0,1'].size, 12);
  assert.equal(s.cells['0,1'].align, 'center');
  // GD&T text is Unicode in a font that has the symbols.
  assert.equal(s.cells['1,2'].text, 'PN-1 ±');
  assert.equal(s.cells['1,2'].font, 'Segoe UI Symbol');
});

test('a merged cell carries its borders across every cell it covers', () => {
  const bytes = W.formWorkbook([page('T')], opts(), zipSync);
  const sheet = part(bytes, 'xl/worksheets/sheet1.xml');
  const s = ref => (new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(sheet) || [])[1];
  assert.ok(s('B1'));
  assert.equal(s('C1'), s('B1'));
  assert.equal(s('D1'), s('B1'));
  // Borders by kind: none for the filler, and the check label and box open
  // toward each other.
  const styles = part(bytes, 'xl/styles.xml');
  const xfs = [...styles.matchAll(/<xf numFmtId="0" fontId="\d+" fillId="\d+" borderId="(\d+)" xfId="0"/g)].map(m => +m[1]);
  const borders = [...styles.matchAll(/<border>([\s\S]*?)<\/border>/g)].map(m => m[1]);
  const borderOf = ref => borders[xfs[+s(ref)]];
  assert.doesNotMatch(borderOf('A3'), /style=/);
  assert.match(borderOf('B3'), /<right\/>/);
  assert.match(borderOf('C3'), /<left\/>/);
});

test('the footer is Excel’s, with page codes, and a literal & doubled', () => {
  const sheet = part(W.formWorkbook([page('T')], opts(), zipSync), 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /<oddFooter>&amp;L&amp;8Page &amp;P of &amp;N — A &amp;&amp; B<\/oddFooter>/);
});

test('the page: paper, orientation, one page wide, gridlines off', () => {
  const sheet = part(W.formWorkbook([page('T')], opts({ page: { size: [11.6929, 8.2677], marginTop: 0.3, marginBottom: 0.5 } }), zipSync), 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"\/>/);
  assert.match(sheet, /<pageSetUpPr fitToPage="1"\/>/);
  assert.match(sheet, /showGridLines="0"/);
  // Normal view: Excel's Page Layout view opens with a phantom left margin.
  assert.doesNotMatch(sheet, /pageLayout/);
  assert.match(sheet, /top="0.3" bottom="0.5"/);
});

test('the logo: one picture per page, fitted to its cell, proportions kept', () => {
  const bytes = W.formWorkbook([page('One'), page('Two')], opts(), zipSync);
  const f = files(bytes);
  assert.deepEqual(f['xl/media/image1.png'], LOGO);
  const d = strFromU8(f['xl/drawings/drawing1.xml']);
  const anchors = [...d.matchAll(/<xdr:row>(\d+)<\/xdr:row>[\s\S]*?<xdr:ext cx="(\d+)" cy="(\d+)"\/>/g)];
  assert.deepEqual(anchors.map(a => +a[1]), [0, 3]);
  const [, , cx, cy] = anchors[0];
  assert.equal(+cx, +cy);                                   // a square logo stays square
  assert.ok(+cy <= 0.55 * 0.92 * 914400 + 1);               // inside its two rows
  assert.match(strFromU8(f['[Content_Types].xml']), /image\/png/);
});

test('no logo, no drawing parts at all', () => {
  const f = files(W.formWorkbook([page('T')], opts({ logo: null }), zipSync));
  assert.ok(!Object.keys(f).some(k => k.includes('drawing') || k.includes('media')));
  assert.doesNotMatch(strFromU8(f['xl/worksheets/sheet1.xml']), /<drawing/);
});

test('worksheet names Excel accepts', () => {
  assert.equal(W.sheetName('Op 10: Final [rev B]/2?'), 'Op 10 Final rev B2');
  assert.equal(W.sheetName("'quoted'"), 'quoted');
  assert.equal(W.sheetName(''), 'Sheet');
  assert.equal(W.sheetName('x'.repeat(40)).length, 31);
});
