#!/usr/bin/env python3
"""Download a video, its audio, or its transcript from a URL (YouTube et al.).

YouTube bot-gates datacenter IPs, so a bare yt-dlp call fails with "Sign in to
confirm you're not a bot". The only combination that works here is account
cookies + a Node JS runtime + the `mweb` client (NO bgutil server, NO WARP):

    yt-dlp --cookies <jar> --js-runtimes node \
           --extractor-args "youtube:player_client=mweb" ...

`mweb` is the only client that works with cookies (`default`/`tv` -> "page needs
to be reloaded"; `web`/`ios`/`android` -> "format not available"). Node is in the
image. Cookies must be FRESH — staleness is age-based, not per-use.

Cookie resolution order (nothing secret is hardcoded):
  1. $YT_COOKIES_FILE  — path to a Netscape cookies.txt
  2. $YT_COOKIES_URL   — fetched with `Authorization: Bearer $YT_COOKIES_TOKEN`
                         (the DeerFlow /yt/cookies.txt endpoint in the container)
  3. /mnt/shared/yt-cookie-export/youtube-cookies.txt  (local dev default)

Usage:
    download.py <url>                       # full video -> <cwd>/edit/downloads
    download.py <url> --mode audio          # bestaudio -> m4a
    download.py <url> --mode transcript     # auto-subs (vtt), no media
    download.py <url> -o /some/dir
"""

from __future__ import annotations

import argparse
import glob
import os
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

LOCAL_DEFAULT = "/mnt/shared/yt-cookie-export/youtube-cookies.txt"


def resolve_cookies() -> tuple[str, bool]:
    """Return (path, is_temp); exit with guidance if no jar can be found."""
    explicit = os.environ.get("YT_COOKIES_FILE", "").strip()
    if explicit:
        if not Path(explicit).exists():
            sys.exit(f"YT_COOKIES_FILE set but not found: {explicit}")
        return explicit, False

    url = os.environ.get("YT_COOKIES_URL", "").strip()
    if url:
        token = os.environ.get("YT_COOKIES_TOKEN", "").strip()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30).read()
        except Exception as error:
            sys.exit(f"could not fetch cookies from YT_COOKIES_URL: {error}")
        if not data.strip():
            sys.exit("YT_COOKIES_URL returned an empty cookie jar")
        tmp = tempfile.NamedTemporaryFile("wb", suffix=".txt", delete=False)
        tmp.write(data)
        tmp.close()
        return tmp.name, True

    if Path(LOCAL_DEFAULT).exists():
        return LOCAL_DEFAULT, False

    sys.exit(
        "no YouTube cookies available. Set YT_COOKIES_URL (+ YT_COOKIES_TOKEN) to the "
        "DeerFlow cookie endpoint, or YT_COOKIES_FILE to a cookies.txt path."
    )


def ffprobe_duration(path: str) -> float | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True, text=True,
        )
        return float(out.stdout.strip())
    except Exception:
        return None


def main() -> None:
    ap = argparse.ArgumentParser(description="Download video/audio/transcript from a URL via yt-dlp")
    ap.add_argument("url")
    ap.add_argument("--mode", choices=["video", "audio", "transcript"], default="video")
    ap.add_argument("-o", "--out-dir", default=None, help="Default: <cwd>/edit/downloads")
    args = ap.parse_args()

    out_dir = Path(args.out_dir).resolve() if args.out_dir else (Path.cwd() / "edit" / "downloads")
    out_dir.mkdir(parents=True, exist_ok=True)

    cookies, is_temp = resolve_cookies()
    base = [
        "yt-dlp", "--cookies", cookies, "--js-runtimes", "node",
        "--extractor-args", "youtube:player_client=mweb",
        "--no-playlist", "--retries", "20", "--fragment-retries", "20", "--continue",
    ]
    try:
        if args.mode == "transcript":
            cmd = base + [
                "--skip-download", "--write-auto-sub", "--write-sub",
                "--sub-lang", "en.*", "--sub-format", "vtt",
                "-o", str(out_dir / "%(id)s"), args.url,
            ]
            subprocess.run(cmd, check=True)
            subs = sorted(glob.glob(str(out_dir / "*.vtt")))
            if not subs:
                sys.exit("no subtitles found for this video — try --mode audio and transcribe it instead")
            for s in subs:
                print(f"transcript: {s}")
            return

        outtmpl = str(out_dir / "%(title).80s [%(id)s].%(ext)s")
        if args.mode == "audio":
            cmd = base + ["-f", "bestaudio/best", "-x", "--audio-format", "m4a", "-o", outtmpl, args.url]
            wanted = (".m4a", ".mp3", ".webm", ".opus")
        else:
            cmd = base + ["-f", "bv*+ba/b", "--merge-output-format", "mp4", "-o", outtmpl, args.url]
            wanted = (".mp4", ".mkv", ".webm")
        subprocess.run(cmd, check=True)

        newest = None
        for p in sorted(out_dir.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True):
            if p.suffix.lower() in wanted:
                newest = p
                break
        if newest is None:
            print(f"downloaded into {out_dir} (see files)")
            return
        dur = ffprobe_duration(str(newest))
        size_mb = newest.stat().st_size / (1024 * 1024)
        print(f"downloaded: {newest}  ({size_mb:.1f} MB" + (f", {dur:.1f}s)" if dur else ")"))
    finally:
        if is_temp:
            try:
                os.unlink(cookies)
            except Exception:
                pass


if __name__ == "__main__":
    main()
