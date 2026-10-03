// The bundled symbol font has every symbol the app offers, at its Unicode
// codepoint (symbols.json's slot === unicode), plus the everyday characters
// dimensions use. Rebuild with tools/font/build.py.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fontkit = require('@pdf-lib/fontkit');

const ASSETS = path.join(__dirname, '..', 'assets');
const symbols = JSON.parse(fs.readFileSync(path.join(ASSETS, 'symbols.json'), 'utf8'));
const font = fontkit.create(fs.readFileSync(path.join(ASSETS, symbols.font.file)));
const rows = Object.values(symbols.groups).flat();

test('the font is the one symbols.json names', () => {
  assert.equal(font.familyName, symbols.font.family);
});

test('every symbol is in the font, at its own codepoint', () => {
  const missing = rows.filter(s => !font.hasGlyphForCodePoint(s.unicode.codePointAt(0))).map(s => s.key);
  assert.deepEqual(missing, []);
  assert.deepEqual(rows.filter(s => s.slot !== s.unicode).map(s => s.key), []);
});

test('the everyday characters of a dimension are there too', () => {
  const missing = [...'0123456789.,-+/()X×½¼¾⅛°±µ≤≥Ø RrMm'].filter(c => !font.hasGlyphForCodePoint(c.codePointAt(0)));
  assert.deepEqual(missing, []);
});
