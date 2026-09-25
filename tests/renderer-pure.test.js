// Pure functions lifted out of renderer.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/load-renderer');

const R = loadRenderer([
  'cmpVersion', 'canonicalJson',
  'GEOM', 'geomFor', 'PAGE_ROWS', 'bandHeights', 'bandCount', 'paginateRows'
]);

test('cmpVersion compares numerically', () => {
  assert.ok(R.cmpVersion('0.10.0', '0.9.0') > 0);
  assert.ok(R.cmpVersion('0.37.0', '0.37.0') === 0);
  assert.ok(R.cmpVersion('1.0', '1.0.1') < 0);
  assert.ok(R.cmpVersion(null, '0.0.1') < 0);
});

test('canonicalJson is independent of key order', () => {
  const a = R.canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } });
  const b = R.canonicalJson({ a: { c: null, d: [2, { x: 2, y: 1 }] }, b: 1 });
  assert.equal(a, b);
  assert.equal(R.canonicalJson({ u: undefined }), '{"u":null}');
});

const rows = (n, subsEvery = 0) => Array.from({ length: n }, (_, i) =>
  ({ number: i, isSub: subsEvery > 0 && i % subsEvery !== 0 }));

test('a short in-process sheet bands onto one page', () => {
  assert.ok(R.bandCount('in-process', 'landscape', 5) > 1);
  assert.equal(R.paginateRows(rows(5), 'landscape', 'in-process').length, 1);
});

test('other forms never band', () => {
  assert.equal(R.bandCount('first-article', 'landscape', 5), 1);
  assert.equal(R.bandCount('in-process', 'landscape', 0), 1);
});

test('pages hold at most PAGE_ROWS rows', () => {
  for (const o of ['portrait', 'landscape']) {
    const cap = R.PAGE_ROWS[o];
    const pages = R.paginateRows(rows(cap * 2 + 3), o, 'final');
    assert.equal(pages.length, 3);
    for (const p of pages) assert.ok(p.length <= cap);
    assert.equal(pages.flat().length, cap * 2 + 3);
  }
});

test('a characteristic and its subs are never split across pages', () => {
  const cap = R.PAGE_ROWS.landscape;
  const pages = R.paginateRows(rows(cap * 3, 4), 'landscape', 'final');
  for (const p of pages) assert.equal(p[0].isSub, false);
  assert.equal(pages.flat().length, cap * 3);
});

// Values from the sandbox are compared as JSON: its arrays have their own
// prototype, which deepEqual treats as a difference.
test('an empty sheet is one empty page', () => {
  assert.equal(JSON.stringify(R.paginateRows([], 'portrait', 'final')), '[[]]');
});
