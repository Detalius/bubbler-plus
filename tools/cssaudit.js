// CSS classes defined in a page but never applied anywhere. With no arguments it
// audits index.html against the app's scripts; `node tools/cssaudit.js page.html
// a.js b.js` audits another page (the form editor).
// Kept as its own file: the regexes need backslashes that do not survive a
// shell heredoc, which produced a check that flagged every class in the app.
const fs = require('fs');
const [page = 'index.html', ...scripts] = process.argv.slice(2);
const html = fs.readFileSync(page, 'utf8');
const js = (scripts.length ? scripts : ['renderer.js', 'library.js', 'sheet-page.js'])
  .map(f => fs.readFileSync(f, 'utf8')).join('\n');

const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
// url(...) holds file names (SimpleGeoDim.ttf), not classes.
const rules = style.replace(/url\([^)]*\)/g, '');
const body = html.slice(html.indexOf('</style>'));
const classes = new Set([...rules.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));

const unused = [...classes].filter(c => {
  const inHtml = new RegExp('class="[^"]*\\b' + c + '\\b').test(body);
  const inJs = new RegExp('\\b' + c + '\\b').test(js);
  return !inHtml && !inJs;
});
console.log('  ' + (unused.length ? unused.join(', ') : 'none'));

// Two rules for the exact same selector. Legal CSS and occasionally deliberate,
// but it is also what a name collision looks like: whoever writes the second one
// believes they are defining a class, not amending someone else's, and the
// shorthands in one silently reset longhands in the other. Whole-selector
// matching keeps it quiet — `.nav` and `.nav:hover` are different strings, so
// only a genuine redefinition shows up.
const seen = new Map();
for (const m of style.matchAll(/(^|\})\s*([^{}@\/]+?)\s*\{/g)) {
  const sel = m[2].replace(/\s+/g, ' ').trim();
  if (!sel || sel.startsWith('*')) continue;
  seen.set(sel, (seen.get(sel) || 0) + 1);
}
const dup = [...seen].filter(([, n]) => n > 1).map(([s, n]) => `${s} (x${n})`);
console.log('\n== Selectors defined more than once ==');
console.log('  ' + (dup.length ? dup.join(', ') : 'none'));
