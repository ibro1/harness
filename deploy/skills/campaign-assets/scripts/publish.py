#!/usr/bin/env python3
"""Publish a built graphic to your own LinkedIn feed.

    publish.py auth                                  one-time, opens the OAuth dance
    publish.py post <image.png> [--text-from c.json] [--text "..."] [--yes]
    publish.py whoami                                check the saved token

SCOPE AND LIMITS
This uses `w_member_social`, the self-serve "Share on LinkedIn" product. It
posts as YOU, to YOUR OWN feed. It cannot post to a company page (that needs
Community Management approval), and no LinkedIn API at any tier can send
connection requests, DMs, or search profiles.

WHY THE TOKEN LIVES OUTSIDE THE REPO
Access tokens last 60 days and are bearer credentials for your identity —
anyone holding one can post as you. They are written to ~/.config with mode
600, never into the skill directory, because the skill directory is now a git
repo with a GitHub remote and a leaked token there is a published token.

REFRESH
Refresh tokens are not granted on the self-serve tier, so this expires after 60
days and you re-run `auth`. That is a LinkedIn policy, not an omission here.
"""
import argparse
import json
import os
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization"
TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
API = "https://api.linkedin.com"
SCOPES = "openid profile w_member_social"
# Marketing API calls are versioned and each version is supported for one year,
# so an integration built today has a hard expiry. Override when it lapses.
LI_VERSION = os.environ.get("LINKEDIN_VERSION", "202608")

CFG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "campaign-assets"
TOKEN_FILE = CFG_DIR / "linkedin.json"


def die(msg: str, code: int = 1):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(code)


def req(url: str, data=None, headers=None, method=None, raw_body=None):
    """One HTTP call. Returns (status, parsed_json_or_bytes)."""
    h = {"User-Agent": "campaign-assets/1.0"}
    h.update(headers or {})
    body = raw_body
    if data is not None and raw_body is None:
        body = json.dumps(data).encode()
        h.setdefault("Content-Type", "application/json")
    r = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            payload = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if "json" in ctype:
                return resp.status, json.loads(payload or b"{}")
            return resp.status, payload
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        return e.code, {"_error": detail}


def load_token():
    if not TOKEN_FILE.is_file():
        die(f"not authorised yet — run:  publish.py auth\n       (no token at {TOKEN_FILE})")
    return json.loads(TOKEN_FILE.read_text())


def save_token(d: dict):
    CFG_DIR.mkdir(parents=True, exist_ok=True)
    # Store the ABSOLUTE expiry, not just the duration. Recording only
    # expires_in (a number of seconds) makes it impossible to answer "how long
    # have I got" later — which is the only question that matters for a cron
    # job that will otherwise die silently on day 61.
    d = dict(d)
    d["obtained_at"] = int(time.time())
    if d.get("expires_in"):
        d["expires_at"] = int(time.time()) + int(d["expires_in"])
    TOKEN_FILE.write_text(json.dumps(d, indent=2))
    # 600: this is a bearer credential for your LinkedIn identity.
    TOKEN_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)


def days_left(t: dict):
    """Days until the token dies, or None if we cannot tell."""
    if not t.get("expires_at"):
        return None
    return (int(t["expires_at"]) - int(time.time())) / 86400.0


def cmd_auth(args) -> int:
    cid = os.environ.get("LINKEDIN_CLIENT_ID")
    secret = os.environ.get("LINKEDIN_CLIENT_SECRET")
    redirect = os.environ.get("LINKEDIN_REDIRECT_URI", "http://localhost:8000/callback")
    if not cid or not secret:
        die("set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET first.\n"
            "       Create an app at https://www.linkedin.com/developers/apps ,\n"
            "       add the 'Share on LinkedIn' and 'Sign In with LinkedIn' products,\n"
            f"       and register this redirect URL exactly: {redirect}")

    q = urllib.parse.urlencode({
        "response_type": "code", "client_id": cid, "redirect_uri": redirect,
        "scope": SCOPES, "state": "campaign-assets",
    # quote, not the default quote_plus: LinkedIn's documented examples separate
    # scopes with %20 and their authorize endpoint has been picky about '+'.
    }, quote_via=urllib.parse.quote)
    print("1. Open this URL in a browser signed in as you:\n")
    print(f"   {AUTH_URL}?{q}\n")
    print("2. Approve. The browser will fail to load a page — that is expected,")
    print("   nothing is listening on that port. Copy the FULL URL from the address")
    print("   bar; it contains ?code=...\n")
    pasted = input("3. Paste that URL (or just the code): ").strip()

    code = pasted
    if "code=" in pasted:
        code = urllib.parse.parse_qs(urllib.parse.urlparse(pasted).query).get("code", [""])[0]
    if not code:
        die("no code found in what you pasted")

    status, tok = req(TOKEN_URL, raw_body=urllib.parse.urlencode({
        "grant_type": "authorization_code", "code": code, "client_id": cid,
        "client_secret": secret, "redirect_uri": redirect,
    }).encode(), headers={"Content-Type": "application/x-www-form-urlencoded"})
    if status != 200 or "access_token" not in tok:
        die(f"token exchange failed ({status}): {tok}")

    status, who = req(f"{API}/v2/userinfo",
                      headers={"Authorization": f"Bearer {tok['access_token']}"})
    if status != 200 or "sub" not in who:
        die(f"could not read your profile ({status}): {who}")

    save_token({
        "access_token": tok["access_token"],
        "expires_in": tok.get("expires_in"),
        "person_urn": f"urn:li:person:{who['sub']}",
        "name": who.get("name", ""),
    })
    days = int(tok.get("expires_in", 0)) // 86400
    print(f"\nauthorised as {who.get('name','(unknown)')}")
    print(f"  token saved to {TOKEN_FILE} (mode 600)")
    print(f"  valid ~{days} days — self-serve tier gets no refresh token, so re-run auth then")
    return 0


