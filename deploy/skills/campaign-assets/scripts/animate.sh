#!/usr/bin/env bash
#
# Render an animated GIF of a campaign graphic.
#
#   animate.sh <content.json> <out-dir> [brand.json] [shape] [frames]
#
# Defaults: shape=square, frames=20 over a 2s loop (10fps).
#
# LinkedIn animates a GIF only if it is UNDER 5MB and UNDER 400 frames. Both
# are checked at the end and reported loudly, because a GIF that breaches
# either is shown as a still image with no warning — it looks like it worked.
#
# No Puppeteer. Chromium renders the frames and ffmpeg stitches them; both are
# already in the sandbox.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTENT="${1:?usage: animate.sh <content.json> <out-dir> [brand.json] [shape] [frames]}"
OUT="${2:?usage: animate.sh <content.json> <out-dir> [brand.json] [shape] [frames]}"
BRAND="${3:-$HERE/brands/generic.json}"
SHAPE="${4:-square}"
FRAMES="${5:-20}"
REVEAL="${REVEAL:-off}"      # REVEAL=on for the progressive-reveal loop
# Must match the CSS animation-duration. The reveal needs 4s: six beats plus a
# hold long enough for the finished state to be read before it loops.
if [ "$REVEAL" = "on" ]; then LOOP_S=4; else LOOP_S=2; fi
FPS=$(( FRAMES / LOOP_S ))

command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 3; }
CHROME="$(command -v chromium-browser || command -v chromium || command -v google-chrome || true)"
[ -n "$CHROME" ] || { echo "no chromium in PATH" >&2; exit 3; }
mkdir -p "$OUT"

case "$SHAPE" in
  landscape) W=1200; H=627  ;;
  square)    W=1200; H=1200 ;;
  portrait)  W=1080; H=1350 ;;
  *) echo "unknown shape: $SHAPE" >&2; exit 2 ;;
esac

# Logo once, reused by every frame — 20 fetches of the same file would be rude
# to the brand's host and slow for no reason.
LOGO_FILE="$OUT/.logo.datauri"
python3 - "$CONTENT" "$BRAND" "$LOGO_FILE" <<'LOGO'
import base64, json, mimetypes, subprocess, sys
from pathlib import Path
c = json.loads(Path(sys.argv[1]).read_text()); b = json.loads(Path(sys.argv[2]).read_text())
dest = Path(sys.argv[3]); src = c.get("logo") or b.get("logo") or ""
if not src:
    dest.write_text(""); raise SystemExit
if src.startswith(("http://", "https://")):
    r = subprocess.run(["curl", "-sSL", "--max-time", "25", "-o", "-", src], capture_output=True)
    if r.returncode != 0 or not r.stdout:
        dest.write_text(""); raise SystemExit
    data, mime = r.stdout, mimetypes.guess_type(src)[0] or "image/png"
else:
    p = Path(src)
    if not p.is_file():
        dest.write_text(""); raise SystemExit
    data, mime = p.read_bytes(), mimetypes.guess_type(str(p))[0] or "image/png"
dest.write_text(f"data:{mime};base64," + base64.b64encode(data).decode())
LOGO

FRAMEDIR="$(mktemp -d)"
trap 'rm -rf "$FRAMEDIR"' EXIT

echo "rendering $FRAMES frames at ${W}x${H}…"
for i in $(seq 0 $(( FRAMES - 1 ))); do
  # Negative delay + paused = "render the animation exactly here". Stepping it
  # walks the loop deterministically instead of racing a running animation.
  DELAY=$(python3 -c "print(f'-{$i * $LOOP_S / $FRAMES:.4f}s')")

  STEP="$FRAMEDIR/step.json"
  python3 - "$CONTENT" "$STEP" "$DELAY" "$REVEAL" <<'STEPJSON'
import json, sys
from pathlib import Path
c = json.loads(Path(sys.argv[1]).read_text())
c["_frame_delay"] = sys.argv[3]
c["_anim_state"] = "paused"
c["_reveal"] = sys.argv[4]
Path(sys.argv[2]).write_text(json.dumps(c))
STEPJSON

  HTML="$FRAMEDIR/f.html"
  python3 "$HERE/scripts/fill.py" "$HERE/templates/comparison.html" "$STEP" "$SHAPE" "$BRAND" "$LOGO_FILE" > "$HTML" || exit 4

  PNG="$(printf "%s/frame_%03d.png" "$FRAMEDIR" "$i")"
  "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
            --force-device-scale-factor=1 \
            --window-size="$W,$(( H + 160 ))" --screenshot="$PNG" "$HTML" >/dev/null 2>&1

  python3 - "$PNG" "$W" "$H" <<'CROP'
import sys
from PIL import Image
path, w, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
im = Image.open(path)
if im.size != (w, h):
    im.crop((0, 0, w, h)).save(path)
CROP
done
rm -f "$LOGO_FILE"

SLUG="$(python3 -c 'import json,sys,re; c=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); n=(c.get("brand") or b.get("name") or "campaign"); print(re.sub(r"[^a-z0-9]+","-",n.lower()).strip("-") or "campaign")' "$CONTENT" "$BRAND")"
if [ "$REVEAL" = "on" ]; then GIF="$OUT/$SLUG-$SHAPE-reveal.gif"; else GIF="$OUT/$SLUG-$SHAPE.gif"; fi

# Two passes. A GIF is 256 colours, and the default palette butchers a gradient
# into visible bands; palettegen builds one FROM THIS IMAGE, and the
# bayer dither keeps the banding from turning into mush.
PALETTE="$FRAMEDIR/palette.png"
ffmpeg -y -v error -framerate "$FPS" -i "$FRAMEDIR/frame_%03d.png" \
       -vf "palettegen=stats_mode=diff" "$PALETTE" 2>/dev/null || { echo "palettegen failed" >&2; exit 5; }
ffmpeg -y -v error -framerate "$FPS" -i "$FRAMEDIR/frame_%03d.png" -i "$PALETTE" \
       -lavfi "paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
       -loop 0 "$GIF" 2>/dev/null || { echo "gif encode failed" >&2; exit 5; }

[ -s "$GIF" ] || { echo "no gif produced" >&2; exit 5; }

python3 - "$GIF" "$FRAMES" <<'CHECK'
import os, sys
from PIL import Image
path, frames = sys.argv[1], int(sys.argv[2])
mb = os.path.getsize(path) / 1_000_000
im = Image.open(path)
n = getattr(im, "n_frames", 1)
print(f"  {path}  {im.size[0]}x{im.size[1]}  {n} frames  {mb:.2f}MB")
# LinkedIn shows a GIF that breaches either limit as a STILL, with no warning.
if mb > 5:
    print(f"  ⚠ {mb:.2f}MB is over LinkedIn's 5MB limit — it will not animate. "
          f"Try fewer frames or a smaller shape.")
if n > 400:
    print(f"  ⚠ {n} frames is over LinkedIn's 400-frame limit — it will not animate.")
if n < 2:
    print("  ⚠ only one frame survived encoding — this is a still, not an animation.")
CHECK
