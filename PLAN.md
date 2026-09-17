# Bubbler+ — handover (rev 7)

Paste this into a new conversation to resume. Supersedes rev 1–6.
**Read §3 before touching anything** — it is the list of things
that have already caused a bug once.

---

## 1. What exists

Electron app. `main.js` (~1.65k lines — menus, dialogs, config, package index,
locks, printing), `preload.js` (contextBridge), `renderer.js` (~7.2k lines, the
workspace), `library.js` (~460, the Library), `index.html` (~1.3k, markup AND
all CSS), `assets/`, `tools/check.sh`.

Deps: pdfjs-dist, pdf-lib, konva, fflate, directory-tree; electron and
electron-builder are dev only. fontkit is loaded as a global from `assets/`, not
as a package. No bundler.
**Manifest schema 0.37.0.** No migrations pre-1.0 — see §4.

**One workspace, two rail shapes, plus the Library.** The app opens on the
launcher (§4), not a mode picker — `#modeSelect` is gone entirely.

- **Authoring** — Bubbler (Konva annotation, multi-drawing) → Dimensions
  (free-text callouts + GD&T frame builder, in/mm) → Sheets (authored item lists,
  overrides, repeated check bands, paged preview).
- **Inspecting** — Inspect alone: frozen snapshots, per-band entries, the
  bubbled drawing beside them, PDFs carrying their own record. Reached by the
  swap at the foot of the rail or by Quick Find's Inspect button.
- **Library** — read-only. Search the package index, open a part, preview its
  drawings and sheets, print, or take it into either rail shape. Never edits.

**Storage.** `.insp` = zip of `manifest.json` + `drawings/dwg_N.pdf`, one per part
revision, self-contained and emailable. Saving publishes sidecars to
`<index>/pkg|hash|set/…` so lookups are path reads, not scans. Autosave writes
`recovery.insp` beside the exe while dirty; offered back at startup.
`recents.json` sits beside it too — paths only, capped at 20.

**Print geometry** is measured from the real QF-0022 PDFs, held in one `GEOM`
const, applied inline. 41 rows portrait / 28 landscape.

---

## 2. To do

1. **Custom GD&T font** — in progress. Storage is clean Unicode as of 0.33.0 and
   the table lives in `assets/symbols.json`, so this is a data edit plus the
   `@font-face` src. `FONT-SLOTS.md` has the codepoint assignment. Note it is no
   longer a distribution blocker: what blocked was Verisurf's licence, not glyph
   coverage — Chromium falls back for the sheets path. It still matters for the
   pdf-lib drawing export, which has no fallback and cannot encode above WinAnsi.
2. **Finalize the logo** — deliberately last; wants direct input.
3. **Discuss: live update capability** — worth talking through the trade before
   building anything. Roughly: an update channel means fixes reach the floor
   without someone walking a new build round, which matters once this is in
   more than one pair of hands. Against it: a package format with a schema
   version means an update can change what a saved file means underneath
   someone mid-job, an auto-updater is a code-signing and hosting commitment
   rather than a feature, and "it changed by itself" is exactly the thing this
   app has been designed the whole way NOT to do. Probably wants to be
   check-and-notify rather than fetch-and-apply, and to refuse while a package
   is open and dirty. Decide the shape before the mechanism.

Done since rev 6: **the walkthrough sweep, Bubbler page.** Jesse is testing
page by page (Launcher passed untouched). From that pass: undo now covers
adding and removing drawings (it never did, and undoing a removal left ghost
rows); undo puts the next bubble number back; Clear Annotations no longer resets
`uid`; rectangles always draw underneath; per-drawing remembered sizes (schema
0.37.0); renumber takes Up/Down plus an amount and applies without a preview;
dropping a leader's end inside its balloon removes the leader; Ctrl+scroll zooms
every pane about the cursor; Ctrl+Z in a text field undoes the field. Confirmed
fine as-is: records keep a deleted bubble (they are snapshots), rotated pages,
multi-page drawings. **File locking verified with two instances on one PC**
(the token, not the host, is what races): read-only open blocks Ctrl+S and
File > Save; a force-quit leaves the lock and it still warns; stale takeover is
silent after 3 minutes; a suspended holder resumed after takeover gets the
lost-lock notice immediately; Save As drops read-only and locks the new file; a
normal close removes the lock. **Only a real SMB share is still untested** — the
app has never been packaged and runs from the dev folder.
Also from that pass: the Library preview no longer goes stale after a save
elsewhere (it stats the package on return and on every item click, re-reading
only when the stamp moved — `package:stamp`), and the Bubbler canvas renders
zoom offscreen and swaps, with a CSS-zoom preview during a wheel spin.
**Dimensions swept:** passed as-is apart from symbol and modifier inserts, which
were invisible to undo (below). Multi-line paste turning line breaks into spaces
is native `<input>` behaviour and is kept: a callout is one line, and so is its
Excel cell. **Sheets swept:** the card's copy button now matches the X (both a fixed 24×20
box), and dragging a row scrolls the list from a 70px band at either edge,
faster the deeper in — no wheel events reach the page during an HTML5 drag on
Windows, and a 250-row sheet took several drops to cross. It stops on events (leaving
the list, drop, dragend), never on a short silence: a held-still pointer only
gets a dragover every ~350ms, and a 200ms timeout made holding in the band
stutter while wiggling ran at full speed. `dragend` also
releases `dragRef` for drops that land outside a row. **Inspect swept:** only the New Record base-sheet menu was off — it passed
`popupSections()` a kind (`tol`) with no CSS, so sheet names rendered as 42px
GD&T-font symbol tiles. A kind is a CSS contract; `list` is the text one.
**Library sweep, first pass:** a failed open now clears the open package (it
used to leave the previous one highlighted, listed and wired to Open/Inspect)
and flags the record missing on ENOENT, as opening for edit already did; a
rebuild refreshes the Library's list; overlapping searches only render the
newest; a selected missing card keeps a readable tag. **Remove missing** in
Settings (`index:purge-missing`) deletes flagged records and their pointers from
both indexes after one last reachability check — index only, never a file, and
anything that returns is re-published on its next open, save or crawl.  Remove
missing also clears the flag on anything it keeps as reachable again, and
reports a failure instead of looking like "removed nothing". The purge handler
was run against a fake index under a stubbed `electron` (2 flagged, 1 restored:
removed 1, kept and unflagged 1). Library cards show the file name, and search
matches it — two packages can share part number, rev, customer and name.
The preview is deliberately held in memory (`openPkg.files`): deleting a file
under it keeps the preview until you leave it. The "card reappears without its
missing styling" report could not be reproduced by Jesse either; closed.
Library edge cases passed after this batch.

**Menus swept.** Most passed as-is: Clear Annotations (no confirm by choice —
it is one undo step and History records it), every action from every screen,
menu keys over open dialogs, read-only allowing edits it cannot save, New/Open
discard prompts, Quit keeping the lock on Cancel. Fixed: **Save As over a
package another session has open** now refuses before writing (`lockHolder()`
in `dialog:save`, picked paths only; tested live/stale/own against a stubbed
electron) — it used to write, leaving both sessions editing one file until a
stamp conflict surfaced; **View > Reload** no longer leaves main holding the
previous page's lock (the renderer releases at boot); **Export > Bubbled
drawing** with no drawing says so instead of closing on nothing. Reload with
unsaved work still has no prompt, by choice: recovery catches it and discard
already asks twice. The sweep is done.

**Updates: decided.** Public GitHub repo, electron-updater's GitHub provider,
check-and-notify (`autoDownload` and `autoInstallOnAppQuit` off), install
refused while a package is dirty. Build order: packaging → data folder →
newer-schema packages open read-only → the updater → a private 0.1.0/0.1.1 pair
to watch a real update land. Signing later (SignPath Foundation or Trusted
Signing); unsigned works, with SmartScreen warnings.

