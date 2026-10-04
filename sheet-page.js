// One printed page of a form, drawn from its template as HTML: the Sheets
// preview, every PDF, the Library's print and the form editor's preview all
// come from here, so what an editor shows is what prints. Needs paper.css.
import { checkColumn, headerWidth, bodyWidth, fillText } from './sheet-template.js';

// ---------------------------------------------------------------------------
// One page of any form, drawn from its template. Runs for each page of the
// Sheets preview, the sheet PDF, the record PDF and the Library's sheet print.
//   ctx = sheetCtx() or inspCtx(): { template, bandCount, bands, bind }
//
// Header and body are centred on the page and share one table, laid on the
// union of their column edges, so their borders collapse into one grid.
// ---------------------------------------------------------------------------
export const SYMBOL_FONT_STACK = "'SimpleGeoDim', Arial, sans-serif";

// Applies a template style to a page element.
export function styleCell(el, st) {
  if (!st) return;
  if (st.fill) el.style.background = st.fill;
  if (st.size) el.style.fontSize = st.size + 'pt';
  if (st.bold) el.style.fontWeight = 'bold';
  if (st.italic) el.style.fontStyle = 'italic';
  if (st.align) el.style.textAlign = st.align;
  if (st.wrap === false) el.style.whiteSpace = 'nowrap';
  if (st.font) el.style.fontFamily = st.font === 'symbol' ? SYMBOL_FONT_STACK : `${st.font}, Arial, sans-serif`;
}

// Left-to-right edges of `widths`, starting at `from`.
function edgesOf(widths, from) {
  const out = [from];
  for (const w of widths) out.push(out[out.length - 1] + w);
  return out;
}

