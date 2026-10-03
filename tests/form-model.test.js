// The form editor's grid model: every built-in survives the trip into the grid
// and back, judged by what PRINTS rather than by the JSON, plus the edits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'assets', 'templates');
const builtins = fs.readdirSync(DIR).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const clone = o => JSON.parse(JSON.stringify(o));

let F, T;
test.before(async () => {
  F = await import('../form-model.js');
  T = await import('../sheet-template.js');
});

// What a template prints, as rectangles in inches, worked out from the format
// alone (TEMPLATE-FORMAT.md), not from form-model.js. Two templates that flatten
// the same print the same, whatever their columns and style names.
const LOOK = ['fill', 'size', 'bold', 'italic', 'align', 'wrap', 'font'];
function flatten(t) {
  const r4 = v => Math.round(v * 1e4) / 1e4;
  const look = name => {
    const st = (name && t.styles?.[name]) || {};
    const out = {};
    for (const k of LOOK) {
      const v = st[k];
      if (v == null) continue;
      if (k === 'size' && v === t.font?.size) continue;
      if (k === 'wrap' && v !== false) continue;
      if ((k === 'bold' || k === 'italic') && !v) continue;
      if (k === 'align' && v === 'left') continue;
      out[k] = v;
    }
    return JSON.stringify(out);
  };
  const sum = a => a.reduce((s, x) => s + x, 0);
  const hw = sum(t.header.columns);
  const chk = t.body.columns.find(c => c.repeat != null);
  const bw = sum(t.body.columns.map(c => c.width * (c.repeat ?? 1)));
  const W = Math.max(hw, bw);
  const out = [];
  const rect = (x, y, w, h, what, st) => out.push([r4(x), r4(y), r4(w), r4(h), what, st].join('|'));

  // Header: every position, covered by a cell or drawn blank.
  const H = t.header, hx = [(W - hw) / 2], hy = [0];
  for (const w of H.columns) hx.push(hx.at(-1) + w);
  for (const h of H.rows) hy.push(hy.at(-1) + h);
  const taken = new Set();
  for (const c of H.cells) {
    const [r, k] = c.at, [rs, cs] = c.span ?? [1, 1];
    for (let y = r; y < r + rs; y++) for (let x = k; x < k + cs; x++) taken.add(`${y},${x}`);
    const what = c.logo ? 'LOGO' : c.bind != null ? `{${c.bind}}` : (c.text ?? '');
    rect(hx[k], hy[r], hx[k + cs] - hx[k], hy[r + rs] - hy[r], what, look(c.style));
  }
  for (let r = 0; r < H.rows.length; r++) for (let k = 0; k < H.columns.length; k++) {
    if (!taken.has(`${r},${k}`)) rect(hx[k], hy[r], hx[k + 1] - hx[k], hy[r + 1] - hy[r], '', look(null));
  }

  // Body: the heading block and one data row.
  const B = t.body, nLab = chk ? chk.labels.length : 1;
  const y0 = hy.at(-1), lh = B.labelRowHeight, y1 = y0 + nLab * lh;
  let x = (W - bw) / 2;
  B.columns.forEach((c, i) => {
    if (c.repeat != null) {
      for (let k = 0; k < c.repeat; k++) {
        c.labels.forEach((l, li) => {
          rect(x, y0 + li * lh, c.labelWidth, lh, `label:${l}`, look(c.labelStyle));
          rect(x + c.labelWidth, y0 + li * lh, c.width - c.labelWidth, lh, 'box', look(c.headStyle));
        });
        rect(x, y1, c.width, B.rowHeight, 'check', look(c.style));
        x += c.width;
      }
      return;
    }
    const coveredBy = B.columns.slice(0, i).some((p, pi) => p.repeat == null && (p.headingSpan ?? 1) > i - pi);
    if (!coveredBy) {
      const span = c.headingSpan ?? 1;
      const w = sum(B.columns.slice(i, i + span).map(p => p.width));
      rect(x, y0, w, nLab * lh, `heading:${c.heading ?? ''}`, look(B.headingStyle));
    }
    rect(x, y1, c.width, B.rowHeight, c.bind, look(c.style));
    x += c.width;
  });
  return {
    rects: out.sort(),
    id: t.id, name: t.name, stage: t.stage ?? null, page: t.page, font: t.font,
    bands: B.bands, rowHeight: B.rowHeight, section: look(B.sectionStyle),
    fields: Object.fromEntries((t.fields ?? []).map(f => [f.key, f.label])),
    footer: t.footer ?? []
  };
}