**Packaging and the data folder: done.** `build.files` is an allowlist — the
app's own files, `assets/`, and production dependencies (electron-builder adds
those itself; the old `!node_modules/**/*` excluded them, so the packaged app
could not load Konva, pdf-lib, pdf.js or main's fflate). Trimmed: pdf.js
legacy/web/types/cmaps/standard_fonts, pdf-lib's non-dist builds, source maps,
and pdf.js's optional `@napi-rs/canvas` (32 MB of Node-side native canvas the
renderer never uses). `directory-tree` removed — nothing required it. NSIS
one-click per-user; `artifactName` has no spaces or `+`, which GitHub mangles in
release asset names and electron-updater then cannot find. Verified with a
Linux `--dir` build: app.asar is 15 MB, no dev files in it (config, recents,
index, tools), every path index.html and the renderer load is present, and the
packaged app launched headless with pdf.js, Konva, pdf-lib, fflate and the JSON
imports all loaded. The Windows NSIS build itself still has to be run on Windows.
Everything the app writes lives in the per-user data folder (`DATA_DIR`,
`%APPDATA%\Bubbler+`) in dev and packaged alike, with Chromium's caches in
`Session\` beneath it; Settings has **Open data folder**. **Before a public
release: `assets/Verisurf.ttf` is a third-party font and must not ship in a
public repo or installer** — the custom GD&T font replaces it. **Newer-schema packages: done.** A package whose schema is above this build's
opens **view only** (`newerSchema`) instead of being refused: view, print and
export work; Save and Save As are both off (Save As is the danger — it writes
the package back in the older shape), and so are recovery, the lock and the
index sidecar. Title tag `[view only]`. Recovery now also writes 15 s after a
package first goes dirty (`FIRST_RECOVERY_MS`), then keeps the 2-minute
interval — the interval ran from launch, so a crash could lose up to two minutes.
New now releases the previous package's lock and clears read-only, which it
never did.

**The updater: built.** electron-updater against `Detalius/bubbler-plus`
releases, with `autoDownload` and `autoInstallOnAppQuit` off: a check spends no
bandwidth, a quit never becomes an install. Three IPC calls (`update:check`,
`update:download`, `update:install`), a card in the bottom-right corner that
floats over the layout rather than moving it, Help > Check for Updates for a
manual check, a quiet check 8 s after launch that says nothing unless there is
news. Install refuses while dirty, releases the lock, and sets `allowClose`
before `quitAndInstall()` (which closes windows before the close guard could be
answered). Nothing runs unpackaged — a manual check there says so. `APP.version`
now comes from `package.json` via main, so export stamps cannot fall behind a
release. Verified in a real packaged build: the app launches clean with the
updater bundled. Next: cut 0.1.0 and 0.1.1 as drafts and watch an update land;
then the GD&T font (a public-release blocker) and the logo.

Done since rev 5: **the index-correctness work (rev 5 item 4) and file locking
(rev 5 item 5), both complete.** Nine index fixes plus the Library empty state;
two locking layers. §4 has the decisions, §3 the traps. Two things diverged from
the rev 5 spec and are worth knowing:

- Routing was specified as in-root AND inside a `PACKAGE_DIR`. It shipped as
  in-root ALONE. The second condition existed to guarantee a crawl could find
  everything in the shared index, and relative paths retired that: an in-root
  file resolves on every machine, so `reachable()` speaks for it whether a crawl
  reached it or not. The extra condition only meant that moving a package one
  folder out of its QC silently moved its record to a different index.
- Routing needed a partner nobody specified: `unpublish()`. A package can change
  which index it belongs to — dragged into the share, or out of it — and writing
  to the new one without retracting from the old left the Library listing it
  twice and the next rebuild flagging the stale copy missing.

Done since rev 4: **Inspect mode** — built, but NOT as rev 4 described it. The
reasoning held (records are frozen, a record can never propagate a fix back into
a sheet, so mixing authoring and filling buys nothing); the structure did not. A
third launcher door meant leaving through Home and re-entering through Quick
Find just to toggle a flag, and paying a save-or-lose prompt to do it. What
shipped is one package and two rail shapes — see §4. Also: centre-anchored zoom,
the share crawl rewrite, `PACKAGE_DIR`, the local index fallback, parallel
sidecar publishing, and the Inspect drawing pane.

Done since rev 3: divergence notice, recent packages, per-sheet unit set, sheet
duplication, invert / all-none, sidecar republish on open, in-page dialogs,
renumber shift, audit trail, Auto-Find. Dropped: FAI/AQL
template wording — the current wording is final, not placeholder; and
search/filter in Dimensions — decided against, people scroll to a number.

## 3. Traps that have already caused bugs

- **`node --check` parses as a SCRIPT.** `renderer.js` and `library.js` load as
  **modules**, where a duplicate `function` is a SyntaxError. Copy to `.mjs` and
  check that. `tools/check.sh` does this.
- **Never `String.fromCharCode(...bytes)`.** Spreading a Uint8Array overflows the
  stack past ~128KB. Use a loop, or hand bytes to main and write a temp file.
- **One `uid` counter serves every id family** (`dwg_`, `el_`, `sht_`, `insp_`).
  Derive it from the highest suffix actually present, never from a count.
  `dedupeIds()` repairs old duplicates on load.
- **`pushHistory()` snapshots BEFORE a mutation**; `markDirty()` runs after. They
  are not interchangeable. Typing uses `historyBurst(key)` so one field edit is
  one undo step. Snapshots must include elements, sheets **and** inspections.
- **Rendering must never mark the package dirty.** `dumpState()` used to mean
  two things — mark dirty *and* refresh the live manifest panel — and render
  paths called it to keep the panel current. So `renderSheets()`,
  `renderInspect()` and every `tolEditor()` built by `renderDimTable()` dirtied
  the package just for being looked at: changing tabs warned on close and added
  an area to the audit trail, and Fetch / Open Source re-dirtied a record the
  line after `markClean()`. The panel is now gone and `dumpState()` with it —
  the calls say `markDirty()`, which is all they ever meant. The canvas keeps
  the same split: `syncStage()` repaints, `commitStage()` repaints **and** marks
  dirty. Selection, PDF page navigation and the undo repaint take the first.
- **Pulling a `markDirty()` out of a shared path orphans its callers.** The one
  in `syncStage()` was the only dirty flag every canvas mutation had — drag,
  transform, draw, delete, Clear, and the style panel — and the one in
  `repaintAll()` was undo/redo's. Each now says so itself. Check what was
  leaning on it before removing one: over-marking is noise, under-marking is
  silent data loss at close.
- **A broad `querySelectorAll` overwrites a specific handler.** `#railHome` is
  `class="nav home"`, and the rail loop bound `.nav` further down the file, so
  the Home button silently ran the page switcher with `data-page === undefined`
  and hid every pane inside `#app`. Bind rail buttons via `.nav[data-page]`.
  `tools/handlers.js` checks for this class of clobbering.
- **`#dimTable` is `table-layout: fixed` AND has a `min-width`.** The rendered
  column is `nowrap`; under auto layout a long callout widens its own column
  instead of ellipsizing. Widths are set on the `<th>`s and only the last is
  left free — which means it absorbs the slack, and absorbs a *negative* slack
  down to zero once the pane is narrower than the sized columns add up to. The
  `min-width: 900px` floor is what stops the column silently vanishing; the
  scroll container then scrolls instead.
- **Same crush, different mechanism, on Inspect.** `.ins-row` is a flex line
  whose only elastic member is the dimension, at `min-width: 0` — so a narrow
  pane squeezed it to nothing and the entry cells sat where it had been.
  `--ins-min` on `.sh-editor` is the width the line actually needs
  (`392px + cols x 62px`), applied to **every** direct child of `#inspRows` so
  the band tags and section headers stay as wide as the rows rather than ending
  short once scrolled. It tracks `--ins-cols`, which `renderInspRows()` sets.
  If a row ever gains or loses a fixed element, that 392px has to move with it.
- **CSS: `#dimTable input { font: inherit }` beats any class rule.** An ID
  outranks classes, and the `font` shorthand resets the family. `.symtext` is
  applied via two selectors for this reason.
- **A circle with a 45° line is a magnifying glass**, not a balloon. Keep leaders
  vertical in iconography.
- **Never font-encode anything that gets stored.** `toFont()` belongs at the
  point of display and nowhere else; `toUni()` on the way back in. `renderSpec()`
  and `gdtToText()` return Unicode. This was wrong until 0.33.0: frozen
  inspection rows held Verisurf slot bytes (`]` for ±, `ä` for °), which the font
  swap would have silently corrupted with no way to decode them afterwards.
