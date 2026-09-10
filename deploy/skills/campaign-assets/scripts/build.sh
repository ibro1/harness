#!/usr/bin/env bash
#
# Render a content JSON into LinkedIn-ready PNGs.
#
#   build.sh <content.json> <out-dir> [shape ...]
#
# Shapes: landscape (1200x627) · square (1200x1200) · portrait (1080x1350)
# Default is all three.
#
# No Node, no npm install, no Puppeteer. Chromium is already in the sandbox and
# renders the HTML directly — the whole toolchain is one binary that is already
# there, which is also why this cannot break on a dependency update.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTENT="${1:?usage: build.sh <content.json> <out-dir> [brand.json] [shape ...]}"
OUT="${2:?usage: build.sh <content.json> <out-dir> [brand.json] [shape ...]}"
shift 2 || true

# Optional brand preset. Defaults to the neutral one, which has NO voice rules
# — so this works for any product out of the box and only enforces a house
# style when a brand file says to.
BRAND="$HERE/brands/generic.json"
if [ "${1:-}" ] && [ -f "${1:-}" ] && case "${1:-}" in *.json) true;; *) false;; esac; then
  BRAND="$1"; shift
fi
SHAPES=("$@"); [ ${#SHAPES[@]} -eq 0 ] && SHAPES=(landscape square portrait)

[ -f "$CONTENT" ] || { echo "no such content file: $CONTENT" >&2; exit 2; }
mkdir -p "$OUT"

# Fetch the logo ONCE and inline it as a data URI. Chromium would happily load
# a remote image, but then every render depends on the network being up and on
# the brand's host not rate-limiting a burst of screenshots — a logo that
# silently fails to load leaves a graphic with a hole where the brand goes.
# The data URI goes to a FILE, and the file path is what gets passed on. A
# base64 logo is hundreds of kilobytes; through argv it exceeds the kernel's
# per-argument limit and the build dies with "Argument list too long".
LOGO_FILE="$OUT/.logo.datauri"
python3 - "$CONTENT" "$BRAND" "$LOGO_FILE" <<'LOGO'
import base64, json, mimetypes, subprocess, sys
from pathlib import Path
c = json.loads(Path(sys.argv[1]).read_text()); b = json.loads(Path(sys.argv[2]).read_text())
dest = Path(sys.argv[3])
src = c.get("logo") or b.get("logo") or ""
if not src:
    dest.write_text(""); raise SystemExit
if not src.startswith(("http://", "https://")):
    p = Path(src)
    if not p.is_file():
        dest.write_text(""); sys.exit(0)
    data, mime = p.read_bytes(), mimetypes.guess_type(str(p))[0] or "image/png"
else:
    r = subprocess.run(["curl", "-sSL", "--max-time", "25", "-o", "-", src], capture_output=True)
    if r.returncode != 0 or not r.stdout:
        dest.write_text("")
        print(f"  · logo could not be fetched ({src}) — using the letter badge", file=sys.stderr)
        sys.exit(0)
    data = r.stdout
    mime = mimetypes.guess_type(src)[0] or "image/png"
dest.write_text(f"data:{mime};base64," + base64.b64encode(data).decode())
LOGO


python3 - "$CONTENT" "$BRAND" <<'MODECHECK'
import json, sys
from pathlib import Path
c = json.loads(Path(sys.argv[1]).read_text()); b = json.loads(Path(sys.argv[2]).read_text())
mode = (c.get("mode") or b.get("mode") or "dark").lower()
bg = (c.get("bg_from") or b.get("bg_from") or "#0B1120").lstrip("#")
try:
    r, g, bl = (int(bg[i:i+2], 16) for i in (0, 2, 4))
except (ValueError, IndexError):
    sys.exit(0)
lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl
bg_is_light = lum > 140
if bg_is_light and mode != "light":
    print(f"  ⚠ background #{bg} is light but mode is '{mode}' — light-mode text is white, "
          f"so the copy will be invisible. Set \"mode\": \"light\".", file=sys.stderr)
elif not bg_is_light and mode == "light":
    print(f"  ⚠ background #{bg} is dark but mode is 'light' — dark text on a dark "
          f"canvas. Set \"mode\": \"dark\".", file=sys.stderr)
MODECHECK

CHROME="$(command -v chromium-browser || command -v chromium || command -v google-chrome || true)"
[ -n "$CHROME" ] || { echo "no chromium in PATH" >&2; exit 3; }

dims() {
  case "$1" in
    landscape) echo "1200 627" ;;
    square)    echo "1200 1200" ;;
    portrait)  echo "1080 1350" ;;
    *) echo "unknown shape: $1" >&2; return 1 ;;
  esac
}