test('every built-in goes into the grid and comes back printing the same', () => {
  for (const t of builtins) {
    const G = F.templateToGrid(clone(t));
    const { template, problems } = F.checkGrid(G);
    assert.deepEqual(problems, [], t.id);
    assert.deepEqual(T.validateTemplate(template), [], t.id);
    assert.deepEqual(flatten(template), flatten(t), t.id);
  }
});

test('the header comes back with the columns it had, not the shared grid’s', () => {
  for (const t of builtins) {
    const { template } = F.checkGrid(F.templateToGrid(clone(t)));
    assert.deepEqual(template.header.columns.map(w => +w.toFixed(4)), t.header.columns.map(w => +w.toFixed(4)), t.id);
  }
});

test('the grid shows the check column as many times as it prints', () => {
  const ipi = builtins.find(t => t.id === 'ipi-landscape');
  const G = F.templateToGrid(clone(ipi));
  assert.equal(F.checkRun(G).n, 8);
  assert.equal(G.headRows, 3);
  assert.equal(G.table, ipi.header.rows.length);
});

test('flatten notices a real difference (the comparison can fail)', () => {
  const ipi = builtins.find(t => t.id === 'ipi-landscape');
  const G = F.templateToGrid(clone(ipi));
  F.setText(G, 1, 2, 'Client');                     // "Customer" label, a literal now
  const { template } = F.checkGrid(G);
  assert.notDeepEqual(flatten(template).rects, flatten(ipi).rects);
});

test('a painted cell in the data row becomes a column; an unpainted one is named', () => {
  const G = F.blankGrid();
  const dr = F.dataRow(G);
  let r = F.checkGrid(G);
  assert.equal(r.template, null);
  assert.match(r.problems[0].msg, /Paint the table/);
  F.paint(G, dr, 0, 'body.number');
  F.paint(G, dr, 2, 'body.spec');
  r = F.checkGrid(G);
  assert.equal(r.template, null);
  assert.deepEqual(r.problems[0].at, [dr, 1]);
  F.paint(G, dr, 1, 'body.method');
  r = F.checkGrid(G);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.template.body.columns.map(c => c.bind), ['number', 'method', 'spec']);
});

test('unpainted columns at the table’s edges are left out, not errors', () => {
  const G = F.blankGrid();
  F.paint(G, F.dataRow(G), 3, 'body.spec');
  const { template, problems } = F.checkGrid(G);
  assert.deepEqual(problems, []);
  assert.equal(template.body.columns.length, 1);
  assert.equal(template.body.columns[0].width, G.cols[3]);
});

test('a merge across the table line is refused, pointing at it', () => {
  const G = F.blankGrid();
  F.paint(G, F.dataRow(G), 0, 'body.spec');
  F.merge(G, G.table - 1, 2, G.table, 3);
  const { template, problems } = F.checkGrid(G);
  assert.equal(template, null);
  assert.deepEqual(problems[0].at, [G.table - 1, 2]);
});

test('header paint becomes bindings, and declares the fields that need it', () => {
  const G = F.blankGrid();
  F.paint(G, F.dataRow(G), 0, 'body.spec');
  F.paint(G, 0, 0, 'part.number');
  F.paint(G, 0, 1, 'record.jobNumber');
  const k = F.customKeyFor('Heat Lot:', 'record');
  assert.equal(k, 'record.heat_lot');
  G.fields[k] = 'Heat Lot';
  F.paint(G, 1, 0, k);
  const { template, problems } = F.checkGrid(G);
  assert.deepEqual(problems, []);
  assert.deepEqual(template.fields, [
    { key: 'record.jobNumber', label: 'Job Number' },
    { key: 'record.heat_lot', label: 'Heat Lot' }
  ]);
  assert.ok(template.header.cells.some(c => c.bind === 'part.number'));
});