- **Verisurf blanks some Latin-1 codepoints** (±, °, −, —), which kills font
  fallback. Everything shown in that face goes through `toFont()`.
- **Print CSS and screen CSS must not restate any dimension** — all inline from
  `GEOM`, or preview and PDF drift.
- **Never `window.alert/confirm/prompt`, and no native message boxes either.**
  Both wedge the window. Everything goes through `dialog()`, with `notify()` and
  `confirmAction()` as the two thin wrappers over it. `window.api.message` is
  still exposed for the main process but nothing in the renderer calls it.
  Button labels come from the `BTN` vocabulary so "Delete" looks the same
  everywhere; `confirmAction` matches its `okLabel` against it, which is how a
  delete prompt gets the danger styling without the caller asking.
- **An overlay that is not a `dialog()` does not own the keyboard.** The
  launcher is plain markup, so `dialogOpen()` is false for it and every global
  shortcut still reached the drawing underneath — typing 'b' over the launcher
  switched tools. It gets its own `launcherOpen()` guard in the keydown handler.
  Anything else built as a bare overlay needs the same.
- **Use `getCropBox()`, never `getSize()`, when placing content on a page.**
  `getSize()` reports the MEDIA box; viewers and printers show the CROP box, and
  CAD exports routinely inset one from the other. Centring against the media box
  put the drawing off centre inside the crop box and ate most of the margin on
  two sides — a 0.5" setting printed as roughly a quarter inch, tighter at the
  left and top. Scaling is about (0,0), so an offset box also has to have its
  own origin taken back out of the translation: the left edge lands at `b.x * s`
  on its own and needs to land at `b.x + slack/2`.
- **`webContents.print()` margins do not reach a PDF.** That option lays out
  HTML; a PDF loaded into a window is drawn by Chromium's PDF viewer, which
  prints the pages as they are and never sees it. 0" and 1" produced identical
  paper. Drawing margins are baked into the bytes instead — `scaleContent()` +
  `translateContent()` in `stampedDrawing()`, after the bubbles are stamped so
  they shrink with the drawing — and both print paths now pass
  `marginType: 'none'`. Deterministic, and it survives any printer or driver.
  (The units differ too, if this ever comes back: `webContents.print()` takes
  pixels, `printToPDF()` takes inches, both in main.js.)
- **`print:dialog` passed no margins at all**, so Electron applied its ~1cm
  default while `print:pdf` forced zero — the same sheet HTML laid out two ways
  depending on whether you printed it or exported it. Both are `none` now.
- **One painter and one stamper, wherever a drawing is going.**
  `paintElements()` draws to a canvas, `stampElements()` draws to a PDF page,
  and both are shared by the editor and the library. The library carried its own
  bubble-only copy of EACH — so a rectangle or a note appeared when exported,
  vanished when printed, and was missing from the preview. Fixing the print
  alone left the preview wrong, which is the argument in miniature: two
  implementations of one picture will always drift, and each one found is a
  reason to look for the next. `paintElements()` takes its elements as an
  argument rather than filtering the module's own array — that was the only
  thing stopping it being shared.
  Also: the library's preview reset the canvas transform to identity while its
  backing store is `devicePixelRatio` times the CSS size, so annotations drew at
  1/dpr on any HiDPI screen. It sets `dpr` now, matching the editor.
- **One stamper draws a drawing, wherever it is going.** `stampElements()` is
  shared by the export path and the library's print path. The library used to
  carry its own bubble-only copy, so a rectangle, line or note appeared when
  exported and silently vanished when printed — two implementations of the same
  picture will always drift, and the one nobody looks at drifts furthest.
  `elementsFromManifest()` is the adapter: characteristics carry their balloon
  under `bubble`, annotations are already element-shaped because that is how
  they were serialised. pdf-lib fonts cannot cross documents, so the caller
  embeds the four faces and hands them over. The library uses Helvetica — it has
  no access to the Verisurf bytes, so GD&T glyphs in a note will not print from
  there until the font work lands.
- **`buildPage()` must never derive a document decision from one page.** Band
  count used to fall back to `bandCount(..., rows.length)` when `ctx` carried
  none, so it was recomputed from whatever rows landed on the page being drawn:
  a 210-row portrait sheet paginates to 6 pages with 5 rows on the last, five
  rows fit five times over, and the last page came out as five bands of the same
  bubble. Records never showed it because `inspCtx()` always supplied a frozen
  count that short-circuited the fallback. `sheetCtx(sh, totalRows)` is now the
  twin of `inspCtx(ins)` and the fallback is gone — banding is decided once for
  the document, and `buildPage()` has no way to guess it.
- **Listeners on the TARGET fire in the order they were added**, capture flag
  or not — the capture/bubble ordering only applies to ancestors. So a second
  keydown listener on an input cannot get in front of `guardKeys()`, which is
  why `guardKeys` calls `input._suggest?.key(e)` explicitly instead. If Enter
  ever moves two rows at once, that call went missing.
- **A capturing `scroll` listener on `window` sees the popup's own scrolling.**
  The suggestion list closes on scroll because the table moves under it, and
  that shut the list the moment the wheel went over it — and broke arrowing past
  the eighth entry, since `scrollIntoView()` fires a scroll event too. The
  handler checks `box.contains(e.target)` first. `.gpop` gets away with the
  plain version only because a symbol grid never scrolls.
- **A dialog owns the keyboard.** The global shortcut handler returns early on
  `dialogOpen()`. Without it Escape means "deselect" and Delete removes the
  selected element behind the prompt asking about it.
- **Python `str.replace` no-ops silently when the anchor is missing.** The
  sibling of the trap below: a run of edits all report success while some did
  nothing, and the file looks plausible. Count matches per edit and fail loudly
  on anything that is not exactly 1. Do not `cp` from an uploads directory
  without checking it is newer than the working copy — a stale re-upload will
  quietly undo the last session's work.
- **Python edit scripts abort before writing.** An assertion failure mid-script
  discards every earlier edit while still having printed "ok". Collect results
  and write unconditionally, then grep to confirm.
- **Node has no async filesystem calls.** `fs.readdir` is a blocking call handed
  to libuv's thread pool, which sizes itself ONCE from `UV_THREADPOOL_SIZE` the
  first time anything uses it and **defaults to four**. `CONCURRENCY` was
  decorative for as long as that was unset: four reads in flight whatever it
  said. It is set at the very top of main.js, before `require('electron')`,
  from a synchronous read of config.json — `loadConfig()` needs `app.isPackaged`
  and by then the pool may exist. Nothing doing async I/O may go above it.
  Verify with a blocking FIFO read, not `pbkdf2`: pbkdf2 is CPU-bound so it
  measures cores, not pool width.
- **`withTimeout` arms its deadline when the promise is CREATED, not when the
  work starts.** Queue enough requests behind the pool and they spend their
  deadline waiting for a thread, then reject — and `dirNames` caught that and
  returned `[]`, so a timeout was indistinguishable from an empty folder and a
  rebuild silently skipped whole subtrees of a perfectly healthy share. Two
  halves to the fix: bound what is actually in flight (one queue, not a
  `mapLimit` per level, which multiplies — 16 customers x 16 children is 256
  requests, growing with depth), and keep "could not read" distinct from
  "nothing here" so it can be counted and reported.
- **`fs.readdir` without `withFileTypes` cannot tell a file from a folder.** The
  old crawl probed `PART/QC` blindly rather than listing `PART`, on the theory
  that a miss is one round trip where a listing is many. It is not — SMB
  enumerates in batches — and without types the walker then recursed into every
  CAM file, doing a `PART/job01.nc/QC` probe per file. 12,861 round trips where
  2,301 would do. One typed listing per folder, every decision made from it.
- **A crawl's silence is not absence.** `markMissing` treated "the crawl did not
  see it" as "it is gone", but the crawl only ever looks inside the packages
  root: a working copy on a desktop, a package on a second share, one opened
  from a mail attachment. None were ever going to turn up, and flagging them
  dropped them out of the Library. `reachable()` asks the filesystem first, and
  only for records the crawl did not account for. Still load-bearing after the
  routing work lands, for four cases INSIDE the root: deeper than
  `SEARCH_DEPTH`, under an unreadable folder, not in a `PACKAGE_DIR`, and the
  whole local index.