for shape in "${SHAPES[@]}"; do
  read -r W H < <(dims "$shape") || exit 2
  HTML="$OUT/.$shape.html"
  # Filename from the brand, not a hardcoded prefix — every asset for every
  # product was landing as "frontstaff-*.png".
  SLUG="$(python3 -c 'import json,sys,re; c=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); n=(c.get("brand") or b.get("name") or "campaign"); print(re.sub(r"[^a-z0-9]+","-",n.lower()).strip("-") or "campaign")' "$CONTENT" "$BRAND")"
  PNG="$OUT/$SLUG-$shape.png"

  python3 "$HERE/scripts/fill.py" "$HERE/templates/comparison.html" "$CONTENT" "$shape" "$BRAND" "$LOGO_FILE" > "$HTML" || exit 4

  # Chromium paints into a viewport about 87px SHORTER than the window it
  # then screenshots at full size, in both headless modes. Asking for the
  # target height and trusting the result leaves a dead band along the bottom
  # of every graphic — measured at exactly 87px on 627, 1200 and 1350.
  #
  # So: render into a deliberately taller window, then crop to the canvas. The
  # frame itself is a fixed pixel box, so the crop is exact rather than a
  # guess at where the content happened to stop.
  PAD_H=$(( H + 160 ))
  "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
            --force-device-scale-factor=1 \
            --window-size="$W,$PAD_H" --screenshot="$PNG" "$HTML" >/dev/null 2>&1

  python3 - "$PNG" "$W" "$H" <<'CROP' || exit 5
import sys
from PIL import Image
path, w, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
im = Image.open(path)
if im.size != (w, h):
    im.crop((0, 0, w, h)).save(path)
CROP

  [ -s "$PNG" ] || { echo "render produced nothing for $shape" >&2; exit 5; }
  rm -f "$HTML"

  python3 - "$PNG" "$W" "$H" <<'PY' || exit 6
import sys
from PIL import Image
path, w, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
im = Image.open(path).convert("RGB")
if im.size != (w, h):
    sys.exit(f"{path}: got {im.size}, expected {(w, h)}")

