// Reading a worksheet for the form editor's Excel import. The workbooks are
// written here by hand, part by part, the way Excel lays them out, so the
// reader is checked against the file format rather than against itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const { zipSync, unzipSync, strToU8 } = require('fflate');

let X;
test.before(async () => { X = await import('../xlsx-read.js'); });

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function workbook({ sheets, shared = [], styles, theme, defined = '' }) {
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types/>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook ${NS}><sheets>${sheets.map((s, i) =>
  `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.state ? ` state="${s.state}"` : ''}/>`).join('')}</sheets>
${defined ? `<definedNames>${defined}</definedNames>` : ''}</workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) =>
  `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    'xl/sharedStrings.xml': `<sst ${NS} count="${shared.length}">${shared.map(s =>
      Array.isArray(s) ? `<si>${s.map(r => `<r><t xml:space="preserve">${r}</t></r>`).join('')}</si>` : `<si><t>${s}</t></si>`).join('')}</sst>`,
    'xl/styles.xml': styles ?? `<styleSheet ${NS}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<cellXfs count="1"><xf fontId="0" fillId="0"/></cellXfs></styleSheet>`
  };
  if (theme) files['xl/theme/theme1.xml'] = theme;
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = s.xml; });
  const z = {};
  for (const [k, v] of Object.entries(files)) z[k] = strToU8(v);
  return zipSync(z);
}

const STYLES = `<styleSheet ${NS}>
<fonts count="3">
  <font><sz val="11"/><name val="Calibri"/></font>
  <font><b/><sz val="14"/><name val="Calibri"/></font>
  <font><i/><sz val="8"/><name val="Arial"/></font>
</fonts>
<fills count="5">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor theme="0" tint="-0.249977111117893"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor indexed="22"/></patternFill></fill>
</fills>
<cellXfs count="6">
  <xf fontId="0" fillId="0"/>
  <xf fontId="1" fillId="2" applyAlignment="1"><alignment horizontal="center"/></xf>
  <xf fontId="2" fillId="0" applyAlignment="1"><alignment horizontal="right" wrapText="1"/></xf>
  <xf fontId="0" fillId="3"/>
  <xf fontId="0" fillId="4"/>
  <xf fontId="0" fillId="0" applyAlignment="1"><alignment horizontal="centerContinuous"/></xf>
</cellXfs></styleSheet>`;

const THEME = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`;