- **`indexRoot()` returning null took the Library down with it.** Two guards —
  `index:search` and `lookupSidecar` — refused before looking, so with no share
  configured the Library could not read its own local index and an opened
  package could not find its own sidecar. Neither could fire before, because
  nobody reached them without a share. It always resolves now; a miss reads as
  a miss.
- **A folder-depth floor can make a whole tree shape unreachable.**
  `Math.max(2, depth - 1)` quietly assumed a customer level above every part
  folder — true of this shop, of nobody else — so `ROOT/PART/QC` could not be
  indexed at ANY `SEARCH_DEPTH`, and 1, 2 and 3 all meant the same thing. The
  floor is 1. The root is still never a part folder: a share with a `QC`
  department folder at the top would otherwise end the crawl on its first
  listing.
- **A stray package folder among real part folders swallows its siblings.** A
  folder holding a `PACKAGE_DIR` is a part folder by the only definition the
  crawl has, so it stops there and nothing beneath it is indexed. Nine of these
  existed here; one hid five real packages. The signature in the shape log is a
  jump in the depth-1 "holding a QC" count. Deliberately NOT auto-detected — the
  ambiguity is genuine and a rule would guess.
- **Anchored popups must sit ABOVE every overlay.** `.gpop` at 80 and `.sugg` at
  85 sat under the modals at 90, so the symbol palette opened BEHIND the
  override editor that has a button for it. A popup belongs to whichever control
  opened it and controls live inside modals. Safe on top because both close on
  outside mousedown, Escape and scroll, so neither can be left over a dialog.
- **A CSS class applied only from JS is invisible to a search of the markup —
  and a shorthand silently zeroes a longhand.** `.mode-btn` / `.mode-split` are
  set via `className` in the GD&T builder and appear nowhere in index.html, so
  they read as dead and got deleted. They are not. The collision that caused it:
  a rail rule named `.mode-split { margin-top: auto }` lost to an existing
  `.mode-split { margin: 0 3px }` purely on source order. `cssaudit.js` now
  reports selectors defined more than once, which is what a name collision looks
  like — it cannot see the first half, so grep the JS for `className` before
  concluding a class is unused.
- **A record read out of an index must be resolved on the way OUT and stored on
  the way BACK IN.** Shared records hold a path relative to the packages root;
  `readRecord()` makes it absolute so nothing above that line handles a relative
  path. Every write back — `markMissing` flagging, `index:flag-missing` — has to
  run it through `toStored()` again and drop the `sharedIndex` marker, or a
  flag-then-unflag cycle silently writes an absolute path into a shared record
  and the next machine cannot read it.
- **Routing decides where a publish GOES; something has to decide where it
  stops living.** A package can move between the two indexes, and writing the
  new record without retracting the old one leaves the same id in both: the
  Library lists it twice and the next rebuild flags the stale copy missing while
  the live one sits there fine. `unpublish()` is that retraction, and it is safe
  only because the fork check has already settled that this file owns the id.
- **A folder-subtree skip must use `path.relative`, not a string prefix.**
  `/share/PN-1` starts-with-matches `/share/PN-12`, which would have let one
  locked folder shield a package that had nothing to do with it.
- **A lock is advisory and cannot be the guard.** A crash outlives it, a network
  drop orphans it, somebody edits the file with the app closed. What protects
  the work is the size+mtime stamp checked at write time in `dialog:save` — the
  file on disk cannot lie about having changed. Build that first and treat the
  lock as what it is: the thing that stops the wasted hour, not the lost work.
- **Silent lock takeover needs the token check on BOTH sides.** Taking a stale
  lock without asking is only safe because the original holder discovers, on its
  next heartbeat, that the token no longer matches — and drops to read-only
  instead of two machines both believing they hold it. Without that half, the
  takeover is the bug it was meant to prevent.
- **`const` at the bottom of a file, called from the top, works by accident.**
  `sameStamp` sat 900 lines below `dialog:save`, its only caller, and only
  worked because IPC handlers run long after module evaluation — unlike the
  `function` declarations around it, which genuinely hoist. Keep helpers next to
  their callers rather than relying on when the caller happens to run.
- **Spending a counter is a mutation, and it can happen BEFORE the edit is
  known to be one.** `commitCreate()` builds a shape with `n: nextNumber++` and
  `uid++`, and only after it returns does the caller know something was drawn —
  so `pushHistory()` ran after the counters moved, and undoing a bubble put back
  a Next # one past it. `pushHistory(snap)` takes a snapshot taken earlier; the
  mouseup takes one before `commitCreate()` and pushes it only if an element
  came back. Anything else that mints and then decides needs the same shape.
- **Anything the snapshot leaves out, undo silently disagrees with.** Drawings
  were not in it: elements were, so undoing a drawing's removal brought its
  bubbles back pointing at a `documentId` that no longer existed — ghost rows in
  Dimensions and Sheets. `docs` is now snapshotted BY REFERENCE (bytes are
  immutable and large), `removeDocument()` destroys the pdf.js proxy and nulls
  it, and `settleDocs()` rebuilds proxies from bytes for drawings a step brings
  back and destroys them for drawings it takes away. It only changes the active
  drawing when the set changed — undoing a bubble must not jump to page 1.
  Steps queue on `historyChain` because a step can now await pdf.js.
- **Never reset `uid` while anything still carries an id.** Clear Annotations
  did `uid = 1` with drawings, sheets and records still open: the next drawing
  added became `dwg_1` beside an existing `dwg_1`, and a fresh `el_1` would be
  picked up by any sheet still holding the cleared `el_1`. Only a whole-package
  reset (New, Open) may put the counter back.
- **Ctrl+Z is two paths, and a text field needs both to stand aside.** The
  window keydown handler is one; the Edit menu accelerator is the other, and it
  fires for any key the page did not handle — including every table input,
  since `guardKeys()` stops propagation. Returning without `preventDefault()`
  lets Chromium undo the typing and mark the key handled, so the accelerator
  stays quiet; the menu case still checks `textField()` and runs
  `execCommand('undo')`, which covers a field with nothing left to undo and a
  mouse click on Edit > Undo. `textField()` is narrower than `typing`: a focused
  checkbox has no undo of its own.
- **Never render a pdf.js page straight into the canvas on screen.** Setting a
  canvas's width clears it, so `renderPage()` blanked #pdfLayer for the length
  of every render while the Konva balloons sat on top at the old size — the
  Bubbler zoom lag. It renders offscreen and swaps in one synchronous block.
  Renders are numbered and a newer one cancels the older task (a canvas cannot
  take two `render()` calls at once); `renderPage()` returns whether it landed,
  and only a landed render settles a held scroll restore.
- **Anything that holds a package's bytes holds a stamp with them.** The
  Library read a package once and previewed from memory, so a save from Bubbler
  never reached it until another package was opened and this one reopened.
  `freshen()` compares the held stamp with `package:stamp` — a stat, never a
  read — on returning to the Library and before any item is selected. Its
  `readPackage` caller also still expected bare bytes after the lock work made
  it `{bytes, stamp}`; the project copy had drifted from the dev folder.
- **Never write `input.value` to insert into a field the user is typing in.**
  It wipes the field's native undo history, so once Ctrl+Z in a field meant the
  field, undoing a symbol from the palette did nothing. `insertAtCaret()` goes
  through `execCommand('insertText')`, which joins the field's undo, replaces a
  selection the way typing does, and fires a real `input` so the field's own
  commit path — historyBurst included — runs. The GD&T modifier `+` was worse:
  it wrote `g[field]` directly and skipped the burst, invisible to both undos.
- **A failed load must leave nothing loaded.** The Library's open caught the
  error and printed it, but kept the previous package in `openPkg`, so its card,
  drawings and Open/Inspect buttons all survived under a message about another
  package. Anything that replaces state on success clears it on failure.
- **Async results that render must be sequenced.** `renderPage()` (numbered
  renders) and `runSearch()` (numbered searches) both learned it the same way:
  an older answer arriving last paints a state from before.
- **Every flag that describes the open package must be reset by everything that
  replaces the package.** `readOnly` and the lock were reset by `loadFile()` and
  Save As, but not by New: a New after a read-only open refused to Save a
  package nobody else had, and kept the old package locked until quit.
  `resetDocument()` now clears `readOnly`, `newerSchema`, `fileStamp` and the
  lock; `openInsp()` sets `newerSchema` fresh; record mode clears it.
