#!/usr/bin/env python3
"""Build a brand preset from a live website.

    brandinit.py <url> <out.json> [--name NAME] [--no-font]

The skill originally shipped an invented palette and a letter for a logo, and
the result looked fine while being off-brand in the most basic way: FrontStaff's
site is purple (#4c1fb8) and the graphics came out cyan. Nothing in the build
could notice, because nothing had ever looked at the brand.

WHY THIS READS STYLESHEETS
--------------------------
The first version parsed the HTML only. On frontstaff.ai that found two hex
values and zero fonts, because the site has ONE external stylesheet and no
inline <style> at all. Everything it "extracted" was scraps that happened to
leak into markup — SVG fills and inline attributes. The actual brand system was
in a file it never opened.

Any modern build (Vite, Next, Tailwind) emits a hashed CSS bundle and leaves the
HTML nearly styleless, so HTML-only extraction is wrong by default, not
occasionally. This follows <link rel=stylesheet> and reads the real thing.

What is taken:
  name        <title>, trimmed of the usual " | tagline" suffix
  logo        a <link rel=icon>/<img> whose URL mentions logo/brand/mark
  colours     CSS custom properties first, then frequency across HTML + CSS
  typography  the body font-family, and its @font-face file if self-hosted
  background  sampled from a rendered screenshot, not parsed
  positioning <meta name=description>, kept as a note for whoever writes copy

Colour ranking is a heuristic, not a brand guide. It reliably finds something
that is *actually on the site*, which beats an invention, but it cannot tell a
brand colour from a heavily-used border grey — so the result is meant to be
reviewed, and the script prints what it chose and why.
"""
import argparse
import base64
import collections
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path

UA = "Mozilla/5.0 (compatible; campaign-assets/1.0)"
MAX_SHEETS = 6          # a bundle or two, not an entire CDN
MAX_FONT_BYTES = 400_000  # a woff2 over this is a whole family, not one weight


# Greys, near-blacks and near-whites dominate any stylesheet and are never the
# brand colour. Dropped before ranking rather than after, so a real accent that
# appears twice still outranks a border grey that appears two hundred times.
def is_neutral(hexcode: str) -> bool:
    r, g, b = (int(hexcode[i:i + 2], 16) for i in (0, 2, 4))
    spread = max(r, g, b) - min(r, g, b)
    light = (r + g + b) / 3
    return spread < 26 or light > 235 or light < 20


def fetch(url: str, binary: bool = False):
    """One curl. Returns text (or bytes), or None — callers decide if fatal."""
    cmd = ["curl", "-sSL", "--max-time", "30", "-A", UA, url]
    if binary:
        out = subprocess.run(cmd, capture_output=True)
        return out.stdout if out.returncode == 0 and out.stdout else None
    out = subprocess.run(cmd, capture_output=True, text=True, errors="ignore")
    return out.stdout if out.returncode == 0 and out.stdout else None


def collect_css(html: str, base: str):
    """Fetch every linked stylesheet plus any inline <style>.

    Returns (css_text, [urls_read]). Failures are silent by design: a missing
    stylesheet should degrade extraction, not abort the run.
    """
    hrefs = re.findall(r'<link[^>]+rel=["\']stylesheet["\'][^>]*href=["\']([^"\']+)', html, re.I)
    hrefs += re.findall(r'<link[^>]+href=["\']([^"\']+\.css[^"\']*)["\']', html, re.I)
    seen, urls = set(), []
    for h in hrefs:
        u = urllib.parse.urljoin(base, h)
        if u not in seen:
            seen.add(u)
            urls.append(u)
        if len(urls) >= MAX_SHEETS:
            break

    css_parts = re.findall(r"<style[^>]*>(.*?)</style>", html, re.I | re.S)
    read = []
    for u in urls:
        body = fetch(u)
        if body:
            css_parts.append(body)
            read.append(u)
    return "\n".join(css_parts), read


def rgb_to_hex(m) -> str:
    try:
        r, g, b = (int(x) for x in m.groups()[:3])
        return "#%02x%02x%02x" % (r, g, b)
    except Exception:
        return ""


