#!/usr/bin/env bash
# Bubbler+ integrity check. Run from the project root: bash tools/check.sh
#
# Every check here exists because something got past a plain `node --check`.
# Add to it rather than trusting a syntax pass.
set -uo pipefail
fail=0
note() { printf '  %s\n' "$1"; }
head() { printf '\n== %s ==\n' "$1"; }

head "Parse (renderer/print as MODULES — the browser loads them that way)"
# node --check parses as a SCRIPT, where redeclaring a function is legal.
# In a module it is a hard SyntaxError. This distinction has bitten twice.
for f in renderer.js library.js; do
  cp "$f" "/tmp/_chk_${f%.js}.mjs"
  if node --check "/tmp/_chk_${f%.js}.mjs" 2>/dev/null; then note "ok   $f"; else
    note "FAIL $f"; node --check "/tmp/_chk_${f%.js}.mjs" 2>&1 | head -4; fail=1; fi
done
for f in main.js preload.js; do
  if node --check "$f" 2>/dev/null; then note "ok   $f"; else note "FAIL $f"; fail=1; fi
done

head "Duplicate top-level declarations"
node -e '
const fs=require("fs");
for (const f of ["renderer.js","library.js","main.js","preload.js"]) {
  const s=fs.readFileSync(f,"utf8"), c={};
  for (const m of s.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) c[m[1]]=(c[m[1]]||0)+1;
  for (const m of s.matchAll(/^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*[=;]/gm)) c[m[1]]=(c[m[1]]||0)+1;
  const d=Object.entries(c).filter(([,n])=>n>1);
  console.log("  "+f+": "+(d.length?d.map(([n,x])=>n+" x"+x).join(", "):"none"));
}'

head "Element ids referenced but absent from index.html"
grep -ohE "\\\$\('[a-zA-Z0-9_-]+'\)" renderer.js library.js \
  | grep -oE "'[a-zA-Z0-9_-]+'" | tr -d "'" | sort -u | while read -r id; do
    grep -q "id=\"$id\"" index.html || grep -q "id=\"$id\"" renderer.js || grep -q "id=\"$id\"" library.js \
      || note "MISSING: $id"
  done; note "(done — runtime-built dialog ids live in the JS)"

head "IPC channels: main vs preload"
grep -oE "ipcMain.handle\('[a-zA-Z:.-]+'" main.js | grep -oE "'[a-zA-Z:.-]+'" | tr -d "'" | sort > /tmp/_mh
grep -oE "invoke\('[a-zA-Z:.-]+'" preload.js | grep -oE "'[a-zA-Z:.-]+'" | tr -d "'" | sort > /tmp/_ph
comm -3 /tmp/_mh /tmp/_ph | sed 's/^/  mismatch: /'; note "(empty above = balanced)"

head "window.api surface: used vs exposed"
cat renderer.js library.js \
  | grep -oE "api\(\)\.[a-zA-Z]+|window\.api\??\.[a-zA-Z]+" \
  | grep -oE "\.[a-zA-Z]+$" | tr -d '.' | sort -u > /tmp/_u
grep -oE "^  [a-zA-Z]+:" preload.js | tr -d ' :' | sort -u > /tmp/_e
comm -23 /tmp/_u /tmp/_e | sed 's/^/  used but NOT exposed: /'; note "(empty above = ok)"

head "Handlers clobbered by a later broad selector"
node tools/handlers.js

head "CSS classes never applied"
node tools/cssaudit.js

head "Byte-array spread (stack overflow past ~128KB)"
grep -n "fromCharCode(\.\.\." renderer.js library.js | grep -v "^\s*//" || note "none"

head "Schema version"
grep -oE "SCHEMA_VERSION = '[0-9.]+'" renderer.js | sed 's/^/  /'

printf '\n%s\n' "$([ $fail -eq 0 ] && echo 'PARSE OK' || echo 'PARSE FAILURES ABOVE')"
