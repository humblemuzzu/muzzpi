"""Text -> SVG outlines from a font file (woff2/ttf/otf), with GPOS pair kerning.

Usage: python3 render_font.py jobs.json OUT_DIR
jobs.json: [{"name","text","font":"/abs/x.woff2","size","tracking"(em),"lineHeight","color"}]
Prints [{"name","w","h"}] for exact layout widths.
"""
import json
import os
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

_cache = {}


def _kern_table(font):
    kern = {}
    if "GPOS" not in font:
        return kern
    gpos = font["GPOS"].table
    lookups = set()
    for fr in gpos.FeatureList.FeatureRecord:
        if fr.FeatureTag == "kern":
            lookups.update(fr.Feature.LookupListIndex)
    for li in lookups:
        lookup = gpos.LookupList.Lookup[li]
        if lookup.LookupType not in (2, 9):
            continue
        for st in lookup.SubTable:
            if lookup.LookupType == 9:
                st = st.ExtSubTable
            if st.Format == 1:
                for i, first in enumerate(st.Coverage.glyphs):
                    for pvr in st.PairSet[i].PairValueRecord:
                        v = getattr(pvr.Value1, "XAdvance", 0) if pvr.Value1 else 0
                        if v:
                            kern.setdefault((first, pvr.SecondGlyph), v)
            elif st.Format == 2:
                cd1 = st.ClassDef1.classDefs
                seconds = {}
                for g, c in st.ClassDef2.classDefs.items():
                    seconds.setdefault(c, []).append(g)
                for first in st.Coverage.glyphs:
                    rec = st.Class1Record[cd1.get(first, 0)]
                    for c2, r2 in enumerate(rec.Class2Record):
                        v = getattr(r2.Value1, "XAdvance", 0) if r2.Value1 else 0
                        if v:
                            for second in seconds.get(c2, []):
                                kern.setdefault((first, second), v)
    return kern


def _load(path):
    if path not in _cache:
        font = TTFont(path)
        _cache[path] = (font, _kern_table(font))
    return _cache[path]


def render(job, out_dir):
    font, kern = _load(job["font"])
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    upm = font["head"].unitsPerEm
    size = job["size"]
    scale = size / upm
    tracking = job.get("tracking", 0) * upm
    asc, desc = font["hhea"].ascent, -font["hhea"].descent
    lh = job.get("lineHeight", size * 1.15)
    baseline = (lh - (asc + desc) * scale) / 2 + asc * scale
    x, prev, paths = 0.0, None, []
    for ch in job["text"]:
        name = cmap.get(ord(ch)) or cmap.get(ord("?"))
        if prev is not None:
            x += kern.get((prev, name), 0)
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x * scale, baseline)))
        if pen.getCommands():
            paths.append(pen.getCommands())
        x += glyphs[name].width + tracking
        prev = name
    w = max(1, round((x - tracking) * scale + 1, 1))
    h = round(lh, 1)
    color = job.get("color", "#000000")
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
        f'<path fill="{color}" d="{" ".join(paths)}"/></svg>'
    )
    with open(os.path.join(out_dir, job["name"] + ".svg"), "w") as f:
        f.write(svg)
    return {"name": job["name"], "w": w, "h": h}


if __name__ == "__main__":
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    print(json.dumps([render(j, out) for j in json.load(open(sys.argv[1]))]))