def dark_scope_ranges(css: str):
    """Character ranges belonging to a dark-theme block.

    Real sites declare the same token twice. frontstaff.ai has
    `--primary: #7020e6` for light and `--primary: #853cf0` for dark. Ranking
    by frequency picked the dark one by a margin of a single occurrence — the
    right answer by luck, which is the kind of thing that silently flips when
    the site is redeployed. Knowing WHICH scope a token came from makes it a
    choice rather than a coincidence.
    """
    ranges = []
    for m in re.finditer(r'(\.dark\b|\[data-theme=["\']?dark|prefers-color-scheme\s*:\s*dark)', css, re.I):
        i = css.find("{", m.end())
        if i < 0:
            continue
        depth, j = 0, i
        while j < len(css):
            if css[j] == "{":
                depth += 1
            elif css[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        ranges.append((i, j))
    return ranges


def hue_of(hexcode: str) -> float:
    import colorsys
    r, g, b = (int(hexcode[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return colorsys.rgb_to_hsv(r, g, b)[0] * 360


def hue_gap(a: str, b: str) -> float:
    d = abs(hue_of(a) - hue_of(b))
    return min(d, 360 - d)


def rank_colours(html: str, css: str, mode: str):
    """Rank brand colour candidates for the theme we are actually rendering.

    CSS custom properties are weighted far above raw frequency. A declaration
    like `--primary: #7020e6` is a brand token by construction — somebody named
    it — whereas the most *frequent* hex in a bundle is usually a hover state.
    Frequency alone picked plausible-but-wrong colours; naming is intent.

    Returns (ranked, named). `named` maps token-name -> hex for the scope in
    play, so the caller can prefer a declared secondary over a near-identical
    shade of the primary.
    """
    dark_ranges = dark_scope_ranges(css)
    in_dark = lambda pos: any(a <= pos <= b for a, b in dark_ranges)
    want_dark = (mode == "dark")

    weighted = collections.Counter()
    named = {}

    for m in re.finditer(r"--([\w-]+)\s*:\s*([^;}]+)", css):
        name, val = m.group(1), m.group(2)
        hexes = re.findall(r"#([0-9a-fA-F]{6})\b", val)
        for rm in re.finditer(r"rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)", val):
            h = rgb_to_hex(rm)
            if h:
                hexes.append(h[1:])
        if not hexes:
            continue

        scoped_dark = in_dark(m.start())
        # A token from the other theme is still a brand colour, just not this
        # one's — keep it as a weak candidate rather than discarding it.
        scope_mult = 1.0 if scoped_dark == want_dark else 0.15
        boost = 60 if re.search(r"primary|brand|accent|main|theme", name, re.I) else 25

        for c in hexes:
            c = c.lower()
            if not is_neutral(c):
                weighted[c] += boost * scope_mult
                if scoped_dark == want_dark and name.lower() not in named:
                    named[name.lower()] = f"#{c}"

    # Ordinary declarations, by frequency.
    for c in re.findall(r"#([0-9a-fA-F]{6})\b", css + html):
        c = c.lower()
        if not is_neutral(c):
            weighted[c] += 1
    for m in re.finditer(r"rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)", css):
        h = rgb_to_hex(m)
        if h and not is_neutral(h[1:]):
            weighted[h[1:]] += 1

    theme = first(r'name=["\']theme-color["\'][^>]*content=["\']([^"\']+)["\']', html)
    if theme and re.fullmatch(r"#[0-9a-fA-F]{6}", theme.strip()):
        weighted[theme.strip().lower()[1:]] += 80  # declared for the browser chrome

    return [f"#{c}" for c, _ in weighted.most_common(6)], named


def pick_secondary(accent: str, ranked, named):
    """Choose a second colour that is actually visible next to the first.

    The naive pick was ranked[1], which on FrontStaff gave #7020e6 against
    #853cf0 — two purples twelve degrees apart. A gradient between them is a
    flat fill, and the "vs" arrow that uses it vanishes. Prefer a colour the
    brand explicitly named as a secondary, provided it reads as a different hue.
    """
    for key in ("brand-accent", "brand-2", "accent-2", "secondary", "accent"):
        v = named.get(key)
        if v and not is_neutral(v[1:]) and hue_gap(v[1:], accent[1:]) > 25:
            return v, f"--{key}, {hue_gap(v[1:], accent[1:]):.0f}deg from accent"
    for c in ranked[1:]:
        if hue_gap(c[1:], accent[1:]) > 25:
            return c, f"ranked, {hue_gap(c[1:], accent[1:]):.0f}deg from accent"
    return (ranked[1] if len(ranked) > 1 else accent), "nearest available (low contrast)"


def extract_font(css: str, base: str, want_file: bool):
    """Find the body typeface and, if self-hosted, its woff2.

    Typography is a stronger brand signal than colour — you would recognise a
    competitor's typeface before their hex code — and every graphic until now
    rendered in DejaVu Sans, a Linux default that belongs to nobody.
    """
    family = None
    for sel in (r"body\s*\{[^}]*", r":root\s*\{[^}]*", r"html\s*\{[^}]*"):
        m = re.search(sel + r"font-family\s*:\s*([^;}]+)", css, re.I | re.S)
        if m:
            family = m.group(1)
            break
    if not family:
        fams = re.findall(r"font-family\s*:\s*([^;}]+)", css, re.I)
        family = collections.Counter(f.strip() for f in fams).most_common(1)[0][0] if fams else None
    if not family:
        return None, None, None

    stack = family.strip().strip("'\"")
    primary = re.split(r"\s*,\s*", stack)[0].strip().strip("'\"")
    if not primary or primary.lower() in {"inherit", "initial", "unset", "var"}:
        return None, None, None
    if primary.startswith("var("):
        m = re.search(r"var\(\s*(--[\w-]+)", primary)
        if m:
            v = re.search(re.escape(m.group(1)) + r"\s*:\s*([^;}]+)", css)
            if not v:
                return None, None, None
            stack = v.group(1).strip().strip("'\"")
            primary = re.split(r"\s*,\s*", stack)[0].strip().strip("'\"")

    # Its @font-face, preferring a normal weight over black/thin.
    font_bytes = None
    blocks = re.findall(r"@font-face\s*\{([^}]+)\}", css, re.I | re.S)
    cands = []
    for b in blocks:
        fam = re.search(r"font-family\s*:\s*([^;]+)", b, re.I)
        if not fam or primary.lower() not in fam.group(1).lower():
            continue
        wt = re.search(r"font-weight\s*:\s*(\d{3})", b, re.I)
        weight = int(wt.group(1)) if wt else 400
        for u in re.findall(r"url\(([^)]+)\)", b, re.I):
            u = u.strip().strip("'\"")
            if ".woff2" in u.lower():
                cands.append((abs(weight - 400), urllib.parse.urljoin(base, u)))
    if want_file and cands:
        cands.sort()
        data = fetch(cands[0][1], binary=True)
        if data and len(data) <= MAX_FONT_BYTES:
            font_bytes = data

    return primary, stack, font_bytes


def sample_background(url: str):
    """Read the page background from a RENDERED screenshot.

    Parsing CSS for a background colour does not survive contact with real
    sites: Tailwind classes, CSS-in-JS and computed gradients mean the winning
    declaration is rarely findable by regex. Rendering and sampling the edges is
    ground truth, and it is one chromium call.

    Returns (from, to, mode). Mode matters more than the colours: these
    templates use light text, so adopting a light brand background without
    inverting the ink puts white copy on a white canvas.
    """
    chrome = next((c for c in ("chromium-browser", "chromium", "google-chrome")
                   if shutil.which(c)), None)
    if not chrome:
        return "#0B1120", "#101C33", "dark"

    with tempfile.TemporaryDirectory() as tmp:
        shot = Path(tmp) / "site.png"
        subprocess.run(
            [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
             "--window-size=1280,900", f"--screenshot={shot}", url],
            capture_output=True, timeout=90,
        )
        if not shot.is_file():
            return "#0B1120", "#101C33", "dark"

        from PIL import Image
        im = Image.open(shot).convert("RGB")
        w, h = im.size
        # Edges, not the centre: the middle of a landing page is hero art.
        edge = [im.getpixel((x, y)) for x in range(0, w, 20) for y in (2, 6, h - 3, h - 7)]
        edge += [im.getpixel((x, y)) for y in range(0, h, 20) for x in (2, 6, w - 3, w - 7)]
        top = collections.Counter(edge).most_common(2)
        if not top:
            return "#0B1120", "#101C33", "dark"

    c = top[0][0]
    lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    hexed = lambda t: "#%02x%02x%02x" % t
    second = top[1][0] if len(top) > 1 else c
    return hexed(c), hexed(second), ("light" if lum > 140 else "dark")


def first(pattern: str, html: str):
    m = re.search(pattern, html, re.I | re.S)
    return m.group(1).strip() if m else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("out")
    ap.add_argument("--name", default=None)
    ap.add_argument("--no-font", action="store_true", help="skip downloading the webfont")
    args = ap.parse_args()

    html = fetch(args.url)
    if not html:
        sys.exit(f"could not fetch {args.url}")
    base = args.url

    css, sheets = collect_css(html, base)

    raw_title = first(r"<title[^>]*>(.*?)</title>", html) or ""
    # "FrontStaff AI | Hire an AI Employee" -> "FrontStaff AI"
    name = args.name or re.split(r"\s*[|·—–-]\s*", raw_title)[0].strip() or "Brand"

    logo = (
        first(r'<img[^>]+src=["\']([^"\']*(?:logo|brand|wordmark|mark)[^"\']*)["\']', html)
        or first(r'<link[^>]+rel=["\'][^"\']*icon[^"\']*["\'][^>]+href=["\']([^"\']+)["\']', html)
    )
    if logo:
        logo = urllib.parse.urljoin(base, logo)

    og = first(r'property=["\']og:image["\'][^>]*content=["\']([^"\']+)["\']', html)
    if og:
        og = urllib.parse.urljoin(base, og)

    # Background first: it decides the theme, and the theme decides which
    # --primary is the right one. Ranking colours before knowing that was how
    # the light-theme purple could have won on a dark canvas.
    bg_from, bg_to, mode = sample_background(base)

    ranked, named = rank_colours(html, css, mode)
    # A token the brand actually named beats the frequency winner.
    accent = next((named[k] for k in ("primary", "brand", "brand-primary") if k in named),
                  ranked[0] if ranked else "#22D3EE")
    accent2, why2 = pick_secondary(accent, ranked, named)

    fam, stack, font_bytes = extract_font(css, base, not args.no_font)

    out_path = Path(args.out)
    font_file = ""
    if font_bytes:
        fp = out_path.with_name(out_path.stem + "-font.woff2")
        fp.write_bytes(font_bytes)
        font_file = fp.name  # relative: the brand json and font travel together

    preset = {
        "name": name,
        "badge": name[:1].upper(),
        "logo": logo or "",
        "accent": accent,
        "accent_2": accent2,
        "bg_from": bg_from,
        "bg_to": bg_to,
        "mode": mode,
        "font_family": fam or "",
        "font_stack": stack or "",
        "font_file": font_file,
        "source_url": base,
        "positioning_note": (first(r'name=["\']description["\'][^>]*content=["\']([^"\']+)["\']', html) or "")[:300],
        "og_image": og or "",
        "forbid": [],
        "require": None,
        "//": "Extracted from the live site — REVIEW IT. Colour ranking prefers named CSS tokens but can still pick a heavily used UI colour over the real brand one. Voice rules are yours to add.",
    }

    out_path.write_text(json.dumps(preset, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"brand preset written: {args.out}")
    print(f"  name    : {name}")
    print(f"  css     : {len(sheets)} stylesheet(s), {len(css):,} bytes read")
    for u in sheets:
        print(f"            {u[:88]}")
    print(f"  logo    : {logo or '(none found — a letter badge will be used)'}")
    print(f"  theme   : {mode}  (canvas {bg_from} -> {bg_to}, sampled from a render)")
    print(f"  accent  : {accent}" + (f"  (candidates: {', '.join(ranked[:4])})" if ranked else "  (fallback)"))
    print(f"  accent_2: {accent2}  [{why2}]")
    if named:
        keys = [k for k in ("primary", "brand", "brand-accent", "accent") if k in named]
        print(f"  tokens  : " + ", ".join(f"--{k}={named[k]}" for k in keys) + f"  ({mode} scope)")
    print(f"  font    : {fam or '(none found — falling back to system sans)'}"
          + (f"  [{len(font_bytes):,}B embedded]" if font_bytes else ""))
    print(f"  review  : named CSS tokens rank above frequency, but neither is authority")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