const FORM = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${NS}>
<dimension ref="A1:D5"/>
<sheetFormatPr defaultRowHeight="15"/>
<cols><col min="1" max="1" width="20.7109375" customWidth="1"/><col min="2" max="3" width="10" customWidth="1"/><col min="4" max="4" width="5" hidden="1"/></cols>
<sheetData>
<row r="1" ht="24" customHeight="1"><c r="A1" s="1" t="s"><v>0</v></c></row>
<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="3"/><c r="C2" t="inlineStr"><is><t>Job #:</t></is></c></row>
<row r="3"><c r="A3" s="2" t="s"><v>2</v></c><c r="B3" s="4"/><c r="C3"><v>42</v></c><c r="D3" t="s"><v>3</v></c></row>
<row r="4" hidden="1"><c r="A4" t="s"><v>3</v></c></row>
<row r="5"><c r="A5" t="s"><v>4</v></c><c r="B5" s="5" t="s"><v>5</v></c></row>
</sheetData>
<mergeCells count="2"><mergeCell ref="A1:C1"/><mergeCell ref="B5:D5"/></mergeCells>
<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape"/>
</worksheet>`;
const SHARED = ['Inspection Report', 'Part No.', 'Rich &amp; plain', 'hidden', 'Dimension', ['Gage', ' ID']];

const read = (bytes, i = 0) => X.openWorkbook(bytes, unzipSync).read(i);

test('text from shared strings, rich runs, inline strings and numbers', () => {
  const s = read(workbook({ sheets: [{ name: 'Form', xml: FORM }], shared: SHARED, styles: STYLES, theme: THEME }));
  assert.equal(s.cells['0,0'].text, 'Inspection Report');
  assert.equal(s.cells['1,0'].text, 'Part No.');
  assert.equal(s.cells['1,2'].text, 'Job #:');
  assert.equal(s.cells['2,0'].text, 'Rich & plain');
  assert.equal(s.cells['2,2'].text, '42');
  assert.equal(s.cells['3,1'].text, 'Gage ID');          // row 4 was hidden, so row 5 is now index 3
});

test('hidden rows and columns are left out, and merges shrink to what is left', () => {
  const s = read(workbook({ sheets: [{ name: 'Form', xml: FORM }], shared: SHARED, styles: STYLES, theme: THEME }));
  assert.equal(s.cols.length, 3);                          // D was hidden
  assert.equal(s.rows.length, 4);                          // row 4 was hidden
  assert.ok(!Object.values(s.cells).some(c => c.text === 'hidden'));
  assert.deepEqual(s.merges, [{ r: 0, c: 0, rs: 1, cs: 3 }, { r: 3, c: 1, rs: 1, cs: 2 }]);
});

test('sizes: column widths in Excel characters, row heights in points', () => {
  const s = read(workbook({ sheets: [{ name: 'Form', xml: FORM }], shared: SHARED, styles: STYLES, theme: THEME }));
  // The stored width already includes Excel's 5 px of padding (ECMA-376
  // 18.3.1.13): 20.7109375 is a 20-character column, 20 x 7 + 5 = 145 px at
  // Calibri 11's 7 px digit; 10 is 70 px.
  assert.equal(s.cols[0], +(145 / 96).toFixed(4));
  assert.equal(s.cols[1], +(70 / 96).toFixed(4));
  assert.ok(Math.abs(s.rows[0] - 24 / 72) < 1e-4);
  assert.ok(Math.abs(s.rows[1] - 15 / 72) < 1e-4);
});

test('look: bold, italic, size, font, alignment, wrap and fills of every kind', () => {
  const s = read(workbook({ sheets: [{ name: 'Form', xml: FORM }], shared: SHARED, styles: STYLES, theme: THEME }));
  assert.deepEqual(s.cells['0,0'], { text: 'Inspection Report', fill: '#d9d9d9', bold: true, size: 14, align: 'center', wrap: false });
  // Wrapped, right-aligned, italic 8pt Arial.
  assert.deepEqual(s.cells['2,0'], { text: 'Rich & plain', italic: true, size: 8, font: 'Arial', align: 'right' });
  // Theme 0 is lt1 (white), darkened 25%: Excel's "White, Background 1, Darker 25%".
  assert.equal(s.cells['1,1'].fill, '#bfbfbf');
  assert.equal(s.cells['2,1'].fill, '#c0c0c0');           // indexed 22
  assert.equal(s.cells['3,1'].align, 'center');            // centre across selection
  assert.equal(s.cells['2,2'].align, 'right');             // a General number sits right
  assert.equal(s.font.family, 'Calibri');
});

test('page setup comes across', () => {
  const s = read(workbook({ sheets: [{ name: 'Form', xml: FORM }], shared: SHARED, styles: STYLES, theme: THEME }));
  assert.deepEqual(s.page, { paper: 'a4', orientation: 'landscape', marginTop: 0.5, marginBottom: 0.6 });
});

test('the print area, when set, is what comes across', () => {
  const bytes = workbook({
    sheets: [{ name: 'Junk', xml: `<worksheet ${NS}><sheetData/></worksheet>` }, { name: 'Form', xml: FORM }],
    shared: SHARED, styles: STYLES, theme: THEME,
    defined: `<definedName name="_xlnm.Print_Area" localSheetId="1">Form!$A$1:$B$2</definedName>`
  });
  const wb = X.openWorkbook(bytes, unzipSync);
  assert.deepEqual(wb.sheets, ['Junk', 'Form']);
  const s = wb.read(1);
  assert.equal(s.cols.length, 2);
  assert.equal(s.rows.length, 2);
  assert.deepEqual(s.merges, [{ r: 0, c: 0, rs: 1, cs: 2 }]);
});

test('not a workbook says so', () => {
  assert.throws(() => X.openWorkbook(strToU8('hello'), unzipSync), /isn.t an Excel workbook/);
  assert.throws(() => X.openWorkbook(zipSync({ 'a.txt': strToU8('x') }), unzipSync), /isn.t an Excel workbook/);
});

test('the XML reader handles entities, CDATA and self-closing tags', () => {
  const x = X.parseXml('<?xml version="1.0"?><a k="1 &lt; 2"><b/><c>x &amp; y<![CDATA[<raw>]]></c></a>');
  const a = x.kids[0];
  assert.equal(a.attrs.k, '1 < 2');
  assert.equal(a.kids.length, 2);
  assert.equal(a.kids[1].text, 'x & y<raw>');
});

test('a merge whose first column is hidden keeps its text', () => {
  const xml = `<worksheet ${NS}><cols><col min="1" max="1" width="3" hidden="1"/></cols>
<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Title</t></is></c></row></sheetData>
<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells></worksheet>`;
  const s = read(workbook({ sheets: [{ name: 'S', xml }] }));
  assert.deepEqual(s.merges, [{ r: 0, c: 0, rs: 1, cs: 2 }]);
  assert.equal(s.cells['0,0'].text, 'Title');
});

test('blank rows that carry only formatting are still part of the sheet', () => {
  const xml = `<worksheet ${NS}><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Heading</t></is></c></row>
<row r="2"><c r="A2" s="1"/></row><row r="3"><c r="B3" s="1"/></row></sheetData></worksheet>`;
  const styles = `<styleSheet ${NS}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="2"><border/><border><left style="thin"/></border></borders>
<cellXfs count="2"><xf fontId="0" fillId="0" borderId="0"/><xf fontId="0" fillId="0" borderId="1"/></cellXfs></styleSheet>`;
  const s = read(workbook({ sheets: [{ name: 'S', xml }], styles }));
  assert.equal(s.rows.length, 3);
  assert.equal(s.cols.length, 2);
});

test("the sheet's dimension counts as used", () => {
  const xml = `<worksheet ${NS}><dimension ref="A1:C5"/><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>`;
  const s = read(workbook({ sheets: [{ name: 'S', xml }] }));
  assert.equal(s.rows.length, 5);
  assert.equal(s.cols.length, 3);
});
