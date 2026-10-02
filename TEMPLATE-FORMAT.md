# Sheet template format

A template describes one printed inspection form: its page, its header, the
table of characteristics and checks below it, and its footer. Bubbler+ draws
every sheet preview, sheet PDF and record PDF from a template, so a shop can
print its own paperwork instead of ours.

Templates are JSON. The built-in forms ship in the same format
(`assets/templates/*.json`), which makes them the best examples to copy from.
A shop's own templates go in the `templates` folder inside the data folder
(`%APPDATA%\Bubbler+\templates`); each is checked when Bubbler+ starts, and
one that fails is left out, with the reason reported.

A package carries a copy of every non-built-in template its sheets and records
use, in a `templates/` folder inside the `.insp`, so it prints the same on a
machine that doesn't have the template. Each copy is named for its content
hash, and sheets and records store `{ "id": ..., "hash": ... }`: a package
always prints on the exact version it was saved with, even after the shop
edits its template. When neither the package nor the machine has that version,
the template with the same `id` is used, then the built-in form.

## Conventions

- **Lengths are inches.** Font sizes are points.
- **One template is one page layout.** Portrait and landscape versions of a form
  are two templates.
- **Cells are addressed `[row, column]`, counting from 0**, and sized in whole
  rows and columns, like a spreadsheet.
- **Unknown keys are ignored**, so a newer template still opens in an older
  build (it may just look plainer).

## Top level

| Key | Required | Meaning |
|---|---|---|
| `formatVersion` | yes | `1`. Raised only for a change older builds would misread. |
| `id` | yes | Unique, lowercase letters, digits and `-`. Sheets store it. A shop template can't reuse a built-in's id. |
| `name` | yes | Shown in the template picker. |
| `stage` | no | The word written to the Excel export's Stage column, such as `in-process` or `first-article`. |
| `page` | yes | Page size and margins. |
| `font` | no | Default font for every cell. |
| `styles` | no | Named looks that cells refer to. |
| `fields` | no | The values this form asks for. |
| `header` | yes | The title block, as a grid. |
| `body` | yes | The table of characteristics and checks. |
| `footer` | no | Text placed at the bottom of every page. |

## `page`

```json
"page": { "size": [11, 8.5], "marginTop": 0.2565, "marginBottom": 0.5 }
```

`size` is `[width, height]`. The header and body are centred horizontally; their
width comes from their columns. `marginBottom` is the space kept clear at the
bottom of the page, where the footer sits.

## `font` and `styles`

```json
"font": { "family": "Arial", "size": 8.3 },
"styles": {
  "label":   { "fill": "#d9d9d9", "size": 7.3, "wrap": false },
  "callout": { "align": "center", "font": "symbol" }
}
```

A style may set:

| Key | Meaning |
|---|---|
| `fill` | Background colour, `#rrggbb`. |
| `size` | Font size in points. |
| `bold`, `italic` | `true` or `false`. |
| `align` | `left` (default), `center` or `right`. |
| `wrap` | `false` keeps text on one line. |
| `font` | `symbol` uses the GD&T symbol font; anything else is a font family name. |

Anything a style doesn't set comes from `font`. A cell or column names one style
with `"style": "label"`; an unknown style name is an error.

## `fields`

The values a form asks the user for, beyond what Bubbler+ already knows. Each
one becomes an input box: `sheet.*` fields on the Sheets page, `record.*`
fields on the Inspect page.

```json
"fields": [
  { "key": "record.jobNumber", "label": "Job Number" },
  { "key": "record.due_date",  "label": "Due Date" }
]
```

`key` is `sheet.` or `record.` followed by a name. A name that isn't built in
(see below) is a custom field: lowercase letters, digits and `_`, starting with
a letter. `label` is what the input box is called. Values are plain text.

Custom values are stored on the sheet or record under `custom`, never beside
Bubbler+'s own properties. A new record takes a frozen copy of the sheet's
values for the `sheet.` fields its form declares; editing the sheet later
doesn't change it.

## Bindings

Anywhere a template says `"bind"`, or writes `{...}` inside `text`, it names a
value:

| Binding | Value |
|---|---|
| `part.customer`, `part.number`, `part.name`, `part.revision`, `part.customerPartNumber`, `part.material`, `part.finish` | From Edit > Drawing Info. |
| `sheet.name`, `sheet.units` | The sheet's name and unit set (`in` or `mm`). |
| `sheet.author`, `sheet.editDate` | From the Sheets page; fall back to the package's author and edit date. |
| `record.jobNumber`, `record.machine` | From the Inspect page. Blank when printing a sheet rather than a record. |
| `sheet.<custom>`, `record.<custom>` | A custom field declared in `fields`. |
| `page.number`, `page.count` | Footer only. |

`part.*`, `page.*`, `sheet.name` and `sheet.units` are always available. Every
other `sheet.*` or `record.*` binding must be declared in `fields`, so a typo is
caught when the template loads rather than printing an empty box.

