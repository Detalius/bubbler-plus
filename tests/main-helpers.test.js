const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadMain } = require('./helpers/load-main');
const { loadRenderer } = require('./helpers/load-renderer');

const { writeUnique, drawingSetHash, samePath } = loadMain();
const { drawingSetString } = loadRenderer(['drawingSetString']);

test('writeUnique never overwrites', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbler-wu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'Part_Sheet.pdf');
  fs.writeFileSync(target, 'existing');
  const a = await writeUnique(target, new Uint8Array([1]));
  const b = await writeUnique(target, new Uint8Array([2]));
  assert.equal(path.basename(a), 'Part_Sheet (2).pdf');
  assert.equal(path.basename(b), 'Part_Sheet (3).pdf');
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing');
});

test('writeUnique: two writers racing for one name both land', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbler-wu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'x.pdf');
  const got = await Promise.all([1, 2, 3].map(n => writeUnique(target, new Uint8Array([n]))));
  assert.equal(new Set(got).size, 3);
});

test("main's drawingSetHash matches the renderer's canonical string", () => {
  const list = ['bbb', 'aaa', '', null, 'bbb', 'ccc'];
  const expected = crypto.createHash('sha256').update(drawingSetString(list), 'utf8').digest('hex');
  assert.equal(drawingSetHash(list), expected);
  assert.equal(drawingSetString(list), 'aaa\nbbb\nccc');
});

test('drawingSetHash ignores order and duplicates, and is null for nothing', () => {
  assert.equal(drawingSetHash(['a', 'b']), drawingSetHash(['b', 'a', 'a']));
  assert.equal(drawingSetHash([]), null);
  assert.equal(drawingSetHash(['', null]), null);
});

test('samePath ignores trailing separators', () => {
  assert.ok(samePath('/a/b/', '/a/b'));
  assert.ok(!samePath('/a/b', '/a/c'));
  assert.ok(!samePath('', '/a'));
});
