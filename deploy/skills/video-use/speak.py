"""Generate speech (TTS) — provider-agnostic, cached, CLI-invokable.

Mirrors transcribe.py: reads keys from the video-use `.env` (or the environment),
caches so a rerun never re-bills, and prints the duration of what it made.

Providers
    gemini      Google Gemini Flash TTS. Accent, tone and PACE come from a natural-
                language style instruction prefixed to the text — there is no accent,
                voice-style, or speed parameter. This is how you get a Nigerian (or any)
                accent: ask for it in --style. Default.
    elevenlabs  ElevenLabs TTS (the voice used elsewhere in this skill).

Both write a mono 16-bit WAV *stem* (not MP3 — these are for mixing) into a cache dir,
named by a hash of (provider, model, voice, style, text). Identical inputs reuse the
cached stem instead of re-billing.

Gemini is AUDIO-LED: you cannot ask for a duration or a speed. Generate the voice,
measure it (this script prints the duration), THEN cut the picture to fit. If a line
overruns its slot, shorten the copy and regenerate — never time-stretch the voice.

Usage
    # Gemini, Nigerian-accent advertising read (key in .env as GEMINI_API_KEY):
    python helpers/speak.py "Your best salesperson never sleeps." \
        --style "Read aloud in a warm Nigerian accent, as a polished radio advertisement. \
Warm and dignified, with a brisk advertising pace — no dawdling." \
        --voice Orus -o edit/vo/line1.wav

    python helpers/speak.py --file script.txt --provider gemini --voice Kore -o out.wav
    python helpers/speak.py "Hello." --provider elevenlabs --voice TX3LPaxmHKxFdv7VOQHJ -o out.wav
    python helpers/speak.py "Hi." -o out.wav --normalize      # loudnorm every stem to -18 LUFS
    python helpers/speak.py "Hi." -o out.wav --verify         # round-trip through Scribe to check pronunciation
    python helpers/speak.py --list-voices
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import os
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import requests


GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
ELEVEN_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice}"

DEFAULTS = {
    "gemini": {"model": "gemini-3.1-flash-tts-preview", "voice": "Orus"},
    # Liam — "Energetic, Social Media Creator". Multilingual model handles many accents.
    "elevenlabs": {"model": "eleven_multilingual_v2", "voice": "TX3LPaxmHKxFdv7VOQHJ"},
}

# A pace instruction is mandatory for anything timed: Gemini reads ~40% slower than
# ElevenLabs by default. This is only used when --style is omitted; a real project
# should pass an explicit style (accent + tone + pace).
DEFAULT_STYLE = (
    "Read aloud in a clear, warm voice at a brisk, natural advertising pace — no dawdling.\n\n"
)

# A representative slice of Gemini's prebuilt voices (there is no African-accent voice —
# get the accent from --style, not from here).
GEMINI_VOICES = [
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
    "Callirrhoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina",
    "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Schedar",
    "Gacrux", "Achird", "Sadaltager", "Sulafat",
]


def load_key(names: list[str]) -> str | None:
    """First matching key from the video-use .env, then the environment. None if absent."""
    for candidate in [Path(__file__).resolve().parent.parent / ".env", Path(".env")]:
        if candidate.exists():
            for line in candidate.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() in names:
                    return v.strip().strip('"').strip("'")
    for n in names:
        if os.environ.get(n):
            return os.environ[n]
    return None


def warn_key_shape(key: str) -> None:
    """Gemini keys start 'AIzaSy' and are 39 chars. An 'AQ.' key is a short-lived
    AI Studio web-session token that authenticates now and expires within hours."""
    if key.startswith("AQ."):
        print("  WARNING: this looks like a short-lived AI Studio session token (starts "
              "'AQ.'); it will expire within hours. Use a real API key (starts 'AIzaSy', "
              "39 chars) for a pipeline.", file=sys.stderr)
    elif not (key.startswith("AIzaSy") and len(key) == 39):
        print("  WARNING: this does not look like a standard Gemini API key "
              "(expected 'AIzaSy…', 39 chars). Proceeding anyway.", file=sys.stderr)


def write_wav(pcm: bytes, rate: int, out_path: Path, channels: int = 1, sampwidth: int = 2) -> None:
    """Wrap raw little-endian PCM in a WAV header — Gemini and ElevenLabs both return
    headerless PCM."""
    with wave.open(str(out_path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(sampwidth)
        w.setframerate(rate)
        w.writeframes(pcm)


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def synth_gemini(text: str, key: str, model: str, voice: str, style: str,
                 timeout: int = 300, max_retries: int = 4, verbose: bool = True) -> tuple[bytes, int]:
    """Returns (raw PCM bytes, sample rate). Retries 429 (per-minute, not a daily cap)."""
    url = GEMINI_URL.format(model=model)
    body = {
        "contents": [{"parts": [{"text": style + text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }
    for attempt in range(max_retries):
        # x-goog-api-key, NOT "Authorization: Bearer" (that returns 401
        # API_KEY_SERVICE_BLOCKED).
        resp = requests.post(
            url,
            headers={"x-goog-api-key": key, "Content-Type": "application/json"},
            json=body,
            timeout=timeout,
        )
        if resp.status_code == 429:
            if attempt == max_retries - 1:
                raise RuntimeError("Gemini TTS: 429 rate-limited after retries "
                                   "(per-minute limit — space batch calls ~10s apart)")
            wait = 20 * (attempt + 1)
            if verbose:
                print(f"  429 rate-limited; retrying in {wait}s "
                      f"({attempt + 1}/{max_retries - 1})", file=sys.stderr, flush=True)
            time.sleep(wait)
            continue
        if resp.status_code != 200:
            raise RuntimeError(f"Gemini TTS returned {resp.status_code}: {resp.text[:500]}")

        data = resp.json()
        try:
            part = data["candidates"][0]["content"]["parts"][0]["inlineData"]
        except (KeyError, IndexError) as e:
            raise RuntimeError(f"Gemini TTS: no audio in response ({e}): {json.dumps(data)[:400]}")
        mime = part.get("mimeType", "")
        m = re.search(r"rate=(\d+)", mime)          # mime is "audio/l16; rate=24000; channels=1"
        rate = int(m.group(1)) if m else 24000
        return base64.b64decode(part["data"]), rate
    raise RuntimeError("Gemini TTS: exhausted retries")


def synth_elevenlabs(text: str, key: str, model: str, voice: str,
                     timeout: int = 300, verbose: bool = True) -> tuple[bytes, int]:
    """Returns (raw PCM bytes, 24000). pcm_24000 is headerless 16-bit mono PCM."""
    url = ELEVEN_URL.format(voice=voice) + "?output_format=pcm_24000"
    body = {
        "text": text,
        "model_id": model,
        "voice_settings": {"stability": 0.45, "similarity_boost": 0.8,
                           "style": 0.35, "use_speaker_boost": True},
    }
    resp = requests.post(url, headers={"xi-api-key": key, "Content-Type": "application/json"},
                         json=body, timeout=timeout)
    if resp.status_code != 200:
        raise RuntimeError(f"ElevenLabs TTS returned {resp.status_code}: {resp.text[:500]}")
    return resp.content, 24000


def normalize_lufs(path: Path, target: float = -18.0) -> None:
    """Loudness-normalize a stem in place (generated lines vary wildly — up to ~10 dB
    across takes from one voice; normalize before mixing or a line goes inaudible)."""
    tmp = path.with_suffix(".norm.wav")
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(path),
         "-af", f"loudnorm=I={target}:TP=-1.5:LRA=11",
         "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", str(tmp)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    tmp.replace(path)


def verify_pronunciation(wav: Path, expected: str) -> None:
    """Round-trip the stem through transcribe.py (Scribe) and print what came back, so
    mangled proper nouns surface without anyone listening."""
    script = Path(__file__).resolve().parent / "transcribe.py"
    with tempfile.TemporaryDirectory() as tmp:
        r = subprocess.run([sys.executable, str(script), str(wav), "--edit-dir", tmp],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(f"  verify: transcription failed: {r.stderr.strip()[:300]}", file=sys.stderr)
            return
        js = next(Path(tmp).glob("transcripts/*.json"), None)
        if not js:
            print("  verify: no transcript produced", file=sys.stderr)
            return
        heard = json.loads(js.read_text()).get("text", "").strip()
        print(f"  verify — expected: {expected.strip()!r}")
        print(f"  verify — heard   : {heard!r}")


def cache_key(provider: str, model: str, voice: str, style: str, text: str) -> str:
    return hashlib.sha256("|".join([provider, model, voice, style, text]).encode()).hexdigest()[:16]


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate speech (TTS), provider-agnostic and cached")
    ap.add_argument("text", nargs="?", help="Text to speak (or use --file)")
    ap.add_argument("--file", type=Path, help="Read the text from this file instead of the argument")
    ap.add_argument("--provider", choices=["gemini", "elevenlabs"], default="gemini")
    ap.add_argument("--model", default=None, help="Override the provider's default model")
    ap.add_argument("--voice", default=None, help="Voice name (Gemini) or voice_id (ElevenLabs)")
    ap.add_argument("--style", default=None,
                    help="Gemini only: natural-language accent/tone/PACE instruction prefixed "
                         "to the text. ALWAYS include a pace note for timed lines.")
    ap.add_argument("-o", "--output", type=Path, default=None,
                    help="Output WAV path (default: <cache-dir>/<hash>.wav)")
    ap.add_argument("--cache-dir", type=Path, default=None,
                    help="Where hash-named stems live (default: alongside --output, else ./tts_cache)")
    ap.add_argument("--normalize", action="store_true", help="Loudness-normalize the stem to -18 LUFS")
    ap.add_argument("--verify", action="store_true",
                    help="Round-trip through Scribe and print the recognized text")
    ap.add_argument("--no-cache", action="store_true", help="Regenerate even if a cached stem exists")
    ap.add_argument("--list-voices", action="store_true", help="Print Gemini prebuilt voice names and exit")
    args = ap.parse_args()

    if args.list_voices:
        print("Gemini prebuilt voices (accent comes from --style, not the voice):")
        print("  " + ", ".join(GEMINI_VOICES))
        return

    text = (args.file.read_text() if args.file else args.text) or ""
    text = text.strip()
    if not text:
        sys.exit("no text: pass it as an argument or via --file")

    model = args.model or DEFAULTS[args.provider]["model"]
    voice = args.voice or DEFAULTS[args.provider]["voice"]
    # style only shapes Gemini; keep it in the cache key so a style change re-generates,
    # but never send it as spoken text to ElevenLabs.
    style = (args.style if args.style is not None else DEFAULT_STYLE) if args.provider == "gemini" else ""

    key = load_key(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GENAI_API_KEY"]) if args.provider == "gemini" \
        else load_key(["ELEVENLABS_API_KEY"])
    if not key:
        want = "GEMINI_API_KEY" if args.provider == "gemini" else "ELEVENLABS_API_KEY"
        sys.exit(f"{want} not found in {Path(__file__).resolve().parent.parent / '.env'} or environment")
    if args.provider == "gemini":
        warn_key_shape(key)

    key_hash = cache_key(args.provider, model, voice, style, text)
    cache_dir = (args.cache_dir or (args.output.parent if args.output else Path("tts_cache"))).resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{key_hash}.wav"
    out_path = (args.output or cache_file).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if cache_file.exists() and not args.no_cache:
        print(f"cached: {cache_file.name}")
    else:
        t0 = time.time()
        print(f"  {args.provider} · {model} · voice={voice} · {len(text)} chars", flush=True)
        if args.provider == "gemini":
            pcm, rate = synth_gemini(text, key, model, voice, style)
        else:
            pcm, rate = synth_elevenlabs(text, key, model, voice)
        write_wav(pcm, rate, cache_file)
        print(f"  generated {cache_file.name} ({rate} Hz) in {time.time() - t0:.1f}s")

    if out_path != cache_file:
        shutil.copyfile(cache_file, out_path)

    if args.normalize:
        normalize_lufs(out_path)
        print("  normalized to -18 LUFS")

    dur = wav_duration(out_path)
    print(f"  {out_path}  duration={dur:.2f}s")

    if args.verify:
        verify_pronunciation(out_path, text)


if __name__ == "__main__":
    main()
