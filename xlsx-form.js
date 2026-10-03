// A form as an Excel workbook: a carbon copy of what prints, data and all, for
// sending to customers. There is no second layout engine. buildPage() draws
// each page exactly as the PDF has it; pageModel() reads that table into a
// plain model, and formWorkbook() writes the models out as one worksheet,
// pages stacked with a page break after each. The data export
// (EXPORT-FORMAT.md) is a separate thing and doesn't come through here.

const EMU = 914400;                    // EMUs per inch, for pictures
const PX = 96;                         // the pixel Excel's column widths count in

// ---------------------------------------------------------------------------
// Reading a page drawn by buildPage()
// ---------------------------------------------------------------------------
const inches = v => (/in$/.test(v || '') ? parseFloat(v) : null);
const points = v => (/pt$/.test(v || '') ? parseFloat(v) : null);
function hexOf(css) {
  if (!css) return null;
  if (/^#[0-9a-f]{6}$/i.test(css)) return css.toLowerCase();
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  return m ? '#' + [m[1], m[2], m[3]].map(n => (+n).toString(16).padStart(2, '0')).join('') : null;
}

// One page (`paper`, a .paper element) as { cols, rows, cells }: widths and
// heights in inches; cells with their place, span, text, look and borders.
// `rowHeight` stands in for a row whose cells all span from above.
export function pageModel(paper, { rowHeight = 0.2 } = {}) {
  const table = paper.querySelector('table');
  const cols = [...table.querySelectorAll('col')].map(c => inches(c.style.width) ?? 0.5);
  const base = {
    size: points(paper.style.fontSize) ?? 8,
    font: (paper.style.fontFamily || 'Arial').split(',')[0].replace(/['"]/g, '').trim()
  };
  const taken = new Set();
  const cells = [], rows = [];
  [...table.querySelectorAll('tr')].forEach((tr, r) => {
    let c = 0;
    for (const td of tr.children) {
      while (taken.has(`${r},${c}`)) c++;
      const rs = td.rowSpan || 1, cs = td.colSpan || 1;
      for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) taken.add(`${y},${x}`);
      const h = inches(td.style.height);
      if (rs === 1 && h != null) rows[r] = Math.max(rows[r] ?? 0, h);
      const cl = td.classList;
      const st = td.style;
      const fam = st.fontFamily || '';
      cells.push({
        r, c, rs, cs,
        text: cl.contains('chl') ? (td.querySelector('span')?.textContent ?? '') : (cl.contains('logo') ? '' : td.textContent),
        logo: cl.contains('logo'),
        border: cl.contains('pad') ? 'none' : cl.contains('ch') ? 'noLeft' : cl.contains('chl') ? 'noRight' : 'all',
        look: {
          fill: hexOf(st.backgroundColor || st.background),
          size: points(st.fontSize) ?? base.size,
          bold: st.fontWeight === 'bold' || +st.fontWeight >= 600,
          italic: st.fontStyle === 'italic',
          align: st.textAlign || (cl.contains('logo') ? 'center' : 'left'),
          wrap: st.whiteSpace !== 'nowrap' && !cl.contains('chl'),
          symbol: /SimpleGeoDim/i.test(fam),
          font: fam ? fam.split(',')[0].replace(/['"]/g, '').trim() : base.font
        }
      });
      c += cs;
    }
  });
  const nRows = Math.max(rows.length, ...cells.map(x => x.r + x.rs));
  for (let r = 0; r < nRows; r++) if (rows[r] == null) rows[r] = rowHeight;
  return { cols, rows, cells };
}

// ---------------------------------------------------------------------------
// Writing the workbook
// ---------------------------------------------------------------------------
const xml = s => String(s ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colLetter = c => {
  let s = '';
  for (c += 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + (c - 1) % 26) + s;
  return s;
};
const ref = (r, c) => `${colLetter(c)}${r + 1}`;
// Excel prints a column a little wider than its pixels (it measures in its
// default font's characters), so the page is set to fit one page wide; the
// manual breaks still decide where pages end.
// Excel's stored column width: characters of the default font's 7 px digit,
// padding included (ECMA-376 18.3.1.13), so a column comes back the pixels it was.
const colWidth = inch => Math.trunc((Math.round(inch * PX) / 7) * 256) / 256;
const PAPER = [[1, 8.5, 11], [5, 8.5, 14], [9, 8.2677, 11.6929]];
// GD&T symbols are written as Unicode; this Windows font has them all.
const SYMBOL_FONT = 'Segoe UI Symbol';

const enc = s => new TextEncoder().encode(s);

// PNG pixel size, from its header, for keeping the logo's proportions.
function pngSize(bytes) {
  if (!bytes || bytes.length < 24 || bytes[1] !== 0x50) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

// pages: [pageModel], all of one form. opts: { sheetName, page: { size,
// marginTop, marginBottom }, footer: [{ text, align, size, bottom }] with
// `text` already filled in except {page.number} / {page.count}, logo: PNG bytes
// or null }. Returns the .xlsx bytes. `zipSync` is fflate's.
export function formWorkbook(pages, opts, zipSync) {
  const cols = pages[0].cols;
  const fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const BORDER = {
    none: '<border><left/><right/><top/><bottom/><diagonal/></border>',
    all: '<border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border>',
    noLeft: '<border><left/><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border>',
    noRight: '<border><left style="thin"><color rgb="FF000000"/></left><right/><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border>'
  };
  const borders = Object.values(BORDER);
  const borderId = Object.fromEntries(Object.keys(BORDER).map((k, i) => [k, i]));
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const ids = new Map();
  const intern = (list, s) => { let i = list.indexOf(s); if (i < 0) { list.push(s); i = list.length - 1; } return i; };
  const styleOf = cell => {
    const L = cell.look;
    const name = L.symbol ? SYMBOL_FONT : (L.font || 'Arial');
    const font = intern(fonts, `<font>${L.bold ? '<b/>' : ''}${L.italic ? '<i/>' : ''}<sz val="${+L.size.toFixed(2)}"/><name val="${xml(name)}"/></font>`);
    const fill = L.fill
      ? intern(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${L.fill.slice(1).toUpperCase()}"/><bgColor indexed="64"/></patternFill></fill>`)
      : 0;
    const h = { center: 'center', right: 'right' }[L.align] || 'left';
    const xf = `<xf numFmtId="0" fontId="${font}" fillId="${fill}" borderId="${borderId[cell.border] ?? 1}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="${h}" vertical="center"${L.wrap ? ' wrapText="1"' : ''}/></xf>`;
    if (!ids.has(xf)) { xfs.push(xf); ids.set(xf, xfs.length - 1); }
    return ids.get(xf);
  };

  // Every page, one under the next.
  const grid = new Map();             // "r,c" -> { s, text }
  const merges = [], heights = [], breaks = [], logos = [];
  let top = 0;
  for (const p of pages) {
    p.rows.forEach((h, i) => { heights[top + i] = h; });
    for (const cell of p.cells) {
      const s = styleOf(cell);
      const r = top + cell.r;
      // A merged cell's borders and fill belong to every cell under it.
      for (let y = r; y < r + cell.rs; y++) for (let x = cell.c; x < cell.c + cell.cs; x++) {
        grid.set(`${y},${x}`, { s, text: y === r && x === cell.c ? cell.text : '' });
      }
      if (cell.rs > 1 || cell.cs > 1) merges.push(`${ref(r, cell.c)}:${ref(r + cell.rs - 1, cell.c + cell.cs - 1)}`);
      if (cell.logo) logos.push({ r, c: cell.c, rs: cell.rs, cs: cell.cs });
    }
    top += p.rows.length;
    breaks.push(top);
  }
  breaks.pop();                       // none after the last page

  const sheetRows = [];
  for (let r = 0; r < heights.length; r++) {
    const cells = [];
    for (let c = 0; c < cols.length; c++) {
      const g = grid.get(`${r},${c}`);
      if (!g) continue;
      cells.push(g.text
        ? `<c r="${ref(r, c)}" s="${g.s}" t="inlineStr"><is><t xml:space="preserve">${xml(g.text)}</t></is></c>`
        : `<c r="${ref(r, c)}" s="${g.s}"/>`);
    }
    sheetRows.push(`<row r="${r + 1}" ht="${+(heights[r] * 72).toFixed(2)}" customHeight="1">${cells.join('')}</row>`);
  }

  const [pw, ph] = opts.page.size;
  const landscape = pw > ph;
  const [short, long] = [Math.min(pw, ph), Math.max(pw, ph)];
  const paper = PAPER.find(([, a, b]) => Math.abs(a - short) < 0.02 && Math.abs(b - long) < 0.02)?.[0] ?? 1;
  const side = Math.max(0, (pw - cols.reduce((a, b) => a + b, 0)) / 2);
  const footerAt = Math.min(...(opts.footer ?? []).map(f => f.bottom ?? 0.13), opts.page.marginBottom);

  // The template's footer as Excel's page footer: &P and &N are its page
  // number and count, and && is a literal ampersand.
  const sections = { left: [], center: [], right: [] };
  for (const f of opts.footer ?? []) {
    const t = String(f.text).replace(/&/g, '&&')
      .replace(/\{\s*page\.number\s*\}/g, '&P').replace(/\{\s*page\.count\s*\}/g, '&N');
    (sections[f.align] ?? sections.left).push(`${f.size ? `&${Math.round(f.size)}` : ''}${t}`);
  }
  const footer = (sections.left.length ? '&L' + sections.left.join(' ') : '')
    + (sections.center.length ? '&C' + sections.center.join(' ') : '')
    + (sections.right.length ? '&R' + sections.right.join(' ') : '');

  const logo = opts.logo && logos.length ? opts.logo : null;
  const files = {};
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${colWidth(w)}" customWidth="1"/>`).join('')}</cols>
<sheetData>${sheetRows.join('')}</sheetData>
${merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}
<printOptions horizontalCentered="1"/>
<pageMargins left="${+Math.min(side, 0.25).toFixed(4)}" right="${+Math.min(side, 0.25).toFixed(4)}" top="${+opts.page.marginTop.toFixed(4)}" bottom="${+opts.page.marginBottom.toFixed(4)}" header="0" footer="${+footerAt.toFixed(4)}"/>
<pageSetup paperSize="${paper}" orientation="${landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>
${footer ? `<headerFooter><oddFooter>${xml(footer)}</oddFooter></headerFooter>` : ''}
${breaks.length ? `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.map(b => `<brk id="${b}" max="16383" man="1"/>`).join('')}</rowBreaks>` : ''}
${logo ? '<drawing r:id="rId1"/>' : ''}
</worksheet>`;
  files['xl/worksheets/sheet1.xml'] = sheet;

  if (logo) {
    // Fitted inside the logo's cell, keeping its proportions, on every page.
    const size = pngSize(logo) ?? { w: 1, h: 1 };
    const at = (list, from, offset) => {
      let i = from, rest = offset;
      while (i < list.length - 1 && rest >= list[i]) { rest -= list[i]; i++; }
      return [i, Math.round(rest * EMU)];
    };
    const anchors = logos.map((L, k) => {
      const bw = cols.slice(L.c, L.c + L.cs).reduce((a, b) => a + b, 0) * 0.96;
      const bh = heights.slice(L.r, L.r + L.rs).reduce((a, b) => a + b, 0) * 0.92;
      const sc = Math.min(bw / size.w, bh / size.h);
      const w = size.w * sc, h = size.h * sc;
      const ox = (bw / 0.96 - w) / 2, oy = (bh / 0.92 - h) / 2;
      const [c, cOff] = at(cols, L.c, ox), [r, rOff] = at(heights, L.r, oy);
      return `<xdr:oneCellAnchor><xdr:from><xdr:col>${c}</xdr:col><xdr:colOff>${cOff}</xdr:colOff><xdr:row>${r}</xdr:row><xdr:rowOff>${rOff}</xdr:rowOff></xdr:from>
<xdr:ext cx="${Math.round(w * EMU)}" cy="${Math.round(h * EMU)}"/>
<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${k + 2}" name="Logo ${k + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(w * EMU)}" cy="${Math.round(h * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>
<xdr:clientData/></xdr:oneCellAnchor>`;
    });
    files['xl/drawings/drawing1.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.join('')}</xdr:wsDr>`;
    files['xl/drawings/_rels/drawing1.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`;
    files['xl/worksheets/_rels/sheet1.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`;
  }

  const name = sheetName(opts.sheetName);
  files['[Content_Types].xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${logo ? '<Default Extension="png" ContentType="image/png"/>' : ''}
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${logo ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''}
</Types>`;
  files['_rels/.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  files['xl/workbook.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  files['xl/styles.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="${fonts.length}">${fonts.join('')}</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="${borders.length}">${borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const z = {};
  for (const [k, v] of Object.entries(files)) z[k] = enc(v);
  if (logo) z['xl/media/image1.png'] = logo;
  return zipSync(z, { level: 6 });
}

// A worksheet name Excel accepts: 31 characters, none of : \ / ? * [ ].
export function sheetName(s) {
  const n = String(s ?? '').replace(/[:\\/?*[\]]/g, '').replace(/^'+|'+$/g, '').trim().slice(0, 31);
  return n || 'Sheet';
}
