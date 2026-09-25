# Bubbler+ Excel export format

**Status: frozen.** Everything below is a published interface. Consumers hard-code
positions against it, so it does not change. See *Amendment rule*.

Bubbler+ appends worksheets to a workbook of the user's choosing and stops there.
It does not format, does not touch existing sheets, and has no opinion about what
happens next. Three known consumers, all valid:

1. Hand-format the appended sheet directly and use it as-is.
2. Point formulas at it from an existing form and leave it in place.
3. Bake it into a form with a macro, then delete it.

None of them require anything from Bubbler+ beyond the export being identical
every time.

---

## 1. Sheets

One appended sheet per exported inspection sheet, named for the sheet in
Bubbler+. No suffix, no decoration.

- Excel caps sheet names at 31 characters; longer names are truncated.
- `: \ / ? * [ ]` are illegal in sheet names and are stripped. Leading and
  trailing apostrophes are stripped. An empty result becomes `Sheet`.
- **Collisions take a suffix, never a replacement.** If the name is already in
  use — by a previous export or by a form sheet that happens to share it — the
  new sheet becomes `Name (2)`, then `Name (3)`, and so on, with the base
  trimmed so the whole thing still fits in 31. Older data is never deleted to
  make room for newer data, and the workbook is never silently rewritten.

Nothing else in the workbook is read, written, or inspected.

### Identifying an export sheet

Because there is no name suffix, the marker is `A1 = AppVersion&Schema`. A
consumer that wants to find export sheets tests that cell, not the sheet name.

This is the more robust test anyway: a name pattern breaks the moment somebody
renames a tab, and it false-positives on any pre-existing sheet that happens to
match. `A1` survives renaming, survives reordering, and cannot collide by
accident.

## 2. Layout

Row 1 is headers. Row 2 onward is data.

| Column | Contents |
|---|---|
| **A** | Provenance. `A1` = `AppVersion&Schema`, `A2` = `<app version> <schema version>`, e.g. `0.1.0 0.35.0`. One cell, nothing below it. |
| **B** | Reserved. Always empty, header and all. Wiggle room; do not use. |
| **C onward** | Data, one dataset per column. |

Columns are **ragged by design**. A dataset of one value occupies row 2 only; a
dataset of 186 values runs to row 187. Column length is a property of the
dataset, not of the sheet. Consumers size their work off whichever column they
care about, and the header row says which is which.

Empty values are written as empty strings, never as skipped cells. A blank
Method on row 40 still writes an empty cell at row 40, so positions never shift
on sparse data.

## 3. Columns

Frozen order. `[1]` = single-value, `[n]` = one row per characteristic row.

| Col | Header | Kind | Source |
|---|---|---|---|
| C | `PartNumber` | [1] | `part.number` |
| D | `PartRevision` | [1] | `part.revision` |
| E | `PartName` | [1] | `part.name` |
| F | `CustomerName` | [1] | `part.customer.name` |
| G | `CustomerPartNumber` | [1] | `part.customer.partNumber` |
| H | `Material` | [1] | `part.material` |
| I | `Finish` | [1] | `part.finish` |
| J | `PackageId` | [1] | `package.id` |
| K | `DrawingSetHash` | [1] | `package.drawingSetHash` |
| L | `SheetName` | [1] | `inspectionSheets[].name` |
| M | `Stage` | [1] | `inspectionSheets[].stage` |
| N | `Units` | [1] | `in` or `mm` — the sheet's own unit selection |
| O | `Orientation` | [1] | `portrait` or `landscape` |
| P | `RowType` | [n] | `characteristic` or `header` |
| Q | `Number` | [n] | Bubble number. **Subs inherit the parent's number.** |
| R | `IsSub` | [n] | `TRUE` / `FALSE` |
| S | `Spec` | [n] | `renderSpec()` output, in the sheet's units |
| T | `Method` | [n] | Resolved: override first, else the characteristic's |
| U | `Notes` | [n] | Characteristic notes |
| V | `HeaderText` | [n] | Text of a `header` row; empty on characteristic rows |
| W | `DrawingLabel` | [n] | Which drawing the bubble sits on |
| X | `DrawingPage` | [n] | 1-based PDF page within that drawing |

Row-wise columns are all the same length and in sheet order — the order the
rows appear on the form, headers interleaved where the user put them.

### Why `IsSub` exists

Subs inherit the parent number so that no dimension ever sits in Excel without
identification. That solves *identification* but not *distinction*: three rows
numbered `7` could be one characteristic with two subs, and a consumer cannot
tell which is the parent from the number alone. Order implies it — parent first —
but implying is how a convention becomes a bug at 2am. One boolean column costs
nothing and says it outright.

## 4. Typing

**Every cell is written as text.** No exceptions, including dates.

This is not stylistic. Excel silently reinterprets exactly the strings this app
produces: `1/4-20` and `1-2` become dates, `.250` becomes `0.25`, and anything
opening with `=`, `+`, or `-` is parsed as a formula. A thread callout corrupted
on export cannot be recovered downstream, because the original is gone.

The guarantee is **inline strings** (`t="inlineStr"`). A string in the file is a
string on load: Excel does not re-parse it, so no number format is needed and
`xl/styles.xml` is never touched. Inline also means `sharedStrings.xml` is never
touched — one fewer shared part that a bad write could corrupt.

The one residual case: if a user clicks into a dumped cell and presses Enter,
General format will re-parse what they committed. That is a property of the cell
they just edited, not of the export, and the sheet is a transfer artifact rather
than something to edit in place.

Dates are written as ISO 8601 (`2026-08-28`). Real date typing is a *bake-time*
concern: a consumer macro converts on the way into its own form, where the
target cell's format is already whatever that form wants. The `_TEXT` sheet is
named for what it holds.

GD&T is written as real Unicode codepoints, matching manifest storage — never
font slots. Rendering them requires the symbol font installed on the machine
opening the workbook; that is a deployment problem, not a format problem, and
the format does not try to work around it.

## 5. Amendment rule

**Columns are append-only, forever.** Never reorder, never remove, never
repurpose.

A new dataset gets a new column at the far right end. If a dataset changes shape
enough that its old consumers would misread it, it is **not the same dataset**:
it gets a new column and a new header, and the old column keeps emitting what it
always did or goes silent. It does not get redefined in place.

New columns land at the right end regardless of kind, so the single-value and
row-wise blocks will not stay contiguous over time. That is expected. The header
row is authoritative for which is which.

Anything that cannot be expressed under this rule is a major version, at which
point it is a different application and a different format.

---

## Open: sheets vs. records

This spec covers **inspection sheets** — the authored form, spec and method, no
measurements. The manifest also carries **inspections**: filled records with
`bands[].columns[]` of measured values, plus the initials of the record-maker, the
date of the recording, and the OP being measured, as well as `jobNumber`, `machine`,
`author`, `editDate`, and `gageId`.

Exporting those is a strictly additive change under the amendment rule above — new 
columns at the right end — but the measured values are two-dimensional (band × column)
and do not fit one-dataset-one-column without a flattening convention. Worth deciding
before the first export ships, since whatever ships first is frozen.
