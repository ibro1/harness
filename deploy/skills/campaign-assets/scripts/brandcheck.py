#!/usr/bin/env python3
"""Check campaign copy against a brand's voice rules.

The rules live in the BRAND preset, not in this file. That distinction is the
whole point: an earlier version hardcoded FrontStaff's rules, including a ban
on dollar prices — which would have failed a perfectly valid graphic for any
product that happens to price in dollars or euros. A checker that rejects
correct work is worse than no checker, because it trains you to skip it.

Usage: brandcheck.py <brand.json> <content.json>
Exit 1 if any forbidden pattern matches.
"""
import json
import re
import sys
from pathlib import Path

# Fields that end up as visible copy. Deliberately not everything:
# field_placeholder ("+234 801 234 5678") is UI furniture, not a claim.
COPY_FIELDS = (
    "headline", "subhead", "eyebrow", "cta", "kicker",
    "left_stat", "left_stat_note", "right_stat", "right_stat_note",
    "form_title", "form_blurb", "privacy_note",
)
LIST_FIELDS = ("left_points", "right_points", "benefits", "bullets", "points")

# A number attached to a unit is a claim about the world. A number that is not
# — "3 steps", a phone number — is not.
CLAIM_RE = re.compile(
    r"(?:[₦$€£]\s?\d[\d,]*(?:\.\d+)?"
    r"|\d+(?:[.,]\d+)?\s?%"
    r"|\d+(?:[.,]\d+)?\s?x\b"
    r"|\b\d+(?:[.,]\d+)?\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?|days?|weeks?|months?|years?)\b)",
    re.IGNORECASE,
)
IDIOMS = re.compile(r"24/7|365 days|9\s*-\s*5", re.IGNORECASE)


def collect_claims(c: dict):
    """Every numeric claim in the visible copy, with the field it came from."""
    found = []
    for f in COPY_FIELDS:
        v = c.get(f)
        if isinstance(v, str):
            for m in CLAIM_RE.finditer(v):
                if not IDIOMS.search(v[max(0, m.start() - 4):m.end() + 4]):
                    found.append((m.group(0).strip(), f, v))
    for f in LIST_FIELDS:
        for item in c.get(f, []) or []:
            s = item if isinstance(item, str) else (item.get("text", "") if isinstance(item, dict) else "")
            for m in CLAIM_RE.finditer(s):
                if not IDIOMS.search(s[max(0, m.start() - 4):m.end() + 4]):
                    found.append((m.group(0).strip(), f, s))
    return found


def check_claims(content_path: Path) -> bool:
    """Require a source for every number that will be published.

    WHY THIS EXISTS
    Earlier drafts of the FrontStaff graphic carried "9 hours to first reply"
    and a ₦3,500 Lekki delivery price. Both were invented by the agent writing
    the copy. Neither was flagged, because nothing in the pipeline had an
    opinion about truth — only about colour and phrasing.

    That got MORE dangerous as the design improved, not less: a guess set in the
    brand's real typeface on the brand's real purple reads as measured fact. The
    skill was becoming a machine for laundering invention into confident
    marketing, and the better it looked the better it laundered.

    A source of "illustrative" is accepted and loudly reported. The goal is not
    to ban examples — it is to make the choice explicit to whoever presses
    publish, rather than letting a placeholder quietly become a claim.
    """
    c = json.loads(content_path.read_text(encoding="utf-8"))
    claims = collect_claims(c)
    if not claims:
        return True

    sources = c.get("sources") or {}
    print("claims check:", flush=True)
    missing, illustrative = [], []

    for value, field, context in claims:
        src = None
        for key, s in sources.items():
            if key.strip().lower() in context.lower() or value.lower() in key.lower():
                src = s
                break
        if src is None:
            missing.append((value, field, context))
        elif str(src).strip().lower() in ("illustrative", "example", "hypothetical"):
            illustrative.append((value, field))
        else:
            print(f'  ✓ "{value}" ({field}) — {str(src)[:60]}', flush=True)

    for value, field in illustrative:
        print(f'  ⚠ "{value}" ({field}) — ILLUSTRATIVE. Do not present as measured.',
              file=sys.stderr)

    if missing:
        for value, field, context in missing:
            print(f'  ✗ "{value}" in {field} has no source', file=sys.stderr)
            print(f'      …{context.strip()[:76]}…', file=sys.stderr)
        print('  ✗ add a "sources" map to the content file. Each key is text from the'
              '\n    copy; each value is a URL, a note on how it was measured, or'
              '\n    "illustrative" if it is a worked example.', file=sys.stderr)
        return False
    return True


def main() -> int:
    brand = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    raw = Path(sys.argv[2]).read_text(encoding="utf-8")

    forbid = brand.get("forbid") or []
    require = brand.get("require")
    label = brand.get("name") or "brand"

    # Claims are checked even when the brand has no voice rules. Truth is not a
    # brand preference, and a generic brand file must not buy an exemption.
    claims_ok = check_claims(Path(sys.argv[2]))

    if not forbid and not require:
        print(f"brand check: no voice rules for {label} — skipped")
        return 0 if claims_ok else 1

    print("brand check:", flush=True)
    failed = not claims_ok

    for rule in forbid:
        pattern = rule.get("pattern")
        if not pattern:
            continue
        for m in re.finditer(pattern, raw, re.IGNORECASE):
            failed = True
            start, end = max(0, m.start() - 35), min(len(raw), m.end() + 35)
            print(f'  ✗ "{m.group(0)}" — {rule.get("why", "not allowed")}', file=sys.stderr)
            print(f"      …{raw[start:end].strip()}…", file=sys.stderr)
            break  # one example per rule is enough to act on

    if require and require.get("pattern"):
        if not re.search(require["pattern"], raw, re.IGNORECASE):
            # A note, not a failure: copy can be correct without hitting the
            # exact phrase, and a hard failure here would be a style tax.
            print(f'  · note: copy never says the required phrase — {require.get("why", "")}',
                  file=sys.stderr)

    if failed:
        print("  ✗ fix the copy before publishing", file=sys.stderr)
        return 1
    print(f"  ✓ {label} voice rules pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
