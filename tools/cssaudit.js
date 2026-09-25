// CSS classes defined in index.html but never applied anywhere.
// Kept as its own file: the regexes need backslashes that do not survive a
// shell heredoc, which produced a check that flagged every class in the app.
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const js = ['renderer.js', 'library.js']
  .map(f => fs.readFileSync(f, 'utf8')).join('\n');

const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const body = html.slice(html.indexOf('</style>'));
const classes = new Set([...style.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));

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
