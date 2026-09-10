#!/usr/bin/env python3
"""Substitute a content JSON into the HTML template.

Kept deliberately dumb: token replacement, no template engine, no dependency.
The only real work is escaping — copy for these graphics is written by a person
or a model and routinely contains an ampersand, and an unescaped one silently
truncates the rest of the line in the render.
"""
import html
import json
import sys
from pathlib import Path


def tint(hexcode: str, target_lum: float, desat: float = 0.30) -> str:
    """A canvas derived FROM the brand colour.

    Sampling the rendered site gave FrontStaff a #fcfbfd background — the
    page is white, so the graphic came out with no background at all while
    the brand's actual colours (#4c1fb8, #380684, both dark) went unused.
    A canvas tinted toward the accent is what makes a graphic read as
    designed rather than as text floating on nothing.

    The hue is kept, saturation pulled back so the canvas never competes
    with the accent it sits under, and luminance forced to `target_lum`.

    Those numbers took a correction. Pushing to luminance 11 with 55%
    desaturation produced #0d0a14 — a colour spread of 10 against the
    accent's 153, which is to say near-black with the brand hue gone. A
    canvas has to stay dark enough for light text and still read as the
    brand; 22/34 at 30% desaturation does both.
    """
    h = (hexcode or "").lstrip("#")
    if len(h) != 6:
        return "#0B1120"
    try:
        r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return "#0B1120"
    grey = (r + g + b) / 3
    r = r + (grey - r) * desat
    g = g + (grey - g) * desat
    b = b + (grey - b) * desat
    cur = 0.2126 * r + 0.7152 * g + 0.0722 * b
    k = (target_lum / cur) if cur > 1 else 0
    clamp = lambda v: max(0, min(255, int(round(v * k))))
    return "#%02x%02x%02x" % (clamp(r), clamp(g), clamp(b))


def esc(value: str) -> str:
    return html.escape(str(value), quote=True)


def jsesc(value: str) -> str:
    """Escape for a double-quoted JS string literal inside <script>.

    HTML-escaping is the wrong escape here and it was silently breaking the
    form. Script content is raw text: the HTML parser never decodes an entity
    inside it. So a capture URL with a query string —
    `…/capture?ws=…&campaign=…` — reached the browser as
    `…?ws=…&amp;campaign=…`, and every lead was posted with a parameter named
    `amp;campaign`. The page looked fine, the POST returned 200, and the
    campaign attribution was gone.
    """
    return json.dumps(str(value))[1:-1].replace("</", "<\\/")


def items(values) -> str:
    """Bullet list. The mark is decorative, so it is hidden from a11y tools."""
    return "".join(
        f'<li><span class="mark" aria-hidden="true">{"–" if kind == "bad" else "✓"}</span>'
        f"<span>{esc(v)}</span></li>"
        for v in values
    )


