#!/usr/bin/env python3
"""Tile rendered headline variants into one contact sheet.

    sheet.py <variants-dir> <content.json> <out-dir>

Choosing a headline by opening three PNGs in sequence does not work — you
compare each against your memory of the last one, and the one you looked at
most recently always wins. Side by side at the same scale, the weak one is
obvious in about two seconds.

The sheet is a working document, not an asset: it is labelled, it is scaled
down, and it is not something to post. That is deliberate. An unlabelled grid
of near-identical graphics is its own kind of confusion.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

GUTTER = 28
LABEL_H = 78
MARGIN = 28
BG = (18, 16, 28)
INK = (245, 244, 250)
DIM = (150, 146, 170)


def load_font(size: int, bold: bool = False):
    names = (
        ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"] if bold
        else ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    )
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            continue
    return ImageFont.load_default()


def wrap(draw, text, font, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= width:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def main() -> int:
    vdir, content_path, out_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    c = json.loads(content_path.read_text(encoding="utf-8"))
    variants = c.get("headline_variants") or []

    shots = []
    for i, headline in enumerate(variants):
        found = sorted((vdir / f"v{i}").glob("*.png"))
        # The capture-page preview lives alongside the graphic; skip it.
        found = [p for p in found if "capture" not in p.name]
        if found:
            shots.append((chr(65 + i), headline, Image.open(found[0]).convert("RGB")))

    if not shots:
        print("  ⚠ no variant renders found — sheet skipped", file=sys.stderr)
        return 1

    # Scale so the whole sheet is a comfortable width, not so each tile is big.
    cols = min(len(shots), 3)
    rows = (len(shots) + cols - 1) // cols
    tile_w = min(420, shots[0][2].width)
    scale = tile_w / shots[0][2].width
    tile_h = int(shots[0][2].height * scale)

    W = MARGIN * 2 + cols * tile_w + (cols - 1) * GUTTER
    H = MARGIN * 2 + rows * (tile_h + LABEL_H) + (rows - 1) * GUTTER + 46

    sheet = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    title_f, label_f, body_f = load_font(21, True), load_font(19, True), load_font(15)

    d.text((MARGIN, MARGIN - 6), "Headline variants — pick one, then rebuild without VARIANTS",
           font=title_f, fill=INK)

    for idx, (letter, headline, im) in enumerate(shots):
        r, col = divmod(idx, cols)
        x = MARGIN + col * (tile_w + GUTTER)
        y = MARGIN + 46 + r * (tile_h + LABEL_H + GUTTER)
        sheet.paste(im.resize((tile_w, tile_h), Image.LANCZOS), (x, y))
        d.rectangle([x, y, x + tile_w - 1, y + tile_h - 1], outline=(70, 66, 92))
        d.text((x, y + tile_h + 10), letter, font=label_f, fill=INK)
        for li, line in enumerate(wrap(d, headline, body_f, tile_w - 26)[:2]):
            d.text((x + 22, y + tile_h + 11 + li * 19), line, font=body_f, fill=DIM)

    out = out_dir / "variants-sheet.png"
    sheet.save(out, optimize=True)
    print(f"  {out}  {W}x{H}  ({len(shots)} variants, labelled A–{chr(64 + len(shots))})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
