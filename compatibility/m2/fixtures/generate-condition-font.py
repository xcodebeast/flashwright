"""Generate the original zero-advance font used by resident font-load fixtures.

Generation requires fontTools 4.60.1; tests use the retained binary directly.
"""
from pathlib import Path

import fontTools
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

assert fontTools.__version__ == "4.60.1", "Use the recorded generator version"

font = FontBuilder(1000, isTTF=True)
font.setupGlyphOrder([".notdef", "space", "A"])
font.setupCharacterMap({32: "space", 65: "A"})
font.setupGlyf({name: TTGlyphPen(None).glyph() for name in [".notdef", "space", "A"]})
font.setupHorizontalMetrics({".notdef": (500, 0), "space": (250, 0), "A": (0, 0)})
font.setupHorizontalHeader(ascent=800, descent=-200)
font.setupNameTable({
    "familyName": "Flashwright Zero Advance",
    "styleName": "Regular",
    "uniqueFontIdentifier": "FlashwrightZeroAdvance-Regular-1",
    "fullName": "Flashwright Zero Advance Regular",
    "psName": "FlashwrightZeroAdvance-Regular",
    "version": "Version 1.0",
})
font.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
font.setupPost()
font.font["head"].created = font.font["head"].modified = 2082844800
font.font.recalcTimestamp = False
font.save(Path(__file__).with_name("zero-advance.ttf"))
