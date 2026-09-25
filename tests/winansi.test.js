// Text stamped onto a drawing with Helvetica (the fallback when the symbol font
// isn't embedded) must never throw, and must print what was typed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { loadRenderer } = require('./helpers/load-renderer');
const SYMBOLS = require('../assets/symbols.json');

const { toWinAnsi } = loadRenderer(['WINANSI_EXTRA', 'WINANSI_STANDIN', 'toWinAnsi']);

test('what WinAnsi can say passes through unchanged', () => {
  for (const t of ['±.005', '45°', 'Ø.375 THRU', 'µin', '“quoted” – note', 'R.03 TYP']) {
    assert.equal(toWinAnsi(t), t);
  }
});

test('symbols with a readable stand-in get it; the rest become ?', () => {
  assert.equal(toWinAnsi('⌀.375'), 'Ø.375');
  assert.equal(toWinAnsi('≤ .5'), '<= .5');
  assert.equal(toWinAnsi('⌖ .010'), '? .010');
  assert.equal(toWinAnsi('a\tb'), 'a b');
  assert.equal(toWinAnsi(''), '');
  assert.equal(toWinAnsi(null), '');
});

test('every symbol and font slot stamps in Helvetica without throwing', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const fonts = await Promise.all([
    StandardFonts.Helvetica, StandardFonts.HelveticaBold,
    StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique
  ].map(f => doc.embedFont(f)));
  const rows = Object.values(SYMBOLS.groups).flat();
  const text = rows.map(r => `${r.unicode}${r.slot} ${r.label}`).join(' ') + ' ≠ ∞ ✓ 😀';
  for (const font of fonts) {
    assert.doesNotThrow(() => page.drawText(toWinAnsi(text), { font, size: 8, x: 10, y: 10 }));
  }
});