def cmd_whoami(args) -> int:
    t = load_token()
    status, who = req(f"{API}/v2/userinfo",
                      headers={"Authorization": f"Bearer {t['access_token']}"})
    if status != 200:
        die(f"token rejected ({status}) — re-run: publish.py auth\n       {who}")
    print(f"authorised as {who.get('name','(unknown)')}  [{t['person_urn']}]")
    return 0


def upload_image(token: str, owner: str, path: Path) -> str:
    """Register, PUT the bytes, return the image URN.

    Three steps in a fixed order. Getting it wrong returns a 4xx that does not
    say which step was wrong, so each is checked separately here.
    """
    h = {"Authorization": f"Bearer {token}", "LinkedIn-Version": LI_VERSION,
         "X-Restli-Protocol-Version": "2.0.0"}
    status, init = req(f"{API}/rest/images?action=initializeUpload",
                       data={"initializeUploadRequest": {"owner": owner}}, headers=h)
    if status not in (200, 201) or "value" not in init:
        die(f"image upload could not be registered ({status}): {init}")
    up_url = init["value"]["uploadUrl"]
    urn = init["value"]["image"]

    status, resp = req(up_url, raw_body=path.read_bytes(), method="PUT",
                       headers={"Authorization": f"Bearer {token}"})
    if status not in (200, 201):
        die(f"image bytes rejected ({status}): {resp}")
    return urn


def cmd_post(args) -> int:
    t = load_token()
    img = Path(args.image)
    if not img.is_file():
        die(f"no such image: {img}")

    text = args.text or ""
    if args.text_from:
        c = json.loads(Path(args.text_from).read_text(encoding="utf-8"))
        text = c.get("post_text") or c.get("headline") or ""
        if c.get("subhead") and c.get("post_text") is None:
            text = f"{text}\n\n{c['subhead']}"
    if not text.strip():
        die("nothing to say — pass --text or --text-from a content file with post_text")

    print(f"posting as : {t.get('name','(unknown)')}")
    print(f"image      : {img.name}  ({img.stat().st_size / 1e6:.2f}MB)")
    print(f"text       : {text[:180]}{'…' if len(text) > 180 else ''}")
    print(f"visibility : PUBLIC")
    if not args.yes:
        # Publishing is public and immediate. A typo here is visible to every
        # connection before it can be deleted.
        if input("\npublish now? [y/N] ").strip().lower() not in ("y", "yes"):
            print("cancelled")
            return 0

    urn = upload_image(t["access_token"], t["person_urn"], img)
    h = {"Authorization": f"Bearer {t['access_token']}", "LinkedIn-Version": LI_VERSION,
         "X-Restli-Protocol-Version": "2.0.0"}
    status, resp = req(f"{API}/rest/posts", headers=h, data={
        "author": t["person_urn"],
        "commentary": text,
        "visibility": "PUBLIC",
        "distribution": {"feedDistribution": "MAIN_FEED",
                         "targetEntities": [], "thirdPartyDistributionChannels": []},
        "content": {"media": {"id": urn, "title": args.title or ""}},
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    })
    if status not in (200, 201):
        die(f"post rejected ({status}): {resp}")

    post_id = (resp or {}).get("id") if isinstance(resp, dict) else None
    print("\npublished.")
    if post_id:
        print(f"  {post_id}")
        print(f"  https://www.linkedin.com/feed/update/{post_id}/")
    return 0


QUEUE_FILE = CFG_DIR / "queue.json"


def read_queue():
    return json.loads(QUEUE_FILE.read_text()) if QUEUE_FILE.is_file() else []


def write_queue(q):
    CFG_DIR.mkdir(parents=True, exist_ok=True)
    QUEUE_FILE.write_text(json.dumps(q, indent=2))


def cmd_check(args) -> int:
    """Is this thing still going to work tomorrow?

    Exists to be run by cron BEFORE the token dies. The failure mode otherwise
    is the worst kind: a scheduled job that has been quietly posting nothing
    since day 61, discovered weeks later when someone asks why the feed is dry.
    Exit 1 when action is needed, so cron mails you.
    """
    t = load_token()
    d = days_left(t)
    if d is None:
        print("token expiry unknown — re-run auth to record it", file=sys.stderr)
        return 1
    if d <= 0:
        print(f"EXPIRED {abs(d):.0f} days ago — run: publish.py auth", file=sys.stderr)
        return 1
    if d <= args.warn_days:
        print(f"token expires in {d:.0f} days — run: publish.py auth", file=sys.stderr)
        return 1
    print(f"token valid for {d:.0f} more days ({t.get('name','')})")
    return 0