test('custom keys stay valid and unique', () => {
  assert.equal(F.customKeyFor('  2nd Op #  ', 'sheet'), 'sheet.nd_op');
  assert.equal(F.customKeyFor('???', 'sheet'), 'sheet.field');
  assert.equal(F.customKeyFor('Heat Lot', 'record', new Set(['record.heat_lot'])), 'record.heat_lot_2');
  // Never a built-in's key.
  assert.equal(F.customKeyFor('machine', 'record'), 'record.machine_2');
});

test('check repeat: more copies keep the run’s width and the header follows', () => {
  const ipi = builtins.find(t => t.id === 'ipi-landscape');
  const G = F.templateToGrid(clone(ipi));
  const before = G.cols.reduce((a, b) => a + b, 0);
  assert.ok(F.setCheckRepeat(G, 10));
  assert.equal(F.checkRun(G).n, 10);
  assert.ok(Math.abs(G.cols.reduce((a, b) => a + b, 0) - before) < 1e-4);
  const { template, problems } = F.checkGrid(G);
  assert.deepEqual(problems, []);
  const chk = template.body.columns.find(c => c.repeat);
  assert.equal(chk.repeat, 10);
  assert.deepEqual(chk.labels, ['Date:', 'Initials:', 'OP#:']);
  assert.ok(Math.abs(T.headerWidth(template) - T.bodyWidth(template)) < 1e-4);
  // The title still reaches the right edge, and no stray blank cells appear.
  const title = template.header.cells.find(c => c.text === 'In-Process Inspection (IPI)');
  assert.equal(title.at[1] + title.span[1], template.header.columns.length);
  assert.equal(template.header.columns.length, ipi.header.columns.length);
  assert.equal(template.header.cells.length, ipi.header.cells.length);
  assert.ok(F.setCheckRepeat(G, 3));
  assert.equal(F.checkGrid(G).template.body.columns.find(c => c.repeat).repeat, 3);
});

test('a check edit lands on every copy', () => {
  const ipi = builtins.find(t => t.id === 'ipi-landscape');
  const G = F.templateToGrid(clone(ipi));
  const run = F.checkRun(G);
  F.forEachCheckTwin(G, G.table, run.c0 + run.w, (r, c) => F.setText(G, r, c, 'When:'));
  for (let k = 0; k < run.n; k++) assert.equal(F.cellAt(G, G.table, run.c0 + k * run.w).text, 'When:');
  assert.deepEqual(F.checkGrid(G).template.body.columns.find(c => c.repeat).labels, ['When:', 'Initials:', 'OP#:']);
  // The box half of a later copy, not just the label half.
  const box = run.c0 + 2 * run.w + 1;
  F.forEachCheckTwin(G, G.table, box, (r, c) => F.format(G, r, c, r, c, { fill: '#ffff00' }));
  for (let k = 0; k < run.n; k++) assert.equal(F.cellAt(G, G.table, run.c0 + k * run.w + 1).fill, '#ffff00');
  assert.equal(F.cellAt(G, G.table, run.c0).fill, '#d9d9d9');
});

test('a header gap the table splits stays one blank cell', () => {
  const ipi = clone(builtins.find(t => t.id === 'ipi-landscape'));
  // Column 0 is split by the table's balloon column; leave it uncovered.
  ipi.header.cells = ipi.header.cells.filter(c => !c.logo);
  const { template } = F.checkGrid(F.templateToGrid(ipi));
  assert.deepEqual(flatten(template), flatten(ipi));
});

test('rows and columns: inserting grows merges, deleting shrinks them', () => {
  const G = F.blankGrid();
  F.merge(G, 0, 1, 0, 3);
  F.insertCols(G, 2, 2);
  assert.deepEqual(G.merges[0], { r: 0, c: 1, rs: 1, cs: 5 });
  F.deleteCols(G, 1, 2);
  assert.deepEqual(G.merges[0], { r: 0, c: 1, rs: 1, cs: 3 });
  F.deleteCols(G, 1, 3);
  assert.deepEqual(G.merges, []);
  const t0 = G.table;
  F.insertRows(G, 1);
  assert.equal(G.table, t0 + 1);
  F.deleteRows(G, 0, 1);
  assert.equal(G.table, t0);
});

