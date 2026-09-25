// The share crawl behind Rebuild index and the source resolver. The shapes
// mirror tools/mockshare.bat, with real packages in the package folders.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadMain } = require('./helpers/load-main');
const { makeShare } = require('./helpers/share');

const { crawl, config } = loadMain();
config.PACKAGE_DIR = 'QC';
config.ARCHIVE_DIR = 'Archive';
console.info = () => {};                     // crawl's shape diagnostics

const ids = entries => entries.map(e => e.packageId).sort();

function buildShare(t) {
  const s = makeShare(t);
  s.pkg('Customer 01/PN-0101/QC/common.insp');                          // depth 3
  s.pkg('Customer 01/PN-0102/QC/live.insp');
  s.pkg('Customer 01/PN-0102/QC/Archive/archived.insp');
  s.pkg('Customer 02/PN-0201/qc/lowercase.insp');                       // case-insensitive
  s.pkg('Acme & Sons/PN-AMP/QC/ampersand.insp');
  s.pkg("O'Brien Tooling/PN-APO/QC/apostrophe.insp");
  s.pkg('Customer 03/Turbine Family/PN-0301/QC/family.insp');            // depth 4
  s.pkg('Customer 04/Deep Family/PN-0401/Old Revs/QC/too-deep.insp');    // depth 5
  s.pkg('Customer 05/PN-0501/QC/part.insp');
  s.pkg('Customer 05/PN-0501/Setups/QC/below-part.insp');                // under a part folder
  s.dir('Customer 06 (empty)');
  s.file('Customer 07 (files only)/notes.txt', 'x');
  s.file('Customer 01/PN-0101/QC/readme.txt', 'not a package');
  return s;
}

test('finds every package in reach, and nothing out of it', async t => {
  const s = buildShare(t);
  const found = await crawl(s.root, 4, () => {});
  assert.deepEqual(ids(found), [
    'ampersand', 'apostrophe', 'common', 'family', 'live', 'lowercase', 'part'
  ]);
});

test('Archive folders are read only when asked', async t => {
  const s = buildShare(t);
  const found = await crawl(s.root, 4, () => {}, { includeArchive: true });
  const archived = found.filter(e => e.archived).map(e => e.packageId);
  assert.deepEqual(archived, ['archived']);
});

test('deeper SEARCH_DEPTH reaches deeper package folders', async t => {
  const s = buildShare(t);
  const found = await crawl(s.root, 5, () => {});
  assert.ok(ids(found).includes('too-deep'));
  assert.ok(!ids(found).includes('below-part'), 'never walks below a part folder');
});

test('a package folder directly in the root is read, and the root still walked', async t => {
  const s = makeShare(t);
  s.pkg('QC/mega1.insp');
  s.pkg('QC/mega2.insp');
  s.pkg('ACME/PN-1/QC/nested.insp');
  const found = await crawl(s.root, 4, () => {});
  assert.deepEqual(ids(found), ['mega1', 'mega2', 'nested']);
});

test('a name hint opens only matching part folders', async t => {
  const s = buildShare(t);
  const found = await crawl(s.root, 4, () => {}, { nameHint: 'pn-0301' });
  assert.deepEqual(ids(found), ['family']);
});

// One worker walks breadth-first, so every depth-2 part folder is read before
// any depth-3 one: stopping on 'common' (depth 2) must leave 'family' (depth 3)
// unread.
test('stopWhen stops the walk at the first match', async t => {
  const s = buildShare(t);
  const found = await crawl(s.root, 4, () => {}, {
    fanout: 1, stopWhen: rec => rec.packageId === 'common'
  });
  assert.equal(found.at(-1).packageId, 'common');
  assert.ok(!ids(found).includes('family'));
});

// With several workers, reads already in flight when the match lands are
// still returned; the resolver filters them and indexes them anyway.
test('stopWhen with parallel workers still returns the match', async t => {
  const s = buildShare(t);
  const found = await crawl(s.root, 4, () => {}, {
    stopWhen: rec => rec.packageId === 'family'
  });
  assert.ok(ids(found).includes('family'));
});

test('an unreadable package is skipped, not fatal', async t => {
  const s = buildShare(t);
  s.file('Customer 02/PN-0201/qc/broken.insp', 'not a zip');
  const warn = console.warn; console.warn = () => {};
  t.after(() => { console.warn = warn; });
  const found = await crawl(s.root, 4, () => {});
  assert.ok(ids(found).includes('lowercase'));
  assert.ok(!ids(found).includes('broken'));
});

test('final progress reports folders listed', async t => {
  const s = buildShare(t);
  const reports = [];
  await crawl(s.root, 4, p => reports.push(p));
  const last = reports.at(-1);
  assert.equal(last.count, 7);
  assert.ok(last.scanned > 10);
  assert.equal(last.unreadable, 0);
});
