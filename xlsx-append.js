'use strict';
// Appends plain-text worksheets to an existing workbook without disturbing it,
// for the Excel export (EXPORT-FORMAT.md). Runs in the main process, from the
// xlsx:append handler.
//
// A workbook is a zip of XML parts. Only the four that MUST change are
// rewritten --
//   xl/worksheets/sheetN.xml      (new, ours)
//   xl/workbook.xml               (one <sheet> element added)
//   xl/_rels/workbook.xml.rels    (one <Relationship> added)
//   [Content_Types].xml           (one <Override> added)
// -- and every other part is copied through byte for byte, never parsed:
// macros, printer settings, styles and the existing sheets are untouched.
//
// Values are inline strings (t="inlineStr"), so Excel can't read 1/4-20 as a
// date or .250 as 0.25, and sharedStrings.xml is never touched. No styles are
// referenced, so values show verbatim in the workbook's General format.

const { unzipSync, zipSync } = require('fflate');

const dec = u => Buffer.from(u).toString('utf8');
const enc = s => new Uint8Array(Buffer.from(s, 'utf8'));

// XML 1.0 has no escape for most control characters -- they cannot appear in a
// document at all, so they are dropped rather than encoded.
const xml = s => String(s ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// A1, B1 ... Z1, AA1 ...
function colName(i) {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
  return s;
}

// Excel's sheet-name rules: 31 characters, no : \ / ? * [ ], no leading or
// trailing apostrophe, not empty.
function legalName(name) {
  let s = String(name ?? '').replace(/[:\\/?*[\]]/g, '').replace(/^'+|'+$/g, '').trim();
  if (!s) s = 'Sheet';
  return s.slice(0, 31);
}

// A taken name gets a suffix, never an overwrite; the base is trimmed so it
// still fits in 31.
function uniqueName(name, taken) {
  const base = legalName(name);
  const low = new Set([...taken].map(t => t.toLowerCase()));
  if (!low.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`;
    const cand = base.slice(0, 31 - suffix.length) + suffix;
    if (!low.has(cand.toLowerCase())) return cand;
  }
  throw new Error(`cannot find a free sheet name for "${base}"`);
}

// columns: array of { header, values[] }. Ragged: a short column simply ends,
// unpadded.
function sheetXml(columns, offset) {
  const depth = Math.max(0, ...columns.map(c => c.values.length));
  const rows = [];

  const cell = (col, row, text) =>
    `<c r="${colName(col)}${row}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;

  const head = columns
    .map((c, i) => (c.header == null ? '' : cell(i + offset, 1, c.header)))
    .join('');
  if (head) rows.push(`<row r="1">${head}</row>`);

  for (let r = 0; r < depth; r++) {
    const cells = columns
      .map((c, i) => (r < c.values.length ? cell(i + offset, r + 2, c.values[r]) : ''))
      .join('');
    if (cells) rows.push(`<row r="${r + 2}">${cells}</row>`);
  }

  const last = `${colName(offset + columns.length - 1)}${depth + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

/**
 * @param {Buffer|Uint8Array} bytes  the workbook as read from disk
 * @param {Array<{name:string, columns:Array<{header:string, values:string[]}>, offset?:number}>} sheets
 * @returns {{bytes:Buffer, added:string[], untouched:number}}
 */
function appendSheets(bytes, sheets) {
  const zip = unzipSync(new Uint8Array(bytes));

  for (const req of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) {
    if (!zip[req]) throw new Error(`not a workbook: ${req} missing`);
  }

  let wb = dec(zip['xl/workbook.xml']);
  let rels = dec(zip['xl/_rels/workbook.xml.rels']);
  let types = dec(zip['[Content_Types].xml']);

  const taken = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map(m => m[1]);
  let maxSheetId = Math.max(0, ...[...wb.matchAll(/\bsheetId="(\d+)"/g)].map(m => +m[1]));
  let maxRel = Math.max(0, ...[...rels.matchAll(/\bId="rId(\d+)"/g)].map(m => +m[1]));
  let maxPart = Math.max(0, ...Object.keys(zip)
    .map(k => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(k))
    .filter(Boolean).map(m => +m[1]));

  // A workbook with no <sheets> is not one Excel wrote, but self-closing is
  // cheap to allow.
  if (!/<sheets>/.test(wb)) wb = wb.replace(/<sheets\s*\/>/, '<sheets></sheets>');
  if (!/<sheets>/.test(wb)) throw new Error('workbook.xml has no <sheets> element');

  const added = [];
  const newParts = {};

  for (const s of sheets) {
    const name = uniqueName(s.name, taken);
    taken.push(name);

    const partNo = ++maxPart;
    const rId = `rId${++maxRel}`;
    const sheetId = ++maxSheetId;
    const path = `xl/worksheets/sheet${partNo}.xml`;

    newParts[path] = enc(sheetXml(s.columns, s.offset ?? 0));

    wb = wb.replace('</sheets>',
      `<sheet name="${xml(name)}" sheetId="${sheetId}" r:id="${rId}"/></sheets>`);
    rels = rels.replace('</Relationships>',
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${partNo}.xml"/></Relationships>`);
    types = types.replace('</Types>',
      `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);

    added.push(name);
  }

  // Rebuilt in the original part order; [Content_Types].xml stays first.
  const out = {};
  let untouched = 0;
  for (const k of Object.keys(zip)) {
    if (k === 'xl/workbook.xml') out[k] = enc(wb);
    else if (k === 'xl/_rels/workbook.xml.rels') out[k] = enc(rels);
    else if (k === '[Content_Types].xml') out[k] = enc(types);
    else { out[k] = zip[k]; untouched++; }
  }
  for (const [k, v] of Object.entries(newParts)) out[k] = v;

  return { bytes: Buffer.from(zipSync(out, { level: 6 })), added, untouched };
}

module.exports = { appendSheets, legalName, uniqueName, colName };