test('merge keeps the top-left value only, like Excel', () => {
  const G = F.blankGrid();
  F.setText(G, 0, 0, 'keep');
  F.setText(G, 0, 1, 'lose');
  F.merge(G, 0, 0, 0, 1);
  assert.equal(F.cellAt(G, 0, 0).text, 'keep');
  assert.equal(F.cellAt(G, 0, 1), null);
  assert.deepEqual(F.originOf(G, 0, 1), { r: 0, c: 0, rs: 1, cs: 2 });
});

test('the checklist reports what is placed', () => {
  const ipi = builtins.find(t => t.id === 'ipi-landscape');
  const list = F.checklist(F.templateToGrid(clone(ipi)));
  const placed = l => Object.fromEntries(l.map(x => [x.key, x.placed]));
  assert.equal(placed(list.header)['part.number'], true);
  assert.equal(placed(list.header)['part.material'], false);
  assert.equal(placed(list.header).logo, true);
  assert.equal(placed(list.table)['body.notes'], false);
  assert.equal(placed(list.table)['body.check'], true);
});

test('a heading that ends inside a table column is refused', () => {
  const G = F.blankGrid();
  const dr = F.dataRow(G);
  F.paint(G, dr, 0, 'body.number');
  F.merge(G, dr, 1, dr, 2);
  F.paint(G, dr, 1, 'body.spec');
  F.merge(G, G.table, 0, G.table, 1);
  const { template, problems } = F.checkGrid(G);
  assert.equal(template, null);
  assert.deepEqual(problems.map(p => p.at), [[G.table, 0]]);
});

test('merging over part of a merge takes in all of it', () => {
  const G = F.blankGrid();
  F.merge(G, 0, 0, 0, 1);
  F.merge(G, 0, 1, 1, 2);
  assert.deepEqual(G.merges, [{ r: 0, c: 0, rs: 2, cs: 3 }]);
});

test('a new form starts out saveable, in both orientations', () => {
  for (const o of ['landscape', 'portrait']) {
    const { template, problems } = F.checkGrid(F.starterGrid(o));
    assert.deepEqual(problems, [], o);
    assert.deepEqual(template.body.columns.map(c => c.bind), ['number', 'spec', 'method', 'gage', 'check']);
    assert.equal(template.body.columns[4].repeat, 3);
    assert.deepEqual(template.body.columns[4].labels, ['Date:', 'Initials:']);
    assert.ok(T.headerWidth(template) <= template.page.size[0]);
  }
});

// A shop's own Excel form as xlsx-read.js hands it over: a logo block, a title,
// label/value pairs, a table heading with check columns, and blank rows below.
function shopSheet() {
  const cells = {
    '0,1': { text: 'ACME MACHINING - IN-PROCESS CHECK', bold: true, align: 'center' },
    '1,1': { text: 'Part No.:' }, '1,3': { text: 'Customer' },
    '2,1': { text: 'Rev' }, '2,3': { text: 'Heat Lot:' },
    '3,0': { text: 'Char #', fill: '#d9d9d9' }, '3,1': { text: 'Characteristic', fill: '#d9d9d9' },
    '3,2': { text: 'Method', fill: '#d9d9d9' }, '3,3': { text: 'Gage', fill: '#d9d9d9' },
    '3,4': { text: 'Date:', size: 7 }, '3,5': { text: 'Date:', size: 7 }, '3,6': { text: 'Date:', size: 7 },
    '4,4': { text: 'Initials:', size: 7 }, '4,5': { text: 'Initials:', size: 7 }, '4,6': { text: 'Initials:', size: 7 }
  };
  return {
    cols: [0.5, 2.4, 1.1, 1.0, 0.9, 0.9, 0.9],
    rows: [0.3, 0.22, 0.22, 0.18, 0.18, 0.22, 0.22, 0.22, 0.22],
    cells,
    merges: [{ r: 0, c: 1, rs: 1, cs: 6 }, { r: 0, c: 0, rs: 3, cs: 1 },
             { r: 3, c: 0, rs: 2, cs: 1 }, { r: 3, c: 1, rs: 2, cs: 1 }, { r: 3, c: 2, rs: 2, cs: 1 }, { r: 3, c: 3, rs: 2, cs: 1 }],
    font: { family: 'Calibri', size: 10 },
    page: { paper: 'letter', orientation: 'landscape', marginTop: 0.4, marginBottom: 0.5 }
  };
}