# A letterboxed render is the failure this catches: content that does not reach
# the bottom edge leaves a band that reads as a design choice until someone
# posts it. Sampling the last row is enough to prove the frame filled.
band = [im.getpixel((x, im.height - 2)) for x in range(0, im.width, max(1, im.width // 6))]
if all(p == (255, 255, 255) for p in band):
    sys.exit(f"{path}: bottom edge is blank — frame did not fill the viewport")

mb = __import__("os").path.getsize(path) / 1_000_000
# LinkedIn rejects over 5MB. Flagged rather than fixed: silently recompressing
# a graphic someone is about to publish is not this script's decision.
print(f"  {path}  {im.size[0]}x{im.size[1]}  {mb:.2f}MB" + ("  ⚠ over LinkedIn's 5MB limit" if mb > 5 else ""))
PY
done

# The capture page is built from the SAME content file as the graphics, so the
# headline in the feed and the headline on the page cannot drift apart. That
# drift is the ordinary way a funnel quietly stops converting: someone edits
# the ad copy, nobody edits the landing page.
CAPTURE="$OUT/capture/index.html"
mkdir -p "$OUT/capture"
python3 "$HERE/scripts/fill.py" "$HERE/templates/capture.html" "$CONTENT" page "$BRAND" "$LOGO_FILE" > "$CAPTURE" || exit 7
echo "  $CAPTURE  (lead capture page)"

# Render the page too, not just the graphics.
#
# Theming was added to the infographic template and not to this one, and
# nothing noticed: the build printed three PNGs to look at and an HTML file
# that nobody opened. The page shipped with a brand's near-white background
# and dark-mode white text on top of it — an invisible headline, published.
#
# A preview PNG costs one chromium call and makes every build show all four
# surfaces. A check that only looks at three of them is how a half-applied
# change reaches a deploy.
CAPTURE_PNG="$OUT/$SLUG-capture-preview.png"
CAP_W=1280; CAP_H=900
"$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
          --force-device-scale-factor=1 \
          --window-size="$CAP_W,$(( CAP_H + 160 ))" \
          --screenshot="$CAPTURE_PNG" "$CAPTURE" >/dev/null 2>&1

if [ -s "$CAPTURE_PNG" ]; then
  python3 - "$CAPTURE_PNG" "$CAP_W" "$CAP_H" <<'CROP'
import sys
from PIL import Image
path, w, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
im = Image.open(path)
if im.size != (w, h):
    im = im.crop((0, 0, w, h))
    im.save(path)

CROP
  echo "  $CAPTURE_PNG  ${CAP_W}x${CAP_H}  (page preview — open this too)"
else
  echo "  · could not render a preview of the capture page" >&2
fi

if grep -q 'var ENDPOINT = "";' "$CAPTURE"; then
  echo "  ⚠ form_endpoint is empty — the page will refuse submissions and say so." >&2
fi

rm -f "$LOGO_FILE"

# GIF is opt-in: it triples the render time and most campaigns want the PNGs.
# Without this, `build.sh` silently never produces one and the animated variant
# has to be remembered as a separate command — which is how it gets forgotten.
if [ "${WITH_GIF:-off}" = "on" ]; then
  echo "  building animated GIF (REVEAL=${REVEAL:-on})…"
  REVEAL="${REVEAL:-on}" bash "$HERE/scripts/animate.sh" \
    "$CONTENT" "$OUT" "$BRAND" "${GIF_SHAPE:-square}" "${GIF_FRAMES:-40}" 2>&1 | sed 's/^/  /'
fi

# VARIANTS: render each headline in content.headline_variants and tile them
# into one sheet for choosing. Nobody writes the right headline first — the
# alternative is rebuilding by hand and comparing across three browser tabs,
# which in practice means the first draft ships.
#
# This re-invokes build.sh rather than reimplementing the render. A second copy
# of the fill/screenshot/crop path would drift from this one, which is exactly
# how the duplicate tint() ended up producing a near-black canvas.
if [ "${VARIANTS:-off}" = "on" ]; then
  VS=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1])).get("headline_variants") or []))' "$CONTENT")
  if [ "$VS" -lt 2 ]; then
    echo "  ⚠ VARIANTS=on but content has no \"headline_variants\" array (needs 2+)." >&2
  else
    VSHAPE="${VARIANT_SHAPE:-square}"
    VDIR="$OUT/variants"; mkdir -p "$VDIR"
    echo "  rendering $VS headline variants ($VSHAPE)…"
    for i in $(seq 0 $((VS - 1))); do
      VC="$VDIR/.v$i.json"
      python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); c["headline"]=c["headline_variants"][int(sys.argv[2])]; c.pop("headline_variants",None); json.dump(c,open(sys.argv[3],"w"))' \
        "$CONTENT" "$i" "$VC"
      # VARIANTS=off in the child: without it this recurses forever.
      VARIANTS=off WITH_GIF=off bash "$0" "$VC" "$VDIR/v$i" "$BRAND" "$VSHAPE" >/dev/null 2>&1
      rm -f "$VC"
    done
    python3 "$HERE/scripts/sheet.py" "$VDIR" "$CONTENT" "$OUT" || true
    rm -rf "$VDIR"
  fi
fi

python3 "$HERE/scripts/brandcheck.py" "$BRAND" "$CONTENT"