- **Boot code at the top of the file cannot reach a `const` further down.** The
  launch update check sat beside `loadConfig()` and read a `const` declared in
  the update block below it: `Cannot access 'UPDATE_CHECK_DELAY_MS' before
  initialization`, in the packaged build, with the whole renderer dead. Function
  declarations hoist; `const` and `let` do not. The call is now the last line in
  the file. Caught only because the packaged app was actually launched — nothing
  static flags it.
- **An installer update removes the old install folder.** Anything the app
  wrote beside its executable — config, recents, recovery, the local index —
  would vanish on every update, and the default per-user install folder is
  writable, so the old "beside the exe if writable" rule chose exactly that
  folder. `DATA_DIR` is computed by hand at the top of main.js (the pool sizing
  needs config before `electron` loads), with the same productName-else-name
  rule Electron uses, and pinned with `app.setPath('userData')` so the two
  cannot drift. No migration, by rule.
- **An allowlist for `build.files`, never `**/*`.** The dev folder holds
  config.json with real share paths, recents, the local index, tools/ and old
  dist/ output; a glob of everything ships all of it to strangers.
- **The OS overwrite prompt knows about files, not sessions.** "Replace b.insp?"
  cannot know b.insp is open in another instance, so Save As overwrote live
  packages. Main checks the target's lock before writing to any picked path.
- **Main outlives a page reload.** Anything main holds on the page's behalf —
  the lock today — survives View > Reload while the page forgets it. The page
  releases at boot, because nothing is open at boot.
- **A wheel listener that calls `preventDefault()` must say `passive: false`.**
  Otherwise Chromium ignores the call, logs a warning, and the page scrolls
  underneath the zoom.
- **Opening a package must never write it.** Anything that persists on open
  either writes an `.insp` somebody only looked at, or marks a viewed package
  dirty — and read-only shares and locked files make it fail outright. This is
  why the `packageId` fork is CHECKED on open and MINTED on save (§2). Holding a
  mint in memory is worse than either: the index gets an id the file's own bytes
  do not carry, so the next open mints again, and `source:resolve` sends
  `doc.package.id` — every record exported from the fork would claim to come
  from the original.

---

## 4. Locked decisions

- All persisted coordinates in **PDF points**; convert only in `canvasToPdf` /
  `pdfToCanvas`.
- Text anchored on the **alphabetic baseline** both sides.
- Bubbles are characteristics; rect/line/text are annotations.
- `dimension` is **free text** — the whole callout including tolerances. The old
  `{type, a, b}` model was removed: nothing read it, and it could not express
  `.02 +0 / -0.1 x 45° ± 1°`.
- **A dimension row is one line, six columns:** `[+/-] [#] [editor] [method]
  [notes] [rendered]`. The number cell's rowspan is what pushes a sub-row's
  first cell into the action column, so parent and child controls line up
  without breaking the merged number cell the sheets rely on. `paintSpec()` is
  the only writer of the rendered cell.
- **Sheets are authored, not derived.** Subs are welded to their parent.
- **Inspections are snapshots** — own frozen rows, own band and column counts.
  Editable on the record; never written back.
- Gage ID is **per band**; dimension and method are shared across bands.
- Drawing `sha256` covers raw PDF bytes only. Ballooning never changes it.
- Index sidecars are **one file per package**, so no two machines write the same
  file. A full rebuild flags absent packages `missing` rather than deleting them.
- **The audit trail is coarse on purpose, and is not evidence.** It records
  who, when, which areas were touched, and what was created or deleted by name.
  It does NOT record field-level before/after values: that is a large, noisy
  artifact, and the app cannot make it tamper-evident since an `.insp` is a zip
  anyone can edit. The History dialog says so in as many words. Names come from
  `os.userInfo()` and are unverified.
  - Appended on save, never rewritten or trimmed. A save with nothing pending
    adds no line. **Autosave must never append** — a recovery file is not a
    save, and crash recovery must not invent history.
  - Only a change to package **contents** counts. Which page the rail is on,
    which PDF page is showing and what is selected are behaviour, not content:
    they neither mark dirty nor claim an area. The default unit is stored, but
    it is set by the unit buttons, not by arriving at Dimensions.
  - The area label comes from the rail page at the time of the edit, so it is
    approximate. Naming the sheet or record being edited is worth far more than
    naming the field. Anything already listed as created or deleted is dropped
    from `changed`, or one action reads as two events.
  - Exported records carry a copy of the trail, so a record that outlives its
    package can still say who built what it came from.
- **Renumbering is "at or above", inclusive, and refuses to collide.** Sheets
  reference characteristics by element id, so a shift moves printed numbers
  without touching what any sheet includes. Two bubbles sharing a number look
  fine on the drawing and are ambiguous on every sheet built from it, so Apply
  refuses and reopens the dialog saying why, rather than warning about it.
  **No preview step.** Its before/after lists read as a wall of numbers and it
  guarded nothing the undo stack does not — the shift is one step. Up/Down plus
  a typed amount, not six fixed choices.
- **A sheet chooses its unit set; a package does not.** `sh.units` is `'in'` or
  `'mm'`, and `specSource()` is the only reader. An unauthored alternate yields
  **nothing**, never the inch value: a blank on a printed form is a question the
  inspector asks, an inch number under an mm heading is one they do not. The
  count of unconverted rows is shown next to Export. Notes ride along from the
  parent — a note is about the feature, not the units. Print mode calls the same
  function through `BubblerSheets`, so the two modes cannot disagree.
- **Auto-Find is view state.** The `Find` toggle in the Dimensions preview bar
  scrolls the preview to the bubble for whichever row is being edited, switching
  drawing and page as needed and washing the balloon in 10% accent. Armed by any
  `<input>` in the row, not just the dimension column — choosing an instrument
  means looking at the feature too, and Notes are used rarely enough that the
  hop costs nothing. Buttons in the cells do not arm it, so working the GD&T
  builder leaves the view still. Sub rows carry their parent's `data-el-id`,
  since a sub has no balloon of its own. **On by default**: a toggle nobody
  finds is a feature nobody has. Per-session, and it never marks dirty or claims
  an audit area — where you are looking is not package content. The wash is a
  filled disc, not a ring: a ring has a real stroke width and lands squarely on
  the callout it points at. Drawn after `paintElements()` and deliberately
  outside it, which draws only what the package contains.
- **Selection is a Set, but `selected()` still returns one element or none.**
  Everything that predates multi-select — every property field, the leader
  handle, the rect transformer — keeps working untouched and simply goes quiet
  for a group, rather than picking one member's answer to show. `isSel()`,
  `selCount()` and `selectedEls()` are the multi-aware accessors; a bare
  `selected()` is the single-selection question.
- **Never `syncStage()` from a `mousedown` on a shape.** It rebuilds the layer
  and destroys the node Konva has just taken hold of, so the drag dies on the
  spot — grabbing an unselected element cost a wasted click before it would
  move. The selection set is updated silently there; the repaint arrives on
  `click` if there was no drag, or on `commitStage()` if there was.
- **A group drag moves NODES during the gesture and the model at the end.**
  Rebuilding the layer mid-drag would destroy the node Konva is holding, so
  `beginGroupDrag()` captures the others' nodes and `endGroupDrag()` writes the
  displacement once. One `pushHistory()` for the whole gesture: twelve bubbles
  moved together must cost one undo, not twelve. The delta is taken as the
  difference of two `canvasToPdf()` conversions rather than dividing by `scale`,
  so it survives a rotated page. And the `dragend` handlers had to stop calling
  `selectOnly()` unconditionally — that collapsed a group to the one element
  dragged, the instant the drag finished.
- **A multi-selection shows a value only where the members agree.** Excel's
  rule: blank where they differ, the shared value where they do not, and any
  edit reaches all of them. Colours are the exception — a colour input cannot
  render blank, so the first member's colour stands in as a starting point for
  the picker, not a claim that they match. `pNoFill` uses `indeterminate` for
  part-filled groups, which a checkbox CAN express.
  A field is only shown when it means one thing across the whole selection:
  "size" needs all balloons or all text, stroke width needs neither. The number
  field needs every member to be a REFERENCE bubble — sharing a number is what
  those are for, while five real bubbles sharing one is the exact thing renumber
  exists to prevent. Format buttons SET rather than flip: flipping a mixed group
  leaves it just as mixed, only inverted.