test('an import finds the table heading and its rows of check labels', () => {
  const { G, scaled } = F.gridFromSheet(shopSheet(), 'Acme check');
  assert.equal(scaled, 1);
  assert.equal(G.table, 3);
  assert.equal(G.headRows, 2);
  assert.equal(F.dataRow(G), 5);
  assert.deepEqual(G.page.size, [11, 8.5]);
  assert.equal(G.name, 'Acme check');
  // Nothing is painted on import.
  assert.ok(!Object.values(G.cells).some(c => c.des));
});

test('suggestions read the labels: fields beside them, columns under them', () => {
  const { G } = F.gridFromSheet(shopSheet());
  const s = F.suggest(G);
  const at = Object.fromEntries(s.map(x => [`${x.r},${x.c}`, x.des ?? `new:${x.field.label}`]));
  assert.equal(at['1,2'], 'part.number');
  assert.equal(at['1,4'], 'part.customer');
  assert.equal(at['2,2'], 'part.revision');
  assert.equal(at['2,4'], 'new:Heat Lot');
  assert.equal(at['0,0'], 'logo');
  assert.equal(at['5,0'], 'body.number');
  assert.equal(at['5,1'], 'body.spec');
  assert.equal(at['5,2'], 'body.method');
  assert.equal(at['5,3'], 'body.gage');
  assert.deepEqual([at['5,4'], at['5,5'], at['5,6']], ['body.check', 'body.check', 'body.check']);
  // Nothing suggested for the title or for labels themselves.
  assert.equal(at['0,1'], undefined);
  assert.equal(at['1,1'], undefined);
});

test('accepting every suggestion gives a form that saves and prints', () => {
  const { G } = F.gridFromSheet(shopSheet());
  for (const s of F.suggest(G)) F.acceptSuggestion(G, s);
  F.trimBelowTable(G);
  const { template, problems } = F.checkGrid(G);
  assert.deepEqual(problems, []);
  assert.deepEqual(template.body.columns.map(c => c.bind), ['number', 'spec', 'method', 'gage', 'check']);
  const chk = template.body.columns[4];
  assert.equal(chk.repeat, 3);
  assert.deepEqual(chk.labels, ['Date:', 'Initials:']);
  // An unsplit check heading prints its label over the left part of the column.
  assert.ok(chk.labelWidth > 0 && chk.labelWidth < chk.width);
  assert.deepEqual(template.fields, [{ key: 'record.heat_lot', label: 'Heat Lot' }]);
  assert.equal(G.rows.length, 6);
});

test('a suggestion never lands on a cell that already holds something', () => {
  const { G } = F.gridFromSheet(shopSheet());
  F.setText(G, 1, 2, 'already typed');
  F.paint(G, 2, 4, 'record.machine');
  const s = F.suggest(G);
  assert.ok(!s.some(x => (x.r === 1 && x.c === 2) || (x.r === 2 && x.c === 4)));
  // And a placed field isn't suggested twice.
  F.paint(G, 2, 2, 'part.number');
  assert.ok(!F.suggest(G).some(x => x.des === 'part.number'));
});

test('a sheet wider than the page is scaled to fit', () => {
  const sh = shopSheet();
  sh.cols = sh.cols.map(w => w * 2);
  const { G, scaled } = F.gridFromSheet(sh);
  assert.ok(scaled < 1);
  assert.ok(Math.abs(G.cols.reduce((a, b) => a + b, 0) - (11 - 0.5)) < 1e-3);
});

test('no recognisable heading still leaves a usable grid', () => {
  const { G } = F.gridFromSheet({ cols: [1, 1], rows: [0.2, 0.2, 0.2, 0.2], cells: { '0,0': { text: 'Hello' } },
    merges: [], font: { family: 'Arial', size: 10 }, page: { paper: 'a4', orientation: 'portrait' } });
  assert.equal(G.table, 2);
  assert.equal(F.dataRow(G), 3);
  assert.deepEqual(G.page.size.map(v => +v.toFixed(2)), [8.27, 11.69]);
});

