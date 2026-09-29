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

// ---- record hash ------------------------------------------------------------

let core;
test.before(async () => {
  const { readCustom } = await import('../sheet-template.js');
  core = loadRenderer(['customProp', 'inspectionCore'], { readCustom }).inspectionCore;
});

const record = {
  id: 'insp_5', sheetId: 'sht_4', sheetName: 'Final', stage: 'final', orientation: 'portrait',
  jobNumber: 'J-1', machine: 'M3', author: 'JH', editDate: '9/28', bandCount: 1, columnCount: 1,
  bands: [{ columns: [['9/28']] }], createdUtc: '2026-09-28T00:00:00Z',
  rows: [{ type: 'characteristic', ref: 'el_2', number: 1, spec: '1.000', method: 'Caliper',
           bands: [{ gageId: 'MIC-1', values: ['1.001'] }] }]
};

test('a record without custom values keeps the hash it always had', () => {
  // The core as it was before custom values existed, written out by hand.
  const before = {
    id: 'insp_5', sheetId: 'sht_4', sheetName: 'Final', stage: 'final', orientation: 'portrait',
    jobNumber: 'J-1', machine: 'M3', author: 'JH', editDate: '9/28', bandCount: 1, columnCount: 1,
    bands: [{ columns: [['9/28']] }], createdUtc: '2026-09-28T00:00:00Z',
    rows: [{ type: 'characteristic', ref: 'el_2', number: 1, spec: '1.000', method: 'Caliper',
             bands: [{ gageId: 'MIC-1', values: ['1.001'] }] }]
  };
  assert.equal(JSON.stringify(core(record)), JSON.stringify(before));
  assert.equal(JSON.stringify(core({ ...record, custom: {}, sheetCustom: { lot: '' } })),
               JSON.stringify(before));
});

test('custom values are part of what a record hash covers', () => {
  const c = core({ ...record, custom: { heat_lot: 'H-77' }, sheetCustom: { station: '4' } });
  assert.equal(JSON.stringify(c.custom), '{"heat_lot":"H-77"}');
  assert.equal(JSON.stringify(c.sheetCustom), '{"station":"4"}');
});