- **The marquee touches, it does not contain.** An element counts if its box
  MEETS the sweep, so a rough sweep across a cluster picks it up without having
  to enclose the outermost leader. Text is the exception: it has no measurable
  width in PDF space, so its anchor point is tested instead of a guessed box —
  an approximate box would catch things nobody swept, which is worse than
  needing to touch the anchor.
- **Reference bubbles are their own element type, not a flag.** `refbubble`
  annotates rather than describing a characteristic, echoes the number of the
  balloon it accompanies, and carries no data and no leader — avoiding a leader
  that would cross the part is the whole reason it exists. A flag on `bubble`
  would have failed OPEN: every `type === 'bubble'` test keeps matching, so one
  missed guard yields a phantom dimension row, a number that shifts under
  renumber, or a line in a frozen export. A separate type fails CLOSED — those
  sites stop matching for free and the places that want it are opted in by hand
  (draw, hit-test, drag, preview, PDF stamp, manifest). Forgetting one shows up
  at once as "it does not draw", which is the cheap failure. `isBalloon()` marks
  every deliberate opt-in; a bare `type === 'bubble'` is the exclusion.
  It rides in `annotations`, never `characteristics`, so it is absent from the
  dimension table, sheets and the workbook by construction. Schema 0.36.0.
- **The reference tool has its own visible number.** `refNumber` is separate
  from `nextNumber` because a reference bubble borrows a number and never
  consumes one, and it shows in the defaults strip labelled "Number" rather than
  "Next #" — nobody should place one to find out what it was going to be.
  Selecting any balloon arms it with that balloon's number. That has to happen
  in `syncEditor()`, NOT at creation: pressing down on the canvas clears the
  selection before `commitCreate()` runs, so reading `selected()` there always
  found nothing. First attempt did exactly that and silently always used 1.
- **Tools are BORROWED, never switched — one mechanism, two callers.** Shift
  from the bubble tool borrows the reference tool numbered to the bubble just
  placed (`nextNumber - 1`); the right button borrows select from any tool and
  sweeps a marquee in the same motion. `borrowTool(to, why)` / `returnTool(why)`
  hold ONE borrow at a time, tagged with why — two independent flags would let a
  Shift release end a right-button borrow and put the wrong tool back. Releasing
  always restores, so a mode cannot be left on by accident, but only if the
  borrow is still in effect: reaching for the toolbar mid-hold is deliberate.
  Guarded against key repeat, `Ctrl+Shift+Z`, mid-drag, dialogs, the launcher
  and text fields.
- **Middle-button pans; `enablePan(el)` works on any scroller.** It replaces the
  browser's autoscroll, which drifted by distance-from-origin instead of
  following the pointer. `scrollLeft/Top` move opposite the pointer so the
  drawing follows the hand. `preventDefault()` on mousedown is what suppresses
  autoscroll — Chromium arms it there, not on the click. Listeners live on
  `window` for the duration, since a pan that runs off the element still has to
  track and its mouseup usually lands elsewhere. Wired to `#viewport` and all
  four preview panes — `#prevScroll`, `#shPrevScroll`, `#inspPrevScroll` in
  renderer.js, `#libScroll` through `sheets().enablePan` in library.js. Every
  scrolling document surface pans, and zooms on Ctrl+scroll; only the Konva stage passes a
  `restoreCursor`, because it is the only one that owns its cursor.
- **Every canvas handler must check WHICH button pressed it.** Suppressing
  autoscroll did not stop the middle button reaching the tools, so a pan also
  opened a marquee. It was invisible while the pan tracked — the pointer holds
  still in stage coordinates when the scroll keeps up — and only appeared once
  the scroll hit its limit, drawing a line against one edge or a box in a
  corner. All three buttons now do something distinct and none overlap: left
  draws, middle pans, right sweeps.
- **A held gesture needs three ways to end, not one.** `blur` releases any
  borrow and drops the marquee, because alt-tabbing away delivers neither keyup
  nor mouseup. And the right-button sweep has a `window` mouseup backstop: the
  stage only hears a mouseup that lands on it, so letting go past the edge of
  the canvas would otherwise leave the marquee drawn and select borrowed for
  good. `Konva.dragButtons = [0]` keeps the right button from starting a shape
  drag, and `wireCommon`'s mousedown lets button 2 through to the stage — a
  sweep that begins over a bubble is still a sweep.
- **A link the user did not ask for is worse than no link.** Renumber offers a
  checkbox, off by default, to carry reference bubbles along. They are excluded
  from the duplicate check on purpose: several legitimately share one number, so
  a collision among them is normal rather than the ruinous case that check
  exists to catch. Deleting a bubble does nothing to them at all.
- **A feature's only option belongs beside its switch.** Auto-Find's glide/jump
  toggle sits next to the Find button in the preview bar, not in Settings: one
  option, two screens from the control it modifies, is an option nobody finds.
  It starts from `prefers-reduced-motion` rather than an opinion, and disables
  itself when Auto-Find is off, since a control that silently does nothing is
  worse than one that says so.
- **`METHOD_LIST` is mutated, never reassigned.** `attachSuggest()` captures the
  array when a row is built, so swapping the reference would leave every
  existing row completing against the old list until something happened to
  rebuild the table. Settings edits it in place. The list lives in `config.json`
  once edited — `assets/methods.json` is the built-in default and is read-only
  once the app is packaged. Emptying the box restores it.
- **The method list suggests, it does not validate.** `assets/methods.json` is a
  flat array of strings feeding an Excel-style dropdown on the Method column:
  type to filter, arrows to move, Enter to take it and drop a row, Tab to take
  it and move across, Down on an empty field for the whole list. The best match
  is **highlighted as soon as you type**, so the common case is one letter and
  Enter; the arrows are for when it guessed wrong. What is highlighted is always
  what Enter and Tab will take — accepting something never shown as selected is
  the same trap as a silent autocorrect. Opening the full list on an empty field
  highlights nothing, so Enter on a blank Method leaves it blank rather than
  stamping in whatever sits first in the file. Anything typed
  is kept whether it matched or not — a gage that is not on the list must still
  be recordable, or the list becomes a reason to leave the column blank.
  Prefix matches rank above substring matches. `attachSuggest()` is generic and
  takes its list as an argument, so Notes can have one later without a rewrite.
- **Margins are for drawings only.** Sheet geometry is measured against a full
  page, so any margin pushes the bottom row onto a page of its own — sheets
  print edge to edge, always, and `PRINT_MARGIN_IN` does not reach them. A
  drawing is a foreign PDF with whatever border its author chose, often none, so
  it is the one thing that needs the printer's unprintable edge handed back.
  Scaling is uniform and applied after stamping, so bubbles shrink with the
  drawing and keep pointing at the same features. One scale for both axes: the
  tighter axis gets the margin asked for and the other gets more, because
  fitting each axis independently would hit all four margins exactly and stretch
  the drawing to do it. Page size never changes — only the content inside it.
  **The exported PDF is deliberately NOT margined.** A print needs the
  unprintable edge handed back; an archived drawing should be true to itself,
  and silently scaling one to 88% would falsify anything measured off it.
- **Buttons are singular, the menu is plural.** The per-tab Export PDF buttons
  act on the one thing in front of you with a single save dialog. `File >
  Export…` multi-picks and writes a folder full, for all three of sheets,
  records and Excel data. Both go through the same builder — `sheetPdfBytes()`
  / `inspPdfBytes()` return bytes and nothing else, so the two paths cannot
  produce different PDFs. Batch writes ask for one folder rather than one dialog
  per file, and de-duplicate names within the run so nothing is silently
  overwritten. Menu labels are deliberately dissimilar — "Inspection sheets",
  "Filled-in records", "Excel data" — because sheet/record/data all started with
  the same word and had to be read twice to tell apart.
- **The library is one screen with one door.** Print mode became the library:
  `#printMode` -> `#library`, every `pm*` id -> `lib*`, `print.js` -> `library.js`
  (and the three CI scripts that name it). Both actions sit in the footer —
  Print primary, "Open for editing" beside it — rather than being chosen before
  you arrive, because picking the door first means finding the part, realising
  you wanted the other verb, and walking all the way back out. A quiet "open a
  file directly" in the bar covers packages with no sidecar.