test('check labels stacked in plain rows still count as heading', () => {
  const sh = shopSheet();
  sh.merges = sh.merges.filter(m => m.r !== 3);           // no tall heading cells
  const { G } = F.gridFromSheet(sh);
  assert.equal(G.table, 3);
  assert.equal(G.headRows, 2);
});

test('a value under its label is found when the cell beside it is taken', () => {
  const sh = shopSheet();
  sh.cells['1,5'] = { text: 'Material' };
  sh.cells['1,6'] = { text: 'see drawing' };
  const s = F.suggest(F.gridFromSheet(sh).G);
  assert.ok(s.some(x => x.r === 2 && x.c === 5 && x.des === 'part.material'), JSON.stringify(s));
});

test('a field already on the form isn’t suggested again', () => {
  const { G } = F.gridFromSheet(shopSheet());
  F.paint(G, 2, 6, 'part.number');
  assert.ok(!F.suggest(G).some(x => x.des === 'part.number'));
});

test('"Dimension / Specification" over a narrow and a wide column is balloon + dimension', () => {
  const sh = shopSheet();
  delete sh.cells['3,1'];
  sh.cells['3,0'] = { text: 'Dimension / Specification' };
  sh.merges = sh.merges.filter(m => !(m.r === 3 && m.c <= 1)).concat({ r: 3, c: 0, rs: 2, cs: 2 });
  const { G } = F.gridFromSheet(sh);
  const at = Object.fromEntries(F.suggest(G).map(x => [`${x.r},${x.c}`, x.des]));
  assert.equal(at['5,0'], 'body.number');
  assert.equal(at['5,1'], 'body.spec');
  for (const s of F.suggest(G)) F.acceptSuggestion(G, s);
  const t = F.checkGrid(G).template;
  assert.equal(t.body.columns[0].heading, 'Dimension / Specification');
  assert.equal(t.body.columns[0].headingSpan, 2);
});

test('a wider column beside the checks isn’t taken for one', () => {
  const sh = shopSheet();
  sh.cols.push(1.6);
  const s = F.suggest(F.gridFromSheet(sh).G);
  assert.ok(!s.some(x => x.r === 5 && x.c === 7), JSON.stringify(s.filter(x => x.r === 5)));
  assert.equal(s.filter(x => x.des === 'body.check').length, 3);
  // The title has an empty cell beside it now; it still isn't a label.
  assert.ok(!s.some(x => x.r === 0 && x.c === 7), JSON.stringify(s.filter(x => x.r === 0)));
});

test('titles aren’t labels: centred across the form, or in large type', () => {
  const grid = (cell, cs) => {
    const sh = shopSheet();
    sh.cells['0,1'] = cell;
    sh.merges = sh.merges.filter(m => !(m.r === 0 && m.c === 1)).concat(cs > 1 ? [{ r: 0, c: 1, rs: 1, cs }] : []);
    return F.gridFromSheet(sh).G;
  };
  const top = G => F.suggest(G).filter(x => x.r === 0 && x.des !== 'logo');
  assert.deepEqual(top(grid({ text: 'QC Report', align: 'center' }, 4)), []);
  assert.deepEqual(top(grid({ text: 'QC Report', size: 14 }, 1)), []);
  // A plain label, even a wide one, still is one.
  assert.equal(top(grid({ text: 'Material' }, 4))[0]?.des, 'part.material');
});

test('a sheet that ends at its heading gets the row that repeats', () => {
  const sh = shopSheet();
  sh.rows = sh.rows.slice(0, 5);                            // nothing below "Initials:"
  sh.merges = sh.merges.filter(m => m.r !== 3);           // so the labels row alone sets the height
  const { G } = F.gridFromSheet(sh);
  assert.equal(G.table, 3);
  assert.equal(G.headRows, 2);
  assert.equal(G.rows.length, 6);
  assert.equal(F.suggest(G).filter(x => x.des === 'body.check').length, 3);
});