def cmd_queue(args) -> int:
    """Add a post to the queue, to be sent later by `drain`."""
    img = Path(args.image).resolve()
    if not img.is_file():
        die(f"no such image: {img}")
    text = args.text or ""
    if args.text_from:
        c = json.loads(Path(args.text_from).read_text(encoding="utf-8"))
        text = c.get("post_text") or c.get("headline") or ""
        if c.get("subhead") and c.get("post_text") is None:
            text = f"{text}\n\n{c['subhead']}"
    if not text.strip():
        die("nothing to say — pass --text or --text-from")

    when = int(time.time())
    if args.at:
        # Accepts "2026-09-08 09:30" local time.
        import datetime
        try:
            when = int(datetime.datetime.strptime(args.at, "%Y-%m-%d %H:%M").timestamp())
        except ValueError:
            die('--at must look like "2026-09-08 09:30"')

    q = read_queue()
    q.append({"image": str(img), "text": text, "title": args.title or "",
              "due": when, "state": "pending"})
    write_queue(q)
    print(f"queued for {time.strftime('%Y-%m-%d %H:%M', time.localtime(when))} "
          f"({len([x for x in q if x['state'] == 'pending'])} pending)")
    return 0


def cmd_drain(args) -> int:
    """Publish everything that is due. This is the cron entry point.

    One cron line drains the whole queue, rather than one cron line per post.
    Posts that fail are marked and kept, not silently dropped — a queue that
    loses work quietly is worse than no queue.
    """
    q = read_queue()
    due = [x for x in q if x["state"] == "pending" and x["due"] <= time.time()]
    if not due:
        print(f"nothing due ({len([x for x in q if x['state'] == 'pending'])} pending)")
        return 0

    t = load_token()
    d = days_left(t)
    if d is not None and d <= 0:
        print("token expired — run: publish.py auth", file=sys.stderr)
        return 1

    failures = 0
    for item in due:
        img = Path(item["image"])
        if not img.is_file():
            item["state"] = "failed"
            item["error"] = "image no longer exists"
            failures += 1
            continue
        try:
            urn = upload_image(t["access_token"], t["person_urn"], img)
            h = {"Authorization": f"Bearer {t['access_token']}",
                 "LinkedIn-Version": LI_VERSION, "X-Restli-Protocol-Version": "2.0.0"}
            status, resp = req(f"{API}/rest/posts", headers=h, data={
                "author": t["person_urn"], "commentary": item["text"],
                "visibility": "PUBLIC",
                "distribution": {"feedDistribution": "MAIN_FEED",
                                 "targetEntities": [], "thirdPartyDistributionChannels": []},
                "content": {"media": {"id": urn, "title": item.get("title", "")}},
                "lifecycleState": "PUBLISHED", "isReshareDisabledByAuthor": False,
            })
            if status in (200, 201):
                item["state"] = "sent"
                item["post_id"] = (resp or {}).get("id") if isinstance(resp, dict) else None
                item["sent_at"] = int(time.time())
                print(f"sent: {img.name} -> {item.get('post_id') or 'ok'}")
            else:
                item["state"] = "failed"
                item["error"] = f"{status}: {resp}"
                failures += 1
                print(f"FAILED: {img.name} ({status})", file=sys.stderr)
        except SystemExit as e:
            item["state"] = "failed"
            item["error"] = str(e)
            failures += 1

    write_queue(q)
    if d is not None and d <= 7:
        print(f"warning: token expires in {d:.0f} days — run: publish.py auth", file=sys.stderr)
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("auth").set_defaults(fn=cmd_auth)
    sub.add_parser("whoami").set_defaults(fn=cmd_whoami)
    p = sub.add_parser("post")
    p.add_argument("image")
    p.add_argument("--text", default=None)
    p.add_argument("--text-from", default=None, help="content.json with a post_text field")
    p.add_argument("--title", default=None, help="alt/title for the image")
    p.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    p.set_defaults(fn=cmd_post)

    ch = sub.add_parser("check", help="exit 1 if the token needs renewing")
    ch.add_argument("--warn-days", type=int, default=7)
    ch.set_defaults(fn=cmd_check)

    qp = sub.add_parser("queue", help="schedule a post for later")
    qp.add_argument("image")
    qp.add_argument("--text", default=None)
    qp.add_argument("--text-from", default=None)
    qp.add_argument("--title", default=None)
    qp.add_argument("--at", default=None, help='"2026-09-08 09:30" (default: now)')
    qp.set_defaults(fn=cmd_queue)

    dr = sub.add_parser("drain", help="publish everything due — the cron entry point")
    dr.set_defaults(fn=cmd_drain)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
