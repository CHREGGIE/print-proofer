#!/usr/bin/env python3
"""
Colour palette extractor for print. No account, no internet.

    python palette.py logo.png                 # the main colours, with HEX / RGB / CMYK
    python palette.py flyer.jpg -n 8           # up to 8 colours
    python palette.py flyer.jpg --html out.html   # a swatch sheet you can open or print
    python palette.py flyer.jpg --json         # machine-readable

For each colour it prints how much of the image it covers, a plain-English name, and print
notes: bright screen colours that will look duller in CMYK, and near-blacks that should be
printed as a rich black.

Setup (once):  pip install pillow
"""
import argparse
import colorsys
import html
import json
import math
import random
import sys

# ---------------------------------------------------------------- colour maths


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgb_to_lab(rgb):
    r, g, b = (srgb_to_linear(v / 255) for v in rgb)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116

    fx, fy, fz = f(x), f(y), f(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def lab_to_rgb(lab):
    L, a, b = lab
    fy = (L + 16) / 116
    fx, fz = fy + a / 500, fy - b / 200

    def finv(t):
        return t ** 3 if t ** 3 > 0.008856 else (t - 16 / 116) / 7.787

    x, y, z = finv(fx) * 0.95047, finv(fy), finv(fz) * 1.08883
    r = 3.2406 * x - 1.5372 * y - 0.4986 * z
    g = -0.9689 * x + 1.8758 * y + 0.0415 * z
    bl = 0.0557 * x - 0.2040 * y + 1.0570 * z

    def enc(c):
        c = max(0.0, min(1.0, c))
        c = 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
        return round(c * 255)

    return (enc(r), enc(g), enc(bl))


def delta_e(l1, l2) -> float:
    return math.dist(l1, l2)


def to_cmyk(rgb):
    """Simple RGB→CMYK (no ICC profile): a starting point for the printer, not a proof."""
    r, g, b = (v / 255 for v in rgb)
    k = 1 - max(r, g, b)
    if k >= 0.999:
        return (0, 0, 0, 100)
    c, m, y = ((1 - v - k) / (1 - k) for v in (r, g, b))
    return tuple(round(v * 100) for v in (c, m, y, k))


HUES = [(15, "red"), (40, "orange"), (65, "yellow"), (90, "lime"), (150, "green"), (185, "teal"),
        (205, "cyan"), (250, "blue"), (280, "violet"), (320, "purple"), (345, "pink"), (360, "red")]


def colour_name(rgb) -> str:
    h, l, s = colorsys.rgb_to_hls(*(v / 255 for v in rgb))
    if l > 0.94:
        return "white"
    if l < 0.08:
        return "black"
    if s < 0.12:
        return "light grey" if l > 0.7 else "dark grey" if l < 0.3 else "grey"
    if l > 0.86 and s < 0.5:
        return "off-white"
    hue = next(name for limit, name in HUES if h * 360 < limit)
    if hue == "orange" and l < 0.4:
        hue = "brown"
    tone = "dark " if l < 0.3 else "pale " if l > 0.78 else ""
    vivid = "vivid " if s > 0.75 and 0.35 < l < 0.65 else "muted " if s < 0.35 else ""
    return f"{tone}{vivid}{hue}".strip()


def print_notes(rgb):
    """Plain-language warnings for colours that behave differently on paper."""
    notes = []
    h, s, v = colorsys.rgb_to_hsv(*(x / 255 for x in rgb))
    hue = h * 360
    # Bright, saturated screen colours outside the usual CMYK range: RGB greens, blues,
    # oranges and purples at full strength print noticeably duller.
    if s > 0.8 and v > 0.8 and (90 <= hue <= 160 or 200 <= hue <= 300 or 20 <= hue <= 45):
        notes.append("Bright screen colour: will print duller in CMYK. Ask for a proof or a spot colour.")
    if v < 0.15:
        notes.append("Near black: for big areas use rich black (C60 M40 Y40 K100); keep small text 100% K.")
    if s < 0.08 and 0.15 <= v < 0.9:
        notes.append("Grey: print it with K only so it stays neutral.")
    return notes


# ---------------------------------------------------------------- extraction


def load_pixels(path: str, max_side: int = 320, keep_background: bool = True):
    """Returns (pixels, background colour or None)."""
    try:
        from PIL import Image, ImageOps
    except ImportError:
        sys.exit("Missing package. Run: pip install pillow")
    img = ImageOps.exif_transpose(Image.open(path)).convert("RGBA")
    img.thumbnail((max_side, max_side))
    data = img.get_flattened_data() if hasattr(img, "get_flattened_data") else img.getdata()
    px = [p[:3] for p in data if p[3] > 128]  # skip transparent pixels
    bg = None
    if not keep_background:
        # Drop the colour that fills the outer edge (usually the paper or the backdrop).
        w, h = img.size
        edge = [img.getpixel((x, y))[:3] for x in range(w) for y in (0, h - 1)] + \
               [img.getpixel((x, y))[:3] for y in range(h) for x in (0, w - 1)]
        bg = max(set(edge), key=edge.count)
        bg_lab = rgb_to_lab(bg)
        px = [p for p in px if delta_e(rgb_to_lab(p), bg_lab) > 12] or px
    # A fixed-seed sample keeps big images fast and results repeatable.
    if len(px) > 9000:
        px = random.Random(1).sample(px, 9000)
    return px, bg


def kmeans(labs, k: int, iterations: int = 12, seed: int = 7):
    """k-means++ in Lab space, so 'close' means close to the eye."""
    rnd = random.Random(seed)
    centres = [rnd.choice(labs)]
    while len(centres) < k:
        d2 = [min(delta_e(p, c) ** 2 for c in centres) for p in labs]
        total = sum(d2)
        if total == 0:
            break
        r, acc = rnd.random() * total, 0.0
        for p, d in zip(labs, d2):
            acc += d
            if acc >= r:
                centres.append(p)
                break
    for _ in range(iterations):
        groups = [[] for _ in centres]
        for p in labs:
            groups[min(range(len(centres)), key=lambda i: delta_e(p, centres[i]))].append(p)
        new = [tuple(sum(v) / len(g) for v in zip(*g)) if g else centres[i] for i, g in enumerate(groups)]
        if all(delta_e(a, b) < 0.5 for a, b in zip(new, centres)):
            centres = new
            break
        centres = new
    counts = [0] * len(centres)
    for p in labs:
        counts[min(range(len(centres)), key=lambda i: delta_e(p, centres[i]))] += 1
    return list(zip(centres, counts))


def _dist_to_segment(p, a, b) -> float:
    ab = [y - x for x, y in zip(a, b)]
    ap = [y - x for x, y in zip(a, p)]
    denom = sum(v * v for v in ab) or 1e-9
    t = max(0.0, min(1.0, sum(x * y for x, y in zip(ap, ab)) / denom))
    return math.dist(p, [x + t * v for x, v in zip(a, ab)])


def is_edge_blend(m, all_colours, total, anchors=()) -> bool:
    """A small colour sitting between two bigger ones is usually the soft edge where they meet
    (anti-aliasing, JPEG blur, thin text). Checked in Lab and in screen RGB, where blurs happen."""
    share = m["count"] / total
    if share >= 0.15:
        return False
    rgb = lab_to_rgb(m["lab"])
    others = [o for o in all_colours if o is not m]
    # Exactly on the straight RGB line between two other colours: a blend at almost any size
    # (anti-aliased text makes a lot of these).
    ends = [o["lab"] for o in others] + list(anchors)
    for i, a in enumerate(ends):
        for b in ends[i + 1:]:
            if _dist_to_segment(rgb, lab_to_rgb(a), lab_to_rgb(b)) < 8:
                return True
    if share >= 0.04:
        return False
    # Small and roughly between two much bigger colours: also a blend.
    big = [o["lab"] for o in others if o["count"] > 2 * m["count"]] + list(anchors)
    for i, a in enumerate(big):
        for b in big[i + 1:]:
            if _dist_to_segment(m["lab"], a, b) < 7 or _dist_to_segment(rgb, lab_to_rgb(a), lab_to_rgb(b)) < 22:
                return True
    return False


def extract(path: str, n: int = 6, keep_background: bool = True):
    px, bg = load_pixels(path, keep_background=keep_background)
    if not px:
        return []
    labs = [rgb_to_lab(p) for p in px]
    clusters = kmeans(labs, min(n + 3, len(set(px))))
    # Merge colours a person would call the same (ΔE < 10), then keep the biggest n.
    merged = []
    for lab, count in sorted(clusters, key=lambda c: -c[1]):
        for m in merged:
            if delta_e(lab, m["lab"]) < 10:
                t = m["count"] + count
                m["lab"] = tuple((a * m["count"] + b * count) / t for a, b in zip(m["lab"], lab))
                m["count"] = t
                break
        else:
            merged.append({"lab": lab, "count": count})
    merged = [m for m in merged if m["count"] / len(labs) >= 0.005]
    merged.sort(key=lambda m: -m["count"])
    anchors = [rgb_to_lab(bg)] if bg else []
    merged = [m for m in merged if not is_edge_blend(m, merged, len(labs), anchors)]
    out = []
    for m in merged[:n]:
        rgb = lab_to_rgb(m["lab"])
        out.append({
            "hex": "#{:02X}{:02X}{:02X}".format(*rgb),
            "rgb": list(rgb),
            "cmyk": list(to_cmyk(rgb)),
            "share": round(100 * m["count"] / len(labs), 1),
            "name": colour_name(rgb),
            "notes": print_notes(rgb),
        })
    return out


# ---------------------------------------------------------------- output


def swatch(rgb) -> str:
    return "\033[48;2;{};{};{}m      \033[0m".format(*rgb)


def print_table(path, colours):
    print(f"\n{path}\n")
    for c in colours:
        cmyk = "C{} M{} Y{} K{}".format(*c["cmyk"])
        print(f"{swatch(c['rgb'])}  {c['hex']}  {c['share']:5.1f}%  {cmyk:<20} {c['name']}")
        for note in c["notes"]:
            print(f"        ! {note}")
    print("\nCMYK values are a simple conversion, not a calibrated profile: confirm with your printer.\n")


def write_html(path, colours, out):
    cards = "".join(
        f"""<div class="s"><div class="chip" style="background:{c['hex']}"></div>
        <div class="b"><div class="hex">{c['hex']}</div><div class="nm">{html.escape(c['name'])} · {c['share']}%</div>
        <div class="v">RGB {', '.join(map(str, c['rgb']))}<br>C{c['cmyk'][0]} M{c['cmyk'][1]} Y{c['cmyk'][2]} K{c['cmyk'][3]}</div>
        {''.join(f'<div class="n">{html.escape(n)}</div>' for n in c['notes'])}</div></div>"""
        for c in colours
    )
    bar = "".join(f'<i style="background:{c["hex"]};flex:{c["share"]}"></i>' for c in colours)
    doc = f"""<!doctype html><meta charset="utf-8"><title>Palette · {html.escape(path)}</title>
<style>body{{margin:0;padding:32px;background:#121212;color:#fff;font:15px/1.4 system-ui,sans-serif}}
h1{{font:700 34px Impact,'Arial Narrow',sans-serif;text-transform:uppercase;margin:0 0 6px}}
.cmyk{{display:flex;height:8px;margin:12px 0 24px}}.cmyk i{{flex:1}}
.bar{{display:flex;height:56px;margin-bottom:24px}}.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}}
.s{{background:#f7f5ef;color:#141414}}.chip{{height:120px}}.b{{padding:14px}}.hex{{font:700 24px Impact,sans-serif}}
.nm{{color:#5c5a55;margin:2px 0 8px}}.v{{font:13px ui-monospace,monospace}}.n{{margin-top:8px;font-size:13px;color:#a0005e}}
p{{color:#a3a3a3}}@media print{{body{{background:#fff;color:#000}}}}</style>
<h1>Palette</h1><p>{html.escape(path)}</p><div class="cmyk"><i style="background:#00aeef"></i><i style="background:#ec008c"></i><i style="background:#fff200"></i><i style="background:#fff"></i></div>
<div class="bar">{bar}</div><div class="grid">{cards}</div>
<p>CMYK values are a simple conversion, not a calibrated profile: confirm with your printer.</p>"""
    with open(out, "w", encoding="utf-8") as f:
        f.write(doc)
    print(f"Swatch sheet saved to {out}")


def main():
    ap = argparse.ArgumentParser(description="Pull the main colours out of a logo, photo or flyer, with print values.")
    ap.add_argument("image")
    ap.add_argument("-n", "--colours", type=int, default=6, help="how many colours (default 6)")
    ap.add_argument("--no-background", action="store_true", help="ignore the colour around the edges (paper, backdrop)")
    ap.add_argument("--html", metavar="FILE", help="also save a swatch sheet as HTML")
    ap.add_argument("--json", action="store_true", help="print JSON instead of a table")
    a = ap.parse_args()

    colours = extract(a.image, max(1, min(a.colours, 16)), keep_background=not a.no_background)
    if a.json:
        print(json.dumps(colours, indent=2))
    else:
        print_table(a.image, colours)
    if a.html:
        write_html(a.image, colours, a.html)


if __name__ == "__main__":
    main()