test('a part of one check column is the same part of every copy', () => {
  const G = F.templateToGrid(clone(builtins.find(t => t.id === 'ipi-landscape')));
  const run = F.checkRun(G);
  const box = run.c0 + 3 * run.w + 1;                      // box half of the fourth check
  assert.deepEqual(F.checkTwinCols(G, box), Array.from({ length: 8 }, (_, k) => run.c0 + k * run.w + 1));
  assert.deepEqual(F.checkTwinCols(G, 0), [0]);           // outside the run: itself only
});

test('unequal checks are a problem with a fix that keeps their total width', () => {
  const G = F.templateToGrid(clone(builtins.find(t => t.id === 'ipi-landscape')));
  const run = F.checkRun(G);
  G.cols[run.c0 + 2 * run.w] += 0.2;                       // one label part, wider
  G.cols[run.c0 + 5 * run.w + 1] -= 0.1;                   // one box part, narrower
  const total = G.cols.reduce((a, b) => a + b, 0);
  let r = F.checkGrid(G);
  assert.equal(r.template, null);
  assert.equal(r.problems[0].fix, 'equalize');
  assert.ok(F.equalizeChecks(G));
  r = F.checkGrid(G);
  assert.deepEqual(r.problems, []);
  assert.ok(Math.abs(G.cols.reduce((a, b) => a + b, 0) - total) < 1e-4);
  const widths = Array.from({ length: 8 }, (_, k) => G.cols[run.c0 + k * run.w]);
  assert.ok(widths.every(w => Math.abs(w - widths[0]) < 1e-6));
});

test('fitting to the page scales the whole form, keeping its shape', () => {
  const G = F.templateToGrid(clone(builtins.find(t => t.id === 'ipi-landscape')));
  const limit = F.usableWidth(G);
  G.cols[1] += 1.5;                                        // the Dimension column, dragged wider
  const cols = G.cols.slice(), rows = G.rows.slice();
  const size = G.font.size, title = Object.values(G.cells).find(c => c.text === 'In-Process Inspection (IPI)').size;
  assert.ok(F.fitWidth(G));
  const k = limit / cols.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(G.cols.reduce((a, b) => a + b, 0) - limit) < 1e-4);
  G.cols.forEach((w, i) => assert.ok(Math.abs(w - cols[i] * k) < 1e-5, `col ${i}`));
  G.rows.forEach((h, i) => assert.ok(Math.abs(h - rows[i] * k) < 1e-5, `row ${i}`));
  assert.ok(Math.abs(G.font.size - size * k) < 0.01);
  const t2 = Object.values(G.cells).find(c => c.text === 'In-Process Inspection (IPI)').size;
  assert.ok(Math.abs(t2 - title * k) < 0.01);
  // The dragged column is still exactly as much wider than its neighbour as it was set.
  assert.ok(Math.abs(G.cols[1] / G.cols[2] - cols[1] / cols[2]) < 1e-4);
  assert.deepEqual(F.checkGrid(G).problems, []);
  assert.equal(F.fitWidth(G), false);                      // already fits: nothing changes
});

test('a form that fits is never grown', () => {
  const G = F.starterGrid('portrait');
  G.cols = G.cols.map(w => w / 2);
  const before = JSON.stringify(G);
  assert.equal(F.fitWidth(G), false);
  assert.equal(JSON.stringify(G), before);
});

test('a form wider than its page offers the fit as a fix', () => {
  const G = F.templateToGrid(clone(builtins.find(t => t.id === 'ipi-landscape')));
  G.page.size = [8.5, 11];                                 // turned to portrait
  const { template, problems } = F.checkGrid(G);
  assert.equal(template, null);
  assert.ok(problems.some(p => p.fix === 'fit'), JSON.stringify(problems));
  F.fitWidth(G);
  assert.deepEqual(F.checkGrid(G).problems, []);
});

test('header and table both too wide are one problem, with one fix', () => {
  const G = F.templateToGrid(clone(builtins.find(t => t.id === 'ipi-landscape')));
  G.page.size = [8.5, 11];
  const fits = F.checkGrid(G).problems.filter(p => p.fix === 'fit');
  assert.equal(fits.length, 1);
  assert.match(fits[0].msg, /form is wider than the page/);
});
