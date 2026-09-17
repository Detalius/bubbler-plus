# Where to put the GD&T glyphs

## The short answer: use the real Unicode codepoints

Don't hunt for unused ASCII. Every symbol below has a genuine Unicode codepoint,
and those codepoints are already what Bubbler+ stores — they are the `unicode`
column of `assets/symbols.json`, and have been since the app was written.

Verisurf puts its glyphs in Latin-1 slots (`±` at `]`, `°` at `ä`), which is why
`toFont()` exists at all: a translation layer between what's stored and what a
badly-mapped font can render. Put your glyphs at their real codepoints and:

- `` `~!@#$%^&*(){} `` stay typable, because nothing lives there any more;
- `slot === unicode` for every row, so `toFont()` and `toUni()` become identity
  functions and the whole translation layer costs nothing;
- text copied out of Bubbler+ pastes correctly into Word, email, or a PDF reader
  with any font that has the glyph;
- Liberation Sans's own alphanumerics keep their normal codepoints, so nothing
  you inherited has to move.

When the font is done, set every `"slot"` in `symbols.json` equal to its
`"unicode"`. That is the entire integration.

---

## The 14 you have drawn

These are the characteristic symbols, currently parked in `` `~!@#$%^&*(){} ``.
Move each to the codepoint in the middle column.

| Symbol | Codepoint | Unicode name | `key` in symbols.json |
|---|---|---|---|
| ⌖ Position | `U+2316` | POSITION INDICATOR | `position` |
| ⊥ Perpendicularity | `U+27C2` | PERPENDICULAR | `perpendicularity` |
| ∠ Angularity | `U+2220` | ANGLE | `angularity` |
| ∥ Parallelism | `U+2225` | PARALLEL TO | `parallelism` |
| ⏤ Straightness | `U+23E4` | STRAIGHTNESS | `straightness` |
| ⏥ Flatness | `U+23E5` | FLATNESS | `flatness` |
| ○ Circularity | `U+25CB` | WHITE CIRCLE | `circularity` |
| ⌭ Cylindricity | `U+232D` | CYLINDRICITY | `cylindricity` |
| ⌒ Profile of a line | `U+2312` | ARC | `profileLine` |
| ⌓ Profile of a surface | `U+2313` | SEGMENT | `profileSurface` |
| ↗ Circular runout | `U+2197` | NORTH EAST ARROW | `runoutCircular` |
| ⌰ Total runout | `U+2330` | TOTAL RUNOUT | `runoutTotal` |
| ◎ Concentricity | `U+25CE` | BULLSEYE | `concentricity` |
| ⌯ Symmetry | `U+232F` | SYMMETRY | `symmetry` |

Six of these (`STRAIGHTNESS`, `FLATNESS`, `CYLINDRICITY`, `TOTAL RUNOUT`,
`SYMMETRY`, `POSITION INDICATOR`) were encoded *specifically* for GD&T, so the
names are not coincidental. Circular runout, circularity and concentricity are
the three that have no dedicated codepoint and use the long-standing substitutes
above; that is what every CAD font does.

---

## The 17 still to draw

**Modifiers** — circled capitals. Note these are *not* the same shape as the
enclosed alphanumerics you may inherit from a fallback: GD&T wants a circle at
roughly cap height with a stroke matching the frame, not a small letter in a
thin ring. Draw them rather than borrowing.

| Symbol | Codepoint | Meaning | `key` |
|---|---|---|---|
| Ⓜ | `U+24C2` | Maximum material condition | `MMC` |
| Ⓛ | `U+24C1` | Least material condition | `LMC` |
| Ⓟ | `U+24C5` | Projected tolerance zone | `PROJECTED` |
| Ⓕ | `U+24BB` | Free state | `FREESTATE` |
| Ⓣ | `U+24C9` | Tangent plane | `TANGENT` |
| Ⓤ | `U+24CA` | Unequally disposed profile | `UNEQUAL` |
| Ⓢ | `U+24C8` | Statistical tolerance | `STATISTICAL` |

**Common callout symbols** — these appear in free-text dimensions, not just in
feature control frames, so they carry more of the typing load than the
characteristics do.

| Symbol | Codepoint | Meaning | `key` |
|---|---|---|---|
| ⌀ | `U+2300` | Diameter | `diameter` / `DIAMETER` |
| ± | `U+00B1` | Plus / minus | `plusMinus` |
| ° | `U+00B0` | Degree | `degree` |
| ↧ | `U+21A7` | Depth | `depth` |
| ⌵ | `U+2335` | Countersink | `countersink` |
| ⌴ | `U+2334` | Counterbore / spotface | `counterbore` |
| √ | `U+221A` | Surface finish | `surfaceFinish` |
| □ | `U+25A1` | Square | `square` |
| ⏜ | `U+23DC` | Arc length | `arcLength` |
| ↔ | `U+2194` | Between | `between` |

`⌀ U+2300` is listed twice in `symbols.json` on purpose — once as a common
symbol, once as the diametral modifier — and the map builder takes the first
definition so the duplicate can't shadow itself. One glyph covers both.

`±`, `°`, `√`, `□`, `↔`, `∠` and `∥` almost certainly already exist in Liberation
Sans. Check before drawing, but expect to redraw anyway: the inherited weights
are set for running text and will look thin beside a feature control frame.

---

## Worth adding while you are in there

Not currently in `symbols.json`. Each is a real codepoint and a one-object edit
to the JSON once the glyph exists — no code change.

| Symbol | Codepoint | Meaning |
|---|---|---|
| ⌱ | `U+2331` | Dimension origin |
| ⌮ | `U+232E` | All around (profile) |
| ⌲ | `U+2332` | Conical taper |
| ⌳ | `U+2333` | Slope |
| Ⓔ | `U+24BA` | Envelope requirement |
| Ⓘ | `U+24BE` | Independency |
| ▷ | `U+25B7` | Translation modifier |
| ▲ / △ | `U+25B2` / `U+25B3` | Datum feature triangle, filled / open |
| ′ ″ | `U+2032` / `U+2033` | Arc minute / second |

## The handful with no codepoint

Surface-texture variants (material removal required, material removal
prohibited), "all over", and the `⟨CF⟩` continuous-feature bracket have no
Unicode assignment. Put those in the Private Use Area starting at `U+E000`, in
the order you draw them, and record what each one is in `symbols.json` — the PUA
is the one place where the file is the only documentation that will ever exist.

---

## Practical notes

- **Advance widths.** Frame symbols should share one width so a stack of feature
  control frames lines up in the sheet tables. The sheet cells are laid out from
  `GEOM`, not measured, so a wide glyph overflows rather than reflows.
- **Baseline.** Everything in the app is anchored on the alphabetic baseline on
  both the canvas and the PDF side. Symbols that read as centred on the line
  (`⌀`, `±`, the circled modifiers) still need to sit on that baseline, not be
  vertically centred in the em box.
- **Don't subset away the Latin range.** `renderSpec()` produces mixed strings
  like `⌀.500 ± .005`; the whole callout renders in one face, so the font needs
  digits, letters and punctuation. That is why starting from Liberation Sans is
  the right call.
- **Licensing.** The point of the exercise: Liberation is SIL OFL, so a derived
  face can ship with the app. Verisurf.ttf cannot. Once the new face is in,
  `Verisurf.ttf` comes out of `assets/` and out of `symbols.json`'s `font` block.