def main() -> int:
    template, content_path, shape = sys.argv[1], sys.argv[2], sys.argv[3]
    brand_path = sys.argv[4] if len(sys.argv) > 4 else None
    # A PATH to the data URI, never the data URI itself: a base64 logo is
    # hundreds of KB and exceeds the kernel per-argument limit.
    logo_arg = ""
    if len(sys.argv) > 5 and sys.argv[5]:
        lp = Path(sys.argv[5])
        if lp.is_file():
            logo_arg = lp.read_text(encoding="utf-8").strip()
    c = json.loads(Path(content_path).read_text(encoding="utf-8"))
    b = json.loads(Path(brand_path).read_text(encoding="utf-8")) if brand_path else {}

    # Content wins over the preset: a one-off graphic should not need its own
    # brand file just to change a headline colour.
    brand_name = c.get("brand") or b.get("name") or ""
    # The badge falls back to the first letter of the name rather than a
    # hardcoded letter — which is what made the first version FrontStaff-only.
    badge = c.get("badge") or b.get("badge") or (brand_name[:1].upper() if brand_name else "")

    # A real logo beats a letter. LOGO_SRC is set by build.sh to a data URI so
    # the render never depends on the network being up at screenshot time.
    logo_src = logo_arg or c.get("logo_src") or b.get("logo_src") or ""
    brandmark = (
        f'<img src="{logo_src}" alt="{esc(brand_name)}">'
        if logo_src
        else f'<span class="badge">{esc(badge)}</span>'
    )
    # Most logos ARE the wordmark. Printing the name beside one duplicates it,
    # so the text drops out whenever a logo is present.
    shown_name = "" if logo_src else brand_name

    # TYPOGRAPHY
    # Every graphic before this rendered in DejaVu Sans, a Linux default that
    # belongs to nobody — while carefully matching the brand's purple. Type is
    # the stronger signal of the two: you would know a competitor's typeface
    # before their hex code.
    #
    # The woff2 is embedded as a data URI rather than linked, for the same
    # reason the logo is: headless chromium renders the moment the page settles,
    # and a font still in flight renders as fallback with no error. A silent
    # wrong-font render is exactly the class of bug this skill keeps hitting.
    font_face, font_stack = "", ""
    font_file = b.get("font_file") or ""
    if font_file and brand_path:
        fp = Path(brand_path).parent / font_file
        if fp.is_file():
            import base64
            b64 = base64.b64encode(fp.read_bytes()).decode("ascii")
            fam = b.get("font_family") or "BrandFont"
            font_face = (
                f"@font-face{{font-family:'{fam}';"
                f"src:url(data:font/woff2;base64,{b64}) format('woff2');"
                "font-weight:100 900;font-display:block;}"
            )
            font_stack = f"'{fam}',"
    elif b.get("font_stack"):
        # Named but not self-hosted (a system or Google font). Naming it still
        # helps if the render host happens to have it installed.
        font_stack = b["font_stack"].split(",")[0].strip() + ","

    # BRAND STYLESHEET
    # A preset may carry its own CSS file, appended INSIDE the template's
    # <style> so it overrides everything above it. That is how a brand whose
    # identity is not "dark canvas, rounded card, accent-coloured label" gets
    # rendered by this skill without forking the shared template: the palette
    # lives in the preset, and so does the shape. Absent — which is every
    # existing preset — it substitutes to the empty string and nothing about
    # any other brand's render changes.
    brand_css = ""
    css_file = b.get("css_file") or c.get("css_file") or ""
    if css_file:
        base = Path(brand_path).parent if brand_path else Path(".")
        cp = Path(css_file) if Path(css_file).is_absolute() else base / css_file
        if cp.is_file():
            brand_css = cp.read_text(encoding="utf-8")
    if not brand_css:
        brand_css = c.get("extra_css") or b.get("extra_css") or ""

    accent_hex = c.get("accent") or b.get("accent") or "#22D3EE"

    # Readable text ON the accent, chosen from the accent's own luminance.
    def on_accent(hexcode: str) -> str:
        h = (hexcode or "").lstrip("#")
        if len(h) != 6:
            return "#FFFFFF"
        try:
            r, g, bl = (int(h[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            return "#FFFFFF"
        return "#0B1120" if (0.2126 * r + 0.7152 * g + 0.0722 * bl) > 150 else "#FFFFFF"

    required = ["headline", "left_title", "right_title", "left_items", "right_items"]
    missing = [k for k in required if not c.get(k)]
    if missing:
        sys.exit(f"content is missing required keys: {', '.join(missing)}")

    out = Path(template).read_text(encoding="utf-8")
    def items_html(values, kind):
        """Bullets for strings, message cards for objects.

        A bullet is a claim; a timestamped message with a status badge is
        evidence. Both shapes are supported so existing content files keep
        working — the object form is opt-in per campaign.
        """
        out = []
        for v in values:
            if isinstance(v, dict):
                badge = v.get("badge", "")
                out.append(
                    f'<li class="msg msg--{kind}">'
                    f'<div class="msg__head"><span class="msg__time">{esc(v.get("time", ""))}</span>'
                    + (f'<span class="msg__badge">{esc(badge)}</span>' if badge else "")
                    + f'</div><div class="msg__text">{esc(v.get("text", ""))}</div></li>'
                )
            else:
                mark = "\u2013" if kind == "bad" else "\u2713"
                out.append(
                    f'<li><span class="mark" aria-hidden="true">{mark}</span>'
                    f"<span>{esc(v)}</span></li>"
                )
        return "".join(out)

    status = "".join(
        f'<span class="pill">'
        + ('<span class="pill__dot"></span>' if p.get("dot") else "")
        + f'{esc(p.get("text", ""))}</span>'
        for p in (c.get("status_bar") or [])
    )

    mapping = {
        # First in the map, so tokens used INSIDE the brand stylesheet
        # ({{ACCENT}}, {{BG_FROM}} …) still resolve on the passes that follow.
        # Not esc()'d: it is CSS from the preset, not copy from a model.
        "BRAND_CSS": brand_css,
        "SHAPE": shape,
        "MODE": esc(c.get("mode") or b.get("mode") or "dark"),
        "ON_ACCENT": on_accent(c.get("accent") or b.get("accent", "#22D3EE")),
        "EYEBROW": esc(c.get("eyebrow", "")),
        "HEADLINE": esc(c["headline"]),
        "SUBHEAD": esc(c.get("subhead", "")),
        "LEFT_TITLE": esc(c["left_title"]),
        "RIGHT_TITLE": esc(c["right_title"]),
        "LEFT_ITEMS": items_html(c["left_items"], "bad"),
        "RIGHT_ITEMS": items_html(c["right_items"], "good"),
        "STATUS_BAR": status,
        # Frame stepping for the GIF pipeline. Defaults leave the animation
        # running normally, which is what the live page and static PNGs want.
        "FRAME_DELAY": esc(c.get("_frame_delay") or "0s"),
        "ANIM_STATE": esc(c.get("_anim_state") or "running"),
        "REVEAL": esc(c.get("_reveal") or "off"),
        "LEFT_STAT": esc(c.get("left_stat", "")),
        "LEFT_STAT_NOTE": esc(c.get("left_stat_note", "")),
        "RIGHT_STAT": esc(c.get("right_stat", "")),
        "RIGHT_STAT_NOTE": esc(c.get("right_stat_note", "")),
        "BRAND": esc(shown_name),
        "BADGE": esc(badge),
        "BRANDMARK": brandmark,
        # Not esc()'d: FONT_FACE is CSS we generated, not user text.
        "FONT_FACE": font_face,
        "FONT_STACK": font_stack,
        "ACCENT_LIGHT": esc(c.get("accent_light") or b.get("accent_light") or c.get("accent") or b.get("accent", "#67E8F9")),
        "ACCENT": esc(accent_hex),
        "ACCENT2": esc(c.get("accent_2") or b.get("accent_2", "#3B82F6")),
        "BG_FROM": esc(c.get("bg_from") or b.get("bg_from") or tint(accent_hex, 22)),
        "BG_TO": esc(c.get("bg_to") or b.get("bg_to") or tint(accent_hex, 34)),
        "CTA": esc(c.get("cta", "")),
        # Capture-page tokens. Harmless in the infographic template, which
        # simply has no placeholders for them.
        "BENEFITS": "".join(
            f'<li><span class="tick" aria-hidden="true">✓</span><span>{esc(v)}</span></li>'
            for v in c.get("benefits", [])
        ),
        "FORM_TITLE": esc(c.get("form_title", "Get the guide")),
        "FORM_BLURB": esc(c.get("form_blurb", "")),
        "FIELD_LABEL": esc(c.get("field_label", "Your WhatsApp number")),
        "FIELD_NAME": esc(c.get("field_name", "whatsapp")),
        "FIELD_TYPE": esc(c.get("field_type", "tel")),
        "FIELD_INPUTMODE": esc(c.get("field_inputmode", "tel")),
        "FIELD_PLACEHOLDER": esc(c.get("field_placeholder", "")),
        "FIELD_AUTOCOMPLETE": esc(c.get("field_autocomplete", "tel")),
        "CTA_BUTTON": esc(c.get("cta_button", "Send it to me")),
        "PRIVACY_NOTE": esc(c.get("privacy_note", "")),
        # Both of these are substituted into JS string literals, never into
        # markup — see jsesc().
        "SUCCESS_MESSAGE": jsesc(c.get("success_message", "Sent.")),
        "FORM_ENDPOINT": jsesc(c.get("form_endpoint", "")),
        "CAMPAIGN_ID": esc(c.get("campaign_id", "campaign")),
        "OG_IMAGE": esc(c.get("og_image", "")),
    }
    for token, value in mapping.items():
        out = out.replace("{{" + token + "}}", value)
    sys.stdout.write(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
