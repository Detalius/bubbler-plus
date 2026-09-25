// Builds a throwaway share with REAL .insp packages (a zip holding a
// manifest.json), so the crawl has something to find. tools/mockshare.bat
// builds the same shapes for manual testing, but its package folders are empty.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');

function makeShare(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbler-share-'));
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    // A package whose id and part number are its file stem.
    pkg(rel, manifest = {}) {
      const file = path.join(root, rel);
      const id = path.basename(file, path.extname(file));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const m = { package: { id }, part: { number: id }, documents: [], ...manifest };
      fs.writeFileSync(file, zipSync({ 'manifest.json': strToU8(JSON.stringify(m)) }));
      return file;
    },
    dir(rel) { fs.mkdirSync(path.join(root, rel), { recursive: true }); },
    file(rel, text = '') {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  };
}

module.exports = { makeShare };
