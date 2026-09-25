// Handlers clobbered by a later broad selector.
//
// `$('railHome').onclick = ...` on line 3887 and
// `document.querySelectorAll('.nav').forEach(b => b.onclick = ...)` on line 4588
// both bind the same element. Last assignment wins, so the specific handler is
// silently replaced by the generic one and the button does the wrong thing with
// no error anywhere. Caught once; it cost a debugging round.
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

// id -> class list, from the markup.
const classOf = {};
for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
  const tag = m[0];
  const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
  if (id) classOf[id] = ((tag.match(/\bclass="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
}

let found = 0;
for (const f of ['renderer.js', 'library.js']) {
  const src = fs.readFileSync(f, 'utf8');
  const lineOf = i => src.slice(0, i).split('\n').length;

  // Broad bindings: querySelectorAll('sel') whose callback assigns an on* handler.
  const broad = [];
  for (const m of src.matchAll(/querySelectorAll\(\s*'([^']+)'\s*\)\s*\.forEach\(/g)) {
    const body = src.slice(m.index, m.index + 1500);
    if (/\.\s*on[a-z]+\s*=[^=]/.test(body)) broad.push({ sel: m[1], line: lineOf(m.index) });
  }
  if (!broad.length) continue;

  // Specific bindings: $('id').onX = ...
  for (const m of src.matchAll(/\$\('([a-zA-Z0-9_-]+)'\)\.(on[a-z]+)\s*=/g)) {
    const [, id, ev] = m;
    const line = lineOf(m.index);
    const classes = classOf[id] || [];
    for (const b of broad) {
      // Only bare class selectors are checked; anything narrower is deliberate.
      const cls = /^\.([\w-]+)$/.exec(b.sel);
      if (!cls || !classes.includes(cls[1])) continue;
      if (b.line < line) continue;                 // specific wins, fine
      console.log(`  CLOBBERED: ${f}:${line} $('${id}').${ev} is overwritten by ` +
                  `querySelectorAll('${b.sel}') at line ${b.line}`);
      found++;
    }
  }
}
if (!found) console.log('  none');
