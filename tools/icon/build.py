"""Build the Bubbler+ app icon: assets/app-icon.svg, assets/app-icon-small.svg,
assets/app-icon.png and build/icon.ico.

Two marks on the same tile as the Forms icon (#2d7dd2, inset 8/256, rx 44):
  large  "Bu" with a balloon on its leader in the superscript slot, where the
         "+" would sit. At 32px and up, the balloon reads.
  small  "Bu+", for 16 and 24px, where the balloon shrinks to a ring and the
         mark starts reading as "Bu°". An .ico carries one image per size, so
         each size gets the mark that survives at it.

The letters are outlines of Liberation Sans Bold 2.1.5 (OFL, Arial-metric),
so the icon never depends on a font being installed. Pass it the
TTF from the liberation-fonts-ttf-2.1.5 release; never the 1.07 copy that
ships in pdfjs-dist (that one is GPL).

    python tools/icon/build.py path/to/LiberationSans-Bold.ttf

Needs fonttools and pymupdf.
"""
import os
import struct
import sys

import pymupdf as fitz
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BLUE = '#2d7dd2'


def text_path(font, text, x, y, size, tracking):
    """SVG path data for `text` set at (x, y) baseline, in 120-unit space."""
    gs, cmap = font.getGlyphSet(), font.getBestCmap()
    upm = font['head'].unitsPerEm
    k = size / upm
    pen = SVGPathPen(gs)
    for ch in text:
        name = cmap[ord(ch)]
        gs[name].draw(TransformPen(pen, (k, 0, 0, -k, x, y)))
        x += gs[name].width * k + tracking
    return pen.getCommands()


def tile(body):
    # Same footprint as assets/forms-icon.svg; the 120-unit marks are scaled
    # onto its 240-unit tile.
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">\n'
            f'  <rect x="8" y="8" width="240" height="240" rx="44" fill="{BLUE}"/>\n'
            f'  <g transform="translate(8 8) scale(2)" fill="#fff">\n{body}  </g>\n</svg>\n')


def marks(font):
    large = tile(
        f'    <path d="{text_path(font, "Bu", 16, 82, 56, -1)}"/>\n'
        '    <g fill="none" stroke="#fff">\n'
        '      <circle cx="97" cy="34" r="13" stroke-width="6"/>\n'
        '      <path d="M97 47v11" stroke-width="5.5" stroke-linecap="round"/>\n'
        '    </g>\n')
    small = tile(
        f'    <path d="{text_path(font, "Bu", 18, 80, 54, -1)}"/>\n'
        '    <path d="M96 30v20M86 40h20" fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/>\n')
    return large, small


def png(svg, px):
    doc = fitz.open(stream=svg.encode(), filetype='svg')
    page = doc[0]
    pix = page.get_pixmap(matrix=fitz.Matrix(px / page.rect.width, px / page.rect.height), alpha=True)
    return pix.tobytes('png')


def ico(frames):
    """PNG-compressed .ico (Vista and later), one entry per (size, png)."""
    head = struct.pack('<HHH', 0, 1, len(frames))
    off = 6 + 16 * len(frames)
    entries, blobs = b'', b''
    for px, data in frames:
        entries += struct.pack('<BBBBHHII', px % 256, px % 256, 0, 0, 1, 32, len(data), off)
        blobs += data
        off += len(data)
    return head + entries + blobs


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    large, small = marks(TTFont(sys.argv[1]))
    with open(os.path.join(ROOT, 'assets', 'app-icon.svg'), 'w', newline='\n') as f:
        f.write(large)
    with open(os.path.join(ROOT, 'assets', 'app-icon-small.svg'), 'w', newline='\n') as f:
        f.write(small)
    with open(os.path.join(ROOT, 'assets', 'app-icon.png'), 'wb') as f:
        f.write(png(large, 256))
    frames = [(px, png(small if px <= 24 else large, px)) for px in (16, 24, 32, 48, 64, 256)]
    with open(os.path.join(ROOT, 'build', 'icon.ico'), 'wb') as f:
        f.write(ico(frames))
    print('wrote assets/app-icon.svg, app-icon-small.svg, app-icon.png, build/icon.ico')


if __name__ == '__main__':
    main()