## `header`

A grid of cells, like a merged range of spreadsheet cells.

```json
"header": {
  "columns": [2.5666, 1.0843, 3.0988, 0.7202, 2.8808],
  "rows":    [0.2171, 0.2035, 0.2028, 0.2042, 0.2035],
  "cells": [
    { "at": [0, 0], "span": [5, 1], "logo": true },
    { "at": [0, 1], "span": [1, 4], "text": "In-Process Inspection (IPI)", "style": "title" },
    { "at": [1, 1], "text": "Customer", "style": "label" },
    { "at": [1, 2], "bind": "part.customer", "style": "value" }
  ]
}
```

`columns` are widths and `rows` are heights. Each cell has:

| Key | Meaning |
|---|---|
| `at` | `[row, column]` of its top-left corner. |
| `span` | `[rows, columns]` it covers. Default `[1, 1]`. |
| `text` | Literal text; `{binding}` placeholders are filled in. |
| `bind` | Shorthand for `"text": "{binding}"`. |
| `logo` | `true` draws the shop logo, scaled to fit. |
| `style` | A name from `styles`. |

A cell has at most one of `text`, `bind` and `logo`. Positions no cell covers
are drawn as empty cells.

**A header is rejected if** two cells overlap, a cell reaches past the last row
or column, or a cell names a missing style or an undeclared binding. The message
names the cell's `at`.

## `body`

The table below the header. It is a *pattern*: its columns are described once,
and one row is drawn per characteristic, as many as the sheet has.

```json
"body": {
  "axis": "rows",
  "rowHeight": 0.2167,
  "labelRowHeight": 0.1683,
  "bands": "fill",
  "headingStyle": "heading",
  "sectionStyle": "section",
  "columns": [
    { "width": 0.2481, "heading": "Dimension / Specification", "headingSpan": 2,
      "bind": "number", "style": "centered" },
    { "width": 2.3185, "bind": "spec", "style": "callout" },
    { "width": 1.0843, "heading": "Method", "bind": "method", "style": "centered" },
    { "width": 0.9382, "heading": "Gage ID", "bind": "gage", "style": "centered" },
    { "repeat": 8, "width": 0.7202, "labelWidth": 0.290081,
      "labels": ["Date:", "Initials:", "OP#:"], "bind": "check",
      "style": "centered", "labelStyle": "checkLabel", "headStyle": "checkValue" }
  ]
}
```

| Key | Meaning |
|---|---|
| `axis` | `rows`: one row per characteristic, checks across. The only value in version 1; `columns` (characteristics across, checks down) is reserved. |
| `rowHeight` | Height of each characteristic row. |
| `labelRowHeight` | Height of each check-label row in the heading block. |
| `bands` | `1`, or `"fill"`: repeat the heading block and rows below each other as many times as fit, each repeat adding a fresh set of check columns. Only used when the whole sheet fits on one page. |
| `headingStyle` | Style of the column headings. |
| `sectionStyle` | Style of section header rows (the headers placed on the Sheets page), which span the full width. |
| `columns` | Left to right. |

**The heading block** is as tall as the check columns have labels
(`labels.length × labelRowHeight`). Each ordinary column's `heading` fills its
whole height; `headingSpan` lets one heading cover that many columns, starting
with its own.

**A column** has a `width`, a `bind` and optionally a `heading` and `style`:

| `bind` | Value |
|---|---|
| `number` | The balloon number. Spans the rows of its sub-dimensions. |
| `spec` | The rendered callout, in the sheet's units. |
| `method` | The inspection method. |
| `gage` | The gage ID entered for this band. |
| `notes` | The characteristic's notes. |
| `check` | Only on a `repeat` column: the reading entered in that check. |

**The check column** is the one with `repeat`: it is drawn `repeat` times. Its
heading is a stack of `labels`, one row each, with a box beside each label
(`labelWidth` wide within the column) holding that check's date, initials and
so on. `labelStyle` and `headStyle` style the two. `repeat: 1` gives a single
wide check column, as on a first article form.

**Rows per page** are worked out, not stated: the page height, less both
margins, the header and the heading block, divided by `rowHeight`, rounded down.
A characteristic and its sub-dimensions are never split across pages.

## `footer`

```json
"footer": [
  { "text": "Page {page.number} of {page.count}", "align": "left",
    "bottom": 0.13, "size": 7.6 }
]
```

Each item is a line of text, positioned `bottom` inches above the page edge and
aligned across the width of the body. `size` and `style` are optional.

## Validation

A template that fails any rule above is not loaded, and the error names the
template and the offending part. A template is never silently repaired: a form
that prints wrong is worse than one that refuses to print.

## Reserved for later

These are planned and will not break version 1 templates:

- `axis: "columns"`, for forms with characteristics across the page.
- Tolerance bindings (`tol.upper`, `tol.lower` and so on) once tolerances are
  stored separately from the dimension.
- Custom per-characteristic columns.
- Importing a template's shape from an Excel workbook.