- **library.js still writes nothing.** Adding Open did not make it a mutator:
  it hands the path to `window.openPackageForEdit()` and renderer.js does the
  loading, so opening from the library, from a recent, and from a file pick are
  one code path with one dirty guard. The library also sets no screen state for
  those actions — the shell owns that, and it is the only side that knows
  whether the load happened. Hiding the screen before calling out meant a
  cancelled file picker left a blank window.
- **The launcher covers the workspace, it does not replace it.** One overlay
  replaced both `#modeSelect` and `#welcome`. A live session stays visible
  behind it, and that visibility IS the "you can go back" affordance — so there
  is no return button, and Home no longer prompts to leave: nothing is being
  discarded, only covered. It closes only when there is something to close onto;
  on a cold start Escape and the backdrop do nothing, which is what makes the
  first-run case need no separate screen. Buttons are New / Quick Find, with
  Open demoted to a text link, because habit is shape recognition — a quieter
  button in the same silhouette still collects the reflex click. One primary
  only: on a dark ground a white button outshouts the accent, so New stays a
  normal control. Captions name what you DO at the destination, and "Open or
  print a package" is the only signpost that printing exists at all now that the
  big Print button is gone.
- **The Excel export is a raw data dump, not an integration.** Bubbler+ appends
  sheets of plain text and has no opinion about what happens next — hand-format
  them, point formulas at them, or bake them with a macro; all three are valid
  and none require anything from the app. Columns are append-only forever: a
  dataset that changes shape gets a NEW column, never a redefinition, because
  consumers hard-code positions. Collisions suffix rather than replace, so an
  export can never delete older data. Sheets are identified by
  `A1 = AppVersion&Schema`, not by name, which survives renaming and cannot
  false-positive.
- **A workbook that SHRANK after an append is not a damaged one.** The real
  QF-0022 went 72 parts in, 77 out — 69 byte-identical, 3 changed by design, 0
  lost — and got 6 KB smaller while gaining 58 KB of content. Excel had stored
  the three `xl/media/*` parts uncompressed and deflates the rest loosely (20.0%
  overall); `fflate` at level 6 reaches 18.2%. Purely a better zip. Check the
  part list before concluding anything went missing.
- **Never rebuild a workbook to write to it.** Rebuild-style writers
  re-serialize from their own model, so anything unmodelled is dropped — and in
  a controlled form that means macros, print setup, conditional formatting and
  form controls. `xlsx-append.js` parses only the three parts it must change and
  copies the rest through as bytes. `xlsx-populate` was tested and preserved
  everything in the fixture, but it still rewrites untouched sheets; zip surgery
  does not, and costs one 844 KB zero-dependency library instead of twenty
  packages.
- **Sidecars are republished on open, not only on save.** A package moved by
  hand leaves a sidecar pointing where it no longer is; opening it corrects
  that, so the index heals as people work instead of waiting for a rebuild.
  Best effort, and silent — a share that is down must not block opening a file.
- **Recents are paths, not contents.** `recents.json` lives beside the exe, not
  in a package: it is this machine's history, not the part's. Existence is
  stat'd at read time and never stored, so a share that was offline yesterday
  leaves no tombstone; a missing entry greys out rather than disappearing.
- **Divergence is reported, never reconciled.** `noteDivergence()` compares the
  `recordHash` a record PDF carries against a fresh hash of the package's copy
  of that inspection, on both Fetch and Open Source. It notifies once and stops:
  records are snapshots and are never written back.
- **No migration code until the live app.** Pre-1.0, a schema bump means
  building a fresh test package, which takes a minute. Writing migrations costs
  far more than it saves and they would all be thrown away. Bump
  `SCHEMA_VERSION` when the stored shape changes and move on. Revisit only once
  real packages exist in the wild.
- **Display font-encodes; storage is Unicode.** The inputs render in the
  Verisurf face, so `toFont()` on the way out of storage and `toUni()` on the way
  in — `textInput`, `glyphInput`, `sharedSpecInput`, `colInput` and the
  `buildPage` cells all do this. Because of it, swapping the face really is a
  table swap: change `ALL_SYMS` and nothing persisted has to move.
- **Font licensing:** Verisurf.ttf is © Verisurf, embeddable in documents but not
  redistributable in an app. The replacement is a Liberation Sans derivative
  (SIL OFL, redistributable) with the symbols drawn at real Unicode codepoints.

- **Rectangles are always underneath.** `underlay(el)` is the one question, and
  `syncStage()`, `paintElements()` and `stampElements()` all ask it: rectangles,
  then leaders, then everything else. A rectangle is drawn around something, so
  creation order put it on top of what it surrounds, and Konva hit-tests in draw
  order — a filled one made everything inside it unselectable. Layering controls
  were considered and rejected: a menu, stored order and shortcuts, to serve a
  box on top of a balloon that nobody wants. The stamper also lost its habit of
  drawing each leader just before its own balloon, which let a later balloon's
  tail cross an earlier one on paper and not on screen.
- **Tool sizes are remembered per drawing; colours are not.** `SIZE_KEYS` —
  radius, fontSize, strokeWidth — are stored on `documents[].defaults` when set
  from the strip, and `setActiveDoc()` applies them through `applyDocSizes()`,
  falling back to `BUILTIN_DEFAULTS` for anything unset so one drawing's large
  balloons do not follow you onto the next. A size is a function of the print;
  a colour is a preference, and should not change under you on a click to
  another drawing. Per drawing rather than per package because one package can
  hold an A-size detail and an E-size assembly. Being stored makes a size edit
  package content: it marks dirty. Loading fills missing style keys from
  `BUILTIN_DEFAULTS`, never from the live strip. Schema 0.37.0.
