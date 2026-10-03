"""Builds assets/SimpleGeoDim.ttf: Liberation Sans with the GD&T symbols.

    pip install fonttools
    python tools/font/build.py

Inputs, both in this folder:
  LiberationSans-Regular.ttf   Liberation Sans 2.1.5, SIL OFL: every letter,
                               digit and Latin character comes from here.
  SimpleGeoDim-symbols.ttf     Jesse's drawings (from FontForge): every symbol
                               in assets/symbols.json is taken from here. Redraw
                               a symbol there, run this, done.

On top of the drawings, two adjustments made here rather than by hand:
  * Round symbols (the circled modifiers, the circles, position) are centred on
    the capitals' optical middle and a touch larger, so they line up with the
    letters around them in a feature control frame.
  * Arc length, which has no drawing, is drawn here: a shallow arc at text
    weight, so it can't be mistaken for profile of a line.

The result is renamed SimpleGeoDim, as the OFL requires of a modified version
("Liberation" is a Reserved Font Name), and keeps the original notices.
"""
import json, math
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.boundsPen import BoundsPen

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
FAMILY = 'SimpleGeoDim'
VERSION = '2.1.5; SimpleGeoDim 1.1'

base = TTFont(HERE / 'LiberationSans-Regular.ttf')
src = TTFont(HERE / 'SimpleGeoDim-symbols.ttf')
symbols = json.loads((REPO / 'assets' / 'symbols.json').read_text(encoding='utf-8'))
codepoints = sorted({ord(s['unicode']) for g in symbols['groups'].values() for s in g})

cap = base['OS/2'].sCapHeight                       # 1409
OVERSHOOT = 20                                      # how far Liberation's O dips
optical_mid = cap / 2                               # the middle of a capital

src_cmap, src_glyphs = src.getBestCmap(), src.getGlyphSet()
base_cmap = base.getBestCmap()
order = base.getGlyphOrder()
glyf, hmtx = base['glyf'], base['hmtx']

def bounds(glyphset, name):
    p = BoundsPen(glyphset)
    glyphset[name].draw(p)
    return p.bounds

def put(name, glyph, advance):
    if name not in order:
        order.append(name)
    glyf[name] = glyph
    glyph.recalcBounds(glyf)
    hmtx[name] = (advance, getattr(glyph, 'xMin', 0))

def map_to(cp, name):
    for t in base['cmap'].tables:
        if t.isUnicode() and (cp <= 0xFFFF or t.format in (12, 13)):
            t.cmap[cp] = name

# Round symbols, recentred on the capitals and grown slightly.
ROUND = {0x24C2, 0x24C1, 0x24C5, 0x24BB, 0x24C9, 0x24CA, 0x24C8,   # circled modifiers
         0x25CB, 0x25CE,                                           # circularity, concentricity
         0x2316}                                                   # position
GROW = 1.04

copied = []
for cp in codepoints:
    if cp not in src_cmap:
        continue                                    # drawn below, or not drawn yet
    sname = src_cmap[cp]
    rec = DecomposingRecordingPen(src_glyphs)
    src_glyphs[sname].draw(rec)
    pen = TTGlyphPen(None)
    if cp in ROUND:
        x0, y0, x1, y1 = bounds(src_glyphs, sname)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        # scale about the glyph's centre, then move that centre to the capitals'
        t = (GROW, 0, 0, GROW, cx - GROW * cx, optical_mid - GROW * cy)
        rec.replay(TransformPen(pen, t))
    else:
        rec.replay(pen)
    name = base_cmap.get(cp) or f'uni{cp:04X}'
    put(name, pen.glyph(), src['hmtx'][sname][0])
    map_to(cp, name)
    copied.append(cp)

# Arc length (U+23DC): a shallow arc over the cap line's upper half, at the
# weight of Liberation's own stems, square-ended.
ARC = 0x23DC
if ARC not in src_cmap:
    stem = 160                                      # Liberation's l is 180 wide
    advance, x_left, x_right = 1139, 150, 989       # a digit's width
    top, sag = cap + 40, 230                        # apex, and how far the ends drop
    chord = x_right - x_left
    r = (chord * chord / 4 + sag * sag) / (2 * sag)
    cx, cy = (x_left + x_right) / 2, top - r
    half = math.asin(chord / 2 / r)
    steps = 32
    def arc(radius, reverse=False):
        pts = []
        for i in range(steps + 1):
            a = math.pi / 2 - half + 2 * half * i / steps
            pts.append((round(cx + radius * math.cos(a)), round(cy + radius * math.sin(a))))
        return pts[::-1] if reverse else pts
    outer, inner = arc(r + stem / 2), arc(r - stem / 2, reverse=True)
    pen = TTGlyphPen(None)
    pen.moveTo(outer[0])
    for p in outer[1:] + inner:
        pen.lineTo(p)
    pen.closePath()
    put('uni23DC', pen.glyph(), advance)
    map_to(ARC, 'uni23DC')

base.setGlyphOrder(order)

# Named SimpleGeoDim; Liberation's notices and licence kept.
for rec in base['name'].names:
    if rec.nameID in (1, 4, 16, 21):
        rec.string = FAMILY
    elif rec.nameID == 6:
        rec.string = FAMILY
    elif rec.nameID == 3:
        rec.string = f'{FAMILY} {VERSION}'
    elif rec.nameID == 5:
        rec.string = f'Version {VERSION}'
    elif rec.nameID == 0:
        rec.string = (str(rec) + ' GD&T symbols by Jesiah Handke, 2026.').strip()

out = REPO / 'assets' / 'SimpleGeoDim.ttf'
base.save(out)
missing = [f'U+{cp:04X}' for cp in codepoints if cp not in copied and cp != ARC]
print(f'{out.name}: {len(copied)} symbols from the drawings'
      + (', arc length drawn' if ARC not in src_cmap else '')
      + (f'; not drawn yet: {" ".join(missing)}' if missing else ''))
