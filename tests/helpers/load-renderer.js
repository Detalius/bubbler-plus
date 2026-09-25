// Pulls named top-level declarations out of renderer.js and runs them in a
// sandbox. Only for pure functions and constants: anything that touches the
// DOM, Konva or pdf.js can't be loaded this way. Names are loaded in the order
// given, so list dependencies first.
const acorn = require('acorn');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadRenderer(names) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer.js'), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  const byName = new Map();
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration') byName.set(node.id.name, node);
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) if (d.id.type === 'Identifier') byName.set(d.id.name, node);
    }
  }
  const parts = names.map(n => {
    const node = byName.get(n);
    if (!node) throw new Error(`renderer.js has no top-level ${n}`);
    // const/let become var so the sandbox exposes them as properties.
    return src.slice(node.start, node.end).replace(/^(const|let)\b/, 'var');
  });
  const ctx = vm.createContext({});
  vm.runInContext(parts.join('\n'), ctx);
  return Object.fromEntries(names.map(n => [n, ctx[n]]));
}

module.exports = { loadRenderer };