- **Removing a leader is dropping its end back inside the balloon.** The same
  rule `DEADZONE` applies when one is drawn, applied when one is edited
  (`handle()`'s `onEnd`); reach is the larger of the radius and `DEADZONE`. No
  button, no menu — the gesture already existed in reverse.
- **Ctrl+scroll zooms about the cursor; everything else holds the centre.**
  `wheelZoom(scroller, slider)` moves the pane's own slider and dispatches its
  `input`, so all five surfaces keep one zoom path each and the Library gets it
  through `BubblerSheets`. `holdCentre()` reads `zoomAnchor` when it belongs to
  its scroller — set only for the length of that dispatch, captured
  synchronously, so a coalesced render keeps it and nothing else ever sees it.
  Multiplicative, from a float carried on the slider: a mouse notch is about
  14%, and a trackpad's small deltas accumulate instead of rounding back to the
  slider's step.
- **Zoom holds the middle of the view, never the top-left corner.** Every zoom
  control grows its content about the scroller's origin, so what you were
  reading slid away and the next thing you did was pan back. `holdCentre(scroller,
  content)` notes where the centre of the pane falls inside the content and
  scrolls it back there; it returns the restore, so a caller reads as capture /
  resize / restore and an async one can hold the closure until its render
  settles. Measured with `getBoundingClientRect()` rather than from scale
  factors, because the five controls have no scale in common — three re-render a
  canvas at a new pdf.js scale, two set CSS `zoom` — while a client rect reads
  the same for both and absorbs padding, `margin: 0 auto` centring and the gaps
  between page wraps without naming any of them. The fraction is deliberately
  not clamped to 0..1. Shared to the Library through `BubblerSheets`.
- **The rail has two shapes and one flag picks between them.** Authoring lists
  Bubbler, Dimensions, Sheets; inspecting lists Inspect. `applyRailMode()` hides
  by `data-page`, and `setInspectOnly()` also navigates, because the failure
  mode otherwise is being parked on a page whose rail button just vanished with
  nothing active. The swap is pinned to the floor of the rail by `margin-top:
  auto`, carries no `data-page` so the page wiring's selector cannot claim it,
  and never takes `.active`: it is a state of the rail, not a page in it. It is
  labelled for where it GOES. No dirty guard and no reload — nothing leaves
  memory, which is the entire point, since going out through Home and back in
  through Quick Find did the same job and charged a save-or-lose prompt for it.
  Hidden during a record, because a record has no package to author and saving
  is already blocked; every route out of a record runs through
  `clearRecordMode()`, which is the one place that has to restore it. Mode is
  per-session and does not persist — one button away.
- **Inspect shows the DRAWING, Sheets shows the sheet.** Sheets is where the
  sheet's shape is decided, so a paged proof is the thing worth checking there.
  Inspect only fills it in, and those values are already legible in the table
  beside it; what an inspector needs on screen is the bubbled print telling them
  what to measure, or it has to be a paper copy on the bench. Same pane as
  Dimensions — document picker, page nav, zoom, `holdCentre` — via
  `paintDrawingPage()`, which both call; the only thing they disagree about is
  the overlay, and one optional callback beats a second copy of the pdf.js
  wiring. The pill counts real bubbles only: a reference bubble shares its
  number with one. Four per-keystroke repaints came OUT when this landed — the
  drawing does not depend on the job number, and against pdf.js a repaint per
  key is a page render per key. A record carries no drawing bytes at all, so the
  empty state there names Fetch rather than reading like a broken pane, and
  Fetch fills the pane instead of jumping to Bubbler.
- **The index is beside the app unless someone chooses otherwise, and the choice
  requires a packages root.** It used to default to a dot-folder inside the jobs
  tree, which meant creating a folder in somebody's share that nothing
  explained — and an unexplained folder on a shared drive is one that eventually
  gets tidied away. Beside the exe it sits with `recents.json` and
  `recovery.insp`, which are also this machine's business. The trade is that the
  index is per-machine by default; a site that wants one shared index sets Index
  folder on each machine. `appDir()` falls back to userData when the app sits
  somewhere unwritable.
- **A rebuild with no packages root rechecks the index instead of refusing.**
  There is still an index — the local one — and refusing left the only repair
  tool unavailable to exactly the people with no share. An empty found set plus
  the reachability check IS the honest subset of a rebuild: it cannot discover
  anything new, but it can say what has gone and what has come back. Reported as
  a recheck, not as a crawl of zero folders.
- **`PACKAGE_DIR` is configuration, not a rule.** `QC` is what this shop calls
  the folder holding the `.insp` files; a shop filing under `Inspection` sets it
  and everything follows, because it is the only thing the crawl uses to
  recognise a part folder at all. Matched case-insensitively.
- **`CONCURRENCY: 8`, measured.** On a 9,240-folder share: 1 read at a time gave
  14 folders/sec, 4 gave 50, 16 gave 112 — and 32 gave 110, so 16 was already
  past the knee. Whatever saturates is on the far end. Eight buys most of it and
  leaves half the pool for the rest of the app. The same tree read 189
  folders/sec on a quieter day at the same setting, so compare runs within one
  session or not at all. Changing it takes effect on the next launch, because
  the pool is sized once.

- **Two indexes, kept disjoint by routing.** Shared holds everything under the
  packages root; local holds everything else, beside the app. No package is a
  candidate for both, so there is never a tie to award and the union is a
  concatenation rather than a negotiation. It also buys the property that makes
  `markMissing` trustworthy on the shared side: everything in there is under the
  root, so every machine can reach it and every machine's reachability check
  means the same thing. A package on somebody's desktop is not absent from the
  share — it was never going to be there.
- **Shared records store a path relative to the packages root.** Two machines
  reaching one share as `Z:\Jobs` and `\\srv\jobs` otherwise write paths the
  other cannot match, and every one of those records got flagged missing. It is
  what makes the whole shared index viable, and it is total rather than partial
  only because an index folder is refused without a packages root — so a
  relative record always has something to resolve against, by construction.
- **A move and a copy differ by one question: is the old path still there?**
  `idTakenElsewhere()` asks it, and both fork fixes fall out. Live means copy:
  opening does not repoint, and saving mints a new `packageId`. Dead means move:
  the record follows the file and keeps its id. Checked on open, minted on save,
  re-verified at save time because the original may have been deleted in between.
- **`markMissing` matches ids, and never judges what it could not see.** Identity
  has no spelling. And a folder the crawl could not open says nothing about what
  is inside it — scoped to that subtree rather than skipping the whole pass,
  because one permanently locked folder at a site would otherwise mean nothing
  anywhere is ever reportable.
- **A rebuild settles duplicate ids before publishing, not during.** Copy a
  package without opening and saving it and two files carry one id; publishing
  both means whichever finishes last wins, differently each run. Keep whichever
  the index already names if that file still exists, else lowest path. Neither
  copy is more legitimate — what matters is that the same rebuild picks the same
  one every time, so a record PDF does not resolve somewhere new after a rescan.
  NOT mtime: the copy sets it. Reported like `unreadable`; the fix is to open the
  other one and save it.
- **The Library learns a package is gone when an open fails, not by statting.**
  `index:search` deliberately never stats — hundreds of round trips per
  keystroke — so the one cheap moment of truth is a failed open. Flag it there.
- **Locks are advisory, live beside the package, and are taken over silently
  when stale.** Beside the package because with local indexes two machines share
  no index at all; the package's own folder is the only place every machine
  agrees on. `'wx'` is `O_EXCL`, which is `CREATE_NEW` on Windows and atomic over
  SMB2, so a race produces exactly one winner. Heartbeat every 30s, stale at 3
  minutes, taken over without a prompt — the crashed holder finds out on its next
  beat that the token changed, drops to read-only and can Save As. Being unable
  to lock (read-only share, no permission) returns `unlocked` and lets work
  continue; it is not a reason to refuse to open. A locked package opens
  read-only: view, print, Save As, no Save. Save As clears read-only and takes
  the lock on the new file, which is the escape hatch when somebody has gone home
  with a package open.
- **The stamp check is what actually protects the work.** `package:read` returns
  `{bytes, stamp}`, the renderer carries it, `dialog:save` re-stats before
  overwriting a path it was already bound to and returns `conflict` rather than
  writing. Size AND mtime, because two saves inside one tick look identical
  otherwise. Only when overwriting a bound path — a path just picked in the Save
  dialog has had its own overwrite prompt and that answer stands. The conflict
  prompt spreads Overwrite away from the other two, like `Don't Save` on close.

---

**Menus.** File / Edit / View. History lives under **View** — it is read-only,
and the Edit menu is for things that change the package.

## 5. Tools

- `tools/check.sh` — run after every edit. Module-mode parse, duplicate
  declarations, id cross-reference, IPC balance, `window.api` surface, unused
  CSS, duplicate selectors, byte-spread scan, schema version.
- `tools/cssaudit.js` — used by the above; separate because its regexes do not
  survive a shell heredoc. Reports classes never applied, and selectors defined
  more than once — the second is what a name collision looks like. One standing
  hit, `.sh-card` at two places, which looks deliberate; a permanent entry is
  how a check starts getting ignored, so merge it or expect it.
- **DOM-level checks are worth the trouble for rail and pane work.** A
  throwaway `npm i jsdom` (NOT a dependency — remove it from package.json
  afterwards, it will add itself) plus `new JSDOM(index.html)` and the function
  under test lifted out of renderer.js with `new Function` lets the markup and
  the logic be checked against each other rather than separately. That is what
  caught the rail-mode transitions and every id the new Inspect pane reaches for.
- `tools/handlers.js` — also used by the above. Flags an `$('id').onX =` binding
  that a later `querySelectorAll('.cls')` loop overwrites.

## 6. Assets

`assets/symbols.json` — the symbol table: `{key, slot, unicode, label}` per row,
in three groups (`common`, `gdt`, `modifiers`). `renderer.js` imports it as a
JSON module. `slot` is the only column the font swap touches; see `FONT-SLOTS.md`
for the codepoint assignment.

`xlsx-append.js` — main-process worksheet appender. Zip surgery, `fflate` only.
See `EXPORT-FORMAT.md` for what goes in the sheets.

`assets/methods.json` — Method column auto-complete: `{ methods: [string] }`,
shown in file order when the list opens empty. Hand-edited until Edit >
Methods... exists. Unicode like everything else, never font slots.

`assets/logo.svg` (balloon + dimension line, current mark), `logo-mark.svg`
(icon size), `logo-b.svg` (B monogram), `logo-list.svg` (characteristic list),
`bu-b/c/d.svg` (Bu+ wordmark directions), `assets/concepts/` (early sketches).
Drop in `Verisurf.ttf` and `logo.png` for the in-house build.
