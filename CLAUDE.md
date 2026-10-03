# Bubbler+

An Electron app for bubbling engineering drawings and producing inspection
paperwork. A package (`.insp`) is a zip holding `manifest.json`, the drawing
PDFs, and copies of the sheet templates it uses. See `README.md` for the user's
view, `TEMPLATE-FORMAT.md` and `EXPORT-FORMAT.md` for the two published formats.

If `MEMORY.md` and `PLAN.md` exist in the repo root, read `MEMORY.md` first
(how this project is worked on), then `PLAN.md` §3 (traps that have already
caused a bug once) and §7 (the template work in progress) before changing
code. Both are private and gitignored.

## Layout

| File | Role |
|---|---|
| `main.js` | Main process: menus, file dialogs, config, the share index and crawl, locks, printing, updates. **CRLF line endings — keep them.** |
| `preload.js` | The `window.api` bridge. Every IPC channel in main has one entry here. |
| `renderer.js` | The workspace (~7.2k lines), an ES module. Sections are marked by `// ----` banners; declarations sit at the top of their section. |
| `library.js` | The Library (Quick Find, previews, printing). Reads packages, never writes them; borrows rendering through `window.BubblerSheets`. |
| `sheet-template.js` | Pure template logic: validation, bindings, page arithmetic, pagination, hashing, package template storage. Shared by the renderer, the Library and the tests. |
| `sheet-page.js` | `buildPage()` and `printCss()`: one printed page of any form, as HTML. Every preview, PDF and print comes from here, and so does the form editor's preview. |
| `forms.html`, `forms.js` | The form editor, **Bubbler+ Forms**: `Bubbler+.exe --forms` opens this page instead of index.html, so nothing package-shaped (autosave, recovery, locks, updates) runs in it. Its own menu, AppUserModelId and icon (`build/installer.nsh` makes its shortcut). |
| `form-model.js` | Pure: the editor's one-grid model and its two-way map to the template format, the edits, Excel import's layout and the suggestions. |
| `xlsx-read.js` | Pure: reads one worksheet's look (text, merges, sizes, fills, fonts) for the editor's import. The unzip is passed in. |
| `xlsx-append.js` | Appends sheets to a workbook by zip surgery, never by rebuilding it. |
| `index.html` | All markup and all CSS. |
| `assets/templates/` | The eight built-in sheet templates. |
| `tests/` | `node --test` suite. |
| `tools/` | Dev checks: `check.sh` (runs `cssaudit.js` and `handlers.js`), `mockshare.bat` (a fake share for the crawl). `e2e/` is private (gitignored). |

## Commands

```bash
npm start                 # run the app
npm start -- --forms      # run the form editor
npm test                  # unit tests (Node 22+)
bash tools/check.sh       # module-mode parse, duplicate declarations, ids, IPC balance, CSS
node tools/e2e/fixtures.js && python tools/e2e/run.py   # the real app, headless
python tools/e2e/forms.py                                # the form editor, headless
npm run dist              # installer into dist/
```

Run `npm test` and `check.sh` after every change. Run the e2e suite after
anything touching save, open, templates, records or the Library, and
`forms.py` after anything touching the editor, `form-model.js` or `sheet-page.js`.

## Rules that have each prevented a real bug

- `renderer.js` and `library.js` are **modules**: a duplicate top-level name is
  a SyntaxError there but not under `node --check`. `check.sh` parses them as
  modules. Search for a name before adding one (`refOf` and `applyStyle` were
  both already taken).
- A `const` read by code that runs while the module loads must be declared
  above that code. Functions may read anything.
- Never `window.alert/confirm/prompt`: use `dialog()`, `notify()`,
  `confirmAction()`.
- `pushHistory()` snapshots BEFORE a mutation; `markDirty()` runs after.
  Rendering never marks dirty (`syncStage()` repaints, `commitStage()` repaints
  and marks dirty).
- One `uid` counter serves every id family; only New and Open may reset it.
- Opening a package never writes it.
- Stored text is Unicode; `toFont()` only at the point of display.
- Printed sheets are drawn from templates. Print and screen CSS carry structure
  only, never sizes or fills, or the preview and the PDF drift apart.
- Sheets follow the app's built-in templates; records freeze their exact
  template, and packages always carry a copy of it.
- Everything the app writes lives in the per-user data folder (`DATA_DIR`),
  never beside the executable.
- `build.files` in `package.json` is an allowlist: a new top-level source file
  must be added there or the installer won't have it.
- Never `String.fromCharCode(...bytes)` on large arrays.
- Bump `SCHEMA_VERSION` whenever the stored shape changes. Older packages load
  with defaults; newer ones open view-only.

## Editing

- Make targeted edits. Never regenerate a whole file from memory or from an
  older copy.
- Keep a file's existing line endings.
- For a comment-only or move-only change, verify the code is unchanged by
  comparing JS token streams (acorn), not by eye.
- Layout changes to printed sheets are verified by rendering before and after
  in headless Chromium and diffing the pages.

## Comments

Comments describe what code does and WHEN it runs, not its history or the case
for a decision (that belongs in `PLAN.md`).

- Name the triggers for anything called from more than one place.
- A comment is never longer than the code it describes, unless it records a
  fact that prevents a real bug.
- No comment on an obvious declaration; nothing restating the next lines.
- Rename a misleading name rather than explaining it.
- A comment sits directly above what it describes; banners describe what is
  under them.
- Nothing internal or proprietary: no company names, form numbers, vendor font
  names, or pointers into private notes.
