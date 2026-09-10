#!/usr/bin/env python3
"""Find colours that ignore the brand.

    brandcoverage.py <content.json> [shape]

Renders the same content twice with two wildly different accents, then reports
saturated colours that came out IDENTICAL in both. Those are hardcoded — they
will stay cyan on a purple brand, teal on a red one, and nobody notices until
the graphic is next to the real logo.

This exists because that bug shipped three times in a row: the palette went in
first (leaving a lighter cyan tint behind), the capture page kept dark-mode
text on a light background, and the eyebrow label stayed sky-blue beside a
purple dot. Each was found by a person looking at a picture. Each would have
been caught here in a second.

Some colours SHOULD be fixed: the "problem" column is red on purpose, and ink
is ink. Those are listed as expected rather than hidden, so the list stays
short enough to actually read.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent

# Two accents far apart in hue AND lightness, so anything brand-driven moves a
# lot and anything hardcoded stands still.
ACCENT_A = "#FF0080"
ACCENT_B = "#00A000"

# Deliberately not brand-coloured. The red column signals "this is the problem"
# and must not turn purple just because the brand is purple.
EXPECTED = {
    "#f87171", "#fca5a5", "#dc2626", "#b91c1c", "#fee2e2", "#450a0a",
}


def spread(hexcode: str) -> int:
    """Colour spread — how far the channels are apart.

    A blunt stand-in for saturation, and enough for this: a colour with a
    spread near zero is a grey, whatever its hue nominally is.
    """
    h = (hexcode or "").lstrip("#")
    if len(h) != 6:
        return 0
    try:
        v = [int(h[i:i + 2], 16) for i in (0, 2, 4)]
    except ValueError:
        return 0
    return max(v) - min(v)


def check_canvas_keeps_the_brand(content: dict, brand: dict) -> int:
    """Fail when the derived canvas has lost the brand hue.

    The render-diff check below cannot catch this. A derived background DOES
    change with the accent — correctly, by its own logic — so it never appears
    as a frozen colour. It just changes to the wrong thing.

    That shipped: an accent of #4c1fb8 (spread 153) produced a canvas of
    #0d0a14 (spread 10). Technically brand-derived, visually near-black, and
    the graphic read as having no background at all.

    Skipped for near-neutral brands, where there is no hue to preserve.
    """
    import importlib.util
    spec = importlib.util.spec_from_file_location("fill", str(HERE / "scripts" / "fill.py"))
    fill = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fill)

    accent = content.get("accent") or brand.get("accent") or "#22D3EE"
    a_spread = spread(accent)

    if a_spread < 60:
        print(f"canvas check: accent {accent} is near-neutral (spread {a_spread}) — skipped")
        return 0

    explicit = bool(content.get("bg_from") or brand.get("bg_from"))
    bg_from = content.get("bg_from") or brand.get("bg_from") or fill.tint(accent, 22)
    bg_to = content.get("bg_to") or brand.get("bg_to") or fill.tint(accent, 34)

    # A dark canvas cannot hold the accent's full spread — luminance caps it.
    # The floor is what keeps the hue perceptible, not what matches the accent.
    floor = max(22, int(a_spread * 0.14))
    print("canvas check:")
    failed = False
    for label, colour in (("bg_from", bg_from), ("bg_to", bg_to)):
        sp = spread(colour)
        ok = sp >= floor
        mark = "✓" if ok else "✗"
        print(f"  {mark} {label} {colour}  spread {sp:3}  (floor {floor}, accent {a_spread})",
              file=sys.stderr if not ok else sys.stdout)
        if not ok:
            failed = True

    if failed:
        where = "brand/content file" if explicit else "the tint() derivation in fill.py"
        print(f"  ✗ the canvas has lost the brand hue — it will read as grey or near-black.\n"
              f"    Raise the target luminance or lower the desaturation in {where}.",
              file=sys.stderr)
        return 1
    return 0


def render(content: Path, accent: str, shape: str, out: Path) -> Path | None:
    brand = out / "brand.json"
    brand.write_text(json.dumps({
        "name": "Test", "badge": "T", "logo": "",
        "accent": accent, "accent_2": accent,
        "bg_from": "#0B1120", "bg_to": "#101C33", "mode": "dark",
        "forbid": [], "require": None,
    }))
    subprocess.run(
        ["bash", str(HERE / "scripts" / "build.sh"), str(content), str(out), str(brand), shape],
        capture_output=True, timeout=240,
    )
    pngs = [p for p in out.glob("*.png") if "capture" not in p.name]
    return pngs[0] if pngs else None


def saturated(px) -> bool:
    """Colourful enough to be a design decision rather than ink or a hairline."""
    r, g, b = px
    return (max(px) - min(px)) > 60 and 30 < (r + g + b) / 3 < 232


def main() -> int:
    content = Path(sys.argv[1])
    shape = sys.argv[2] if len(sys.argv) > 2 else "landscape"
    brand_path = sys.argv[3] if len(sys.argv) > 3 else None

    # Config-level, so it runs in milliseconds and always runs — no render
    # needed to know a derived colour is wrong.
    canvas_rc = check_canvas_keeps_the_brand(
        json.loads(content.read_text()),
        json.loads(Path(brand_path).read_text()) if brand_path else {},
    )

    from PIL import Image
    with tempfile.TemporaryDirectory() as ta, tempfile.TemporaryDirectory() as tb:
        a = render(content, ACCENT_A, shape, Path(ta))
        b = render(content, ACCENT_B, shape, Path(tb))
        if not a or not b:
            print("could not render both variants", file=sys.stderr)
            return 2

        ia, ib = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
        if ia.size != ib.size:
            print("renders differ in size", file=sys.stderr)
            return 2

        w, h = ia.size
        frozen: dict[str, int] = {}
        for y in range(0, h, 3):
            for x in range(0, w, 3):
                pa = ia.getpixel((x, y))
                if pa == ib.getpixel((x, y)) and saturated(pa):
                    key = "#%02x%02x%02x" % pa
                    frozen[key] = frozen.get(key, 0) + 1

    # Cluster near-identical shades so one gradient does not fill the report.
    # Near-match, not exact. Antialiasing and the GIF palette shift a colour
    # by a few points, so #f87171 renders as #f77070 and an exact-match
    # allowlist reports the intentional red column as a defect.
    def is_expected(hexcode: str) -> bool:
        v = [int(hexcode.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)]
        for e in EXPECTED:
            w = [int(e.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)]
            if sum(abs(a - b) for a, b in zip(v, w)) <= 30:
                return True
        return False

    ranked = sorted(frozen.items(), key=lambda kv: -kv[1])
    unexpected = [(c, n) for c, n in ranked if not is_expected(c) and n >= 12]

    print(f"brand coverage ({shape}):")
    if not unexpected:
        print("  ✓ every saturated colour follows the accent")
        return canvas_rc

    print("  colours that did NOT change with the brand:", file=sys.stderr)
    for colour, count in unexpected[:8]:
        print(f"    {colour}  ~{count} sampled px", file=sys.stderr)
    print("  If any of these should be brand-coloured, replace the literal with "
          "{{ACCENT}} in the template.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