export function buildPage(ctx, rows, pageNo, pageCount, { logo = null, toFont = s => s } = {}) {
  const t = ctx.template;
  const B = t.body;
  const [pageW, pageH] = t.page.size;
  const chk = checkColumn(t);
  const styleOf = name => (name ? t.styles?.[name] : null);
  const bind = { ...ctx.bind, page: { number: pageNo, count: pageCount } };

  const hw = headerWidth(t), bw = bodyWidth(t), W = Math.max(hw, bw);
  const side = (pageW - W) / 2;
  const hEdges = edgesOf(t.header.columns, (W - hw) / 2);

  // The body's segments: one per ordinary column, and a label and a value per
  // check. `spans[ci]` is where each body column starts and ends.
  const segs = [], spans = [];
  let x = (W - bw) / 2;
  for (const c of B.columns) {
    if (c.repeat == null) {
      segs.push(c.width);
      spans.push([x, x + c.width]);
      x += c.width;
    } else {
      const checks = [];
      for (let k = 0; k < c.repeat; k++) {
        segs.push(c.labelWidth, c.width - c.labelWidth);
        checks.push([x, x + c.labelWidth, x + c.width]);
        x += c.width;
      }
      spans.push(checks);
    }
  }
  const bEdges = edgesOf(segs, (W - bw) / 2);
  const bodyFrom = bEdges[0], bodyTo = bEdges[bEdges.length - 1];

  // The shared grid. Edges closer than EPS are one edge.
  const EPS = 5e-4;
  const edges = [];
  for (const e of [...hEdges, ...bEdges].sort((a, b) => a - b)) {
    if (!edges.length || e - edges[edges.length - 1] > EPS) edges.push(e);
  }
  const col = e => edges.findIndex(v => Math.abs(v - e) <= EPS);

  const paper = document.createElement('div');
  paper.className = 'paper ' + (pageW > pageH ? 'landscape' : 'portrait');
  paper.style.width = pageW + 'in';
  paper.style.height = pageH + 'in';
  paper.style.paddingTop = t.page.marginTop + 'in';
  paper.style.paddingLeft = side + 'in';
  paper.style.paddingRight = side + 'in';
  if (t.font) {
    paper.style.fontSize = t.font.size + 'pt';
    paper.style.fontFamily = `${t.font.family}, sans-serif`;
  }

  const table = document.createElement('table');
  // Width is stated, not left to the cells: with border-collapse, merged
  // columns drop internal borders and the grid would come out narrower.
  table.style.width = W.toFixed(4) + 'in';
  const cg = document.createElement('colgroup');
  for (let i = 1; i < edges.length; i++) {
    const c = document.createElement('col');
    c.style.width = (edges[i] - edges[i - 1]).toFixed(4) + 'in';
    cg.appendChild(c);
  }
  table.appendChild(cg);

  const td = (text, from, to, { cls, style, rowSpan = 1, height } = {}) => {
    const c = document.createElement('td');
    if (cls) c.className = cls;
    c.textContent = text ?? '';
    const n = col(to) - col(from);
    if (n > 1) c.setAttribute('colspan', n);
    if (rowSpan > 1) c.setAttribute('rowspan', rowSpan);
    styleCell(c, style);
    if (height != null) c.style.height = height + 'in';
    return c;
  };
  // A borderless filler, where header and body differ in width.
  const pad = (tr, from, to) => {
    if (to - from > EPS) tr.appendChild(td('', from, to, { cls: 'pad' }));
  };

  // ---- header ----
  const H = t.header;
  const origin = new Map(), covered = new Set();
  for (const c of H.cells) {
    const [r, k] = c.at, [rs, cs] = c.span ?? [1, 1];
    origin.set(`${r},${k}`, c);
    for (let y = r; y < r + rs; y++) for (let z = k; z < k + cs; z++) {
      if (y !== r || z !== k) covered.add(`${y},${z}`);
    }
  }
  H.rows.forEach((h, r) => {
    const tr = document.createElement('tr');
    pad(tr, 0, hEdges[0]);
    for (let k = 0; k < H.columns.length; k++) {
      if (covered.has(`${r},${k}`)) continue;
      const c = origin.get(`${r},${k}`) || {};
      const [rs, cs] = c.span ?? [1, 1];
      const text = c.bind != null ? fillText(`{${c.bind}}`, bind)
                 : c.text != null ? fillText(c.text, bind) : '';
      const cell = td(c.logo ? '' : text, hEdges[k], hEdges[k + cs], {
        cls: c.logo ? 'logo' : undefined, style: styleOf(c.style), rowSpan: rs,
        height: rs === 1 ? h : undefined
      });
      if (c.logo) {
        if (logo) {
          const img = document.createElement('img');
          img.src = logo;
          cell.appendChild(img);
        } else {
          cell.textContent = 'LOGO';
        }
      }
      tr.appendChild(cell);
    }
    pad(tr, hEdges[hEdges.length - 1], W);
    table.appendChild(tr);
  });

  // ---- body ----
  const nLab = chk ? chk.labels.length : 1;
  const bands = ctx.bandCount || 1;
  const headAt = (band, k, li) => ((ctx.bands?.[band]?.columns || [])[k] || [])[li] || '';

  // Each band is a fresh set of check columns: its own heading block, the same rows.
  for (let band = 0; band < bands; band++) {
    for (let li = 0; li < nLab; li++) {
      const tr = document.createElement('tr');
      pad(tr, 0, bodyFrom);
      for (let ci = 0; ci < B.columns.length; ci++) {
        const c = B.columns[ci];
        if (c.repeat != null) {
          spans[ci].forEach(([a, m, z], k) => {
            const lc = td('', a, m, { cls: 'chl', style: styleOf(c.labelStyle), height: B.labelRowHeight });
            const sp = document.createElement('span');
            sp.textContent = c.labels[li];
            lc.appendChild(sp);
            tr.append(lc, td(headAt(band, k, li), m, z,
              { cls: 'ch', style: styleOf(c.headStyle), height: B.labelRowHeight }));
          });
          continue;
        }
        if (li > 0) continue;
        // A heading covers its own column and headingSpan - 1 more.
        const span = c.headingSpan ?? 1;
        const end = spans[ci + span - 1][1];
        tr.appendChild(td(c.heading ?? '', spans[ci][0], end,
          { style: styleOf(B.headingStyle), rowSpan: nLab }));
        ci += span - 1;
      }
      pad(tr, bodyTo, W);
      table.appendChild(tr);
    }

    rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      pad(tr, 0, bodyFrom);
      if (row.type === 'header') {
        tr.appendChild(td(row.text, bodyFrom, bodyTo, { cls: 'grp', style: styleOf(B.sectionStyle) }));
        pad(tr, bodyTo, W);
        table.appendChild(tr);
        return;
      }
      let span = 1;
      if (!row.isSub) for (let k = i + 1; k < rows.length && rows[k].isSub; k++) span++;
      // Dimension and method are shared; gage and readings belong to this band.
      const rb = (row.bands || [])[band] || {};
      const cell = (text, a, z, style, extra = {}) =>
        tr.appendChild(td(text, a, z, { style, height: B.rowHeight, ...extra }));
      B.columns.forEach((c, ci) => {
        const st = styleOf(c.style);
        switch (c.bind) {
          case 'number':
            if (!row.isSub) cell(row.number, spans[ci][0], spans[ci][1], st, { rowSpan: span });
            break;
          case 'spec':   cell(toFont(row.spec || ''), spans[ci][0], spans[ci][1], st); break;
          case 'method': cell(row.method || '', spans[ci][0], spans[ci][1], st); break;
          case 'gage':   cell(toFont(rb.gageId || ''), spans[ci][0], spans[ci][1], st); break;
          case 'notes':  cell(row.notes || '', spans[ci][0], spans[ci][1], st); break;
          case 'check':
            spans[ci].forEach(([a, , z], k) => cell(toFont((rb.values || [])[k] || ''), a, z, st));
            break;
        }
      });
      pad(tr, bodyTo, W);
      table.appendChild(tr);
    });
  }

  paper.appendChild(table);

  for (const f of t.footer || []) {
    const foot = document.createElement('div');
    foot.className = 'page-foot';
    styleCell(foot, styleOf(f.style));
    if (f.size) foot.style.fontSize = f.size + 'pt';
    foot.style.bottom = (f.bottom ?? 0) + 'in';
    foot.style.left = side + 'in';
    foot.style.right = side + 'in';
    foot.style.justifyContent = { center: 'center', right: 'flex-end' }[f.align] || 'flex-start';
    foot.textContent = fillText(f.text, bind);
    paper.appendChild(foot);
  }
  return paper;
}

