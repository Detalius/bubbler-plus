// Pure functions lifted out of renderer.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRenderer } = require('./helpers/load-renderer');

const R = loadRenderer(['cmpVersion']);

test('cmpVersion compares numerically', () => {
  assert.ok(R.cmpVersion('0.10.0', '0.9.0') > 0);
  assert.ok(R.cmpVersion('0.37.0', '0.37.0') === 0);
  assert.ok(R.cmpVersion('1.0', '1.0.1') < 0);
  assert.ok(R.cmpVersion(null, '0.0.1') < 0);
});