// Styles are inlined rather than linked: the print window loads from a data URL
// and has no access to the app's stylesheet or asset folder.
export function printCss(fontUri) {
  return `
    ${fontUri ? `@font-face{font-family:'SimpleGeoDim';src:url('${fontUri}') format('truetype');}` : ''}
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:#fff}
    body{font-family:Arial,Helvetica,sans-serif;color:#000}
    /* Page size, padding, row heights and font sizes are all set inline from the
       measured geometry — nothing here may restate them, or the two would drift. */
    .paper{page-break-after:always;break-after:page;position:relative;overflow:hidden}
    .paper:last-child{page-break-after:auto;break-after:auto}
    .page-foot{position:absolute;display:flex;justify-content:space-between;align-items:baseline}
    .page-foot span:nth-child(2){flex:1;text-align:center}
    table{border-collapse:collapse;table-layout:fixed}
    td{border:1px solid #000;padding:0 3px;overflow:hidden;vertical-align:middle}
    /* Out of flow, so the image can't size the cell: a percentage max-height in
       an auto-height cell constrains nothing, and a big logo stretched every
       header row it spans. The rows keep the form's own heights. */
    .logo{text-align:center;position:relative}
    .logo img{position:absolute;left:2%;top:4%;width:96%;height:92%;object-fit:contain}
    .pad{border:none}
    .ch{border-left:none}
    /* Let a check label spill into the blank beside it. The span does the
       lifting; a lifted cell prints a stray border segment. */
    .chl{border-right:none;overflow:visible;white-space:nowrap}
    .chl span{position:relative;z-index:1}
    .grp{padding-left:5px}
    tr{page-break-inside:avoid;break-inside:avoid}`;
}
