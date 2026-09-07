"""Transcribe a video with a pluggable speech-to-text provider.

Fork-local overlay for the DeepSeek Harness deployment. Upstream ships an
ElevenLabs-Scribe-only transcriber; this version keeps Scribe and adds
OpenAI-compatible Whisper providers (Groq and OpenAI) so a free-tier key works
too. Every provider is normalized to the same JSON the rest of the skill reads
(`{"words": [{text, start, end, type, speaker_id}], ...}`), so nothing
downstream changes.

Provider selection, in order:
  1. --provider / TRANSCRIBE_PROVIDER  (elevenlabs | groq | openai)
  2. auto: first key present, preferring the free tier — GROQ_API_KEY, then
     OPENAI_API_KEY, then ELEVENLABS_API_KEY.

Capability note: only ElevenLabs Scribe returns speaker diarization and tagged
audio events (fillers). Whisper returns word-level timestamps but a single
speaker and no event tags — filler words survive as ordinary verbatim words,
which is what the skill's editorial rules want, but multi-speaker diarization
is lost. Use ElevenLabs (or a future Deepgram/AssemblyAI provider) when
per-speaker cutting matters.

Extracts mono 16kHz audio via ffmpeg. Scribe uploads the lossless wav; Whisper
uploads a small mono mp3 (the OpenAI/Groq 25MB request cap ~= 70 min at 48kbps).
Cached: if the output transcript already exists, the upload is skipped.

Usage:
    python helpers/transcribe.py <video_path>
    python helpers/transcribe.py <video_path> --provider groq
    python helpers/transcribe.py <video_path> --edit-dir /custom/edit
    python helpers/transcribe.py <video_path> --language en
    python helpers/transcribe.py <video_path> --num-speakers 2   # ElevenLabs only
    python helpers/transcribe.py <video_path> --audio-track 1
"""

from __future__ import annotations

import argparse
import array
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import requests


# ---- Providers -------------------------------------------------------------

SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text"

# name -> (env var holding its key, transcriber kind, OpenAI-compatible base
# URL + model for the whisper kind). The whisper kind covers every
# OpenAI-compatible /audio/transcriptions endpoint; add a row to support more.
PROVIDERS: dict[str, dict[str, str]] = {
    "elevenlabs": {"key_env": "ELEVENLABS_API_KEY", "kind": "scribe"},
    "groq": {
        "key_env": "GROQ_API_KEY", "kind": "whisper",
        "base_url": "https://api.groq.com/openai/v1", "model": "whisper-large-v3",
    },
    "openai": {
        "key_env": "OPENAI_API_KEY", "kind": "whisper",
        "base_url": "https://api.openai.com/v1", "model": "whisper-1",
    },
}

# Auto-detect order: free/generous tiers first, then paid, then Scribe.
AUTO_ORDER = ["groq", "openai", "elevenlabs"]

# OpenAI/Groq reject requests over 25MB; the mono mp3 stays far under that for
# normal clips, and we fail loudly rather than get a 413 mid-run.
WHISPER_MAX_UPLOAD_MB = 24.0


def load_env_key(var: str) -> str:
    """Read one key from the repo `.env` (repo root or cwd) or the environment."""
    for candidate in [Path(__file__).resolve().parent.parent / ".env", Path(".env")]:
        if candidate.exists():
            for line in candidate.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == var:
                    val = v.strip().strip('"').strip("'")
                    if val:
                        return val
    return os.environ.get(var, "").strip()


def resolve_provider(explicit: str | None) -> str:
    """Pick the provider from the flag, then env, then the first key present."""
    choice = explicit or os.environ.get("TRANSCRIBE_PROVIDER", "").strip().lower()
    if choice:
        if choice not in PROVIDERS:
            sys.exit(f"unknown provider {choice!r}; choose from {', '.join(PROVIDERS)}")
        if not load_env_key(PROVIDERS[choice]["key_env"]):
            sys.exit(f"provider {choice!r} selected but {PROVIDERS[choice]['key_env']} is not set")
        return choice
    for name in AUTO_ORDER:
        if load_env_key(PROVIDERS[name]["key_env"]):
            return name
    sys.exit(
        "no transcription key found. Set one of: "
        + ", ".join(PROVIDERS[n]["key_env"] for n in AUTO_ORDER)
        + " (Groq is free: https://console.groq.com/keys)"
    )


def count_audio_tracks(video_path: Path) -> int:
    """How many audio streams the container holds."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=index", "-of", "csv=p=0", str(video_path)],
        capture_output=True, text=True,
    )
    return len([ln for ln in out.stdout.splitlines() if ln.strip()])


def peak_dbfs(wav_path: Path) -> float:
    """Peak level of a 16-bit PCM wav, in dBFS. -inf for digital silence."""
    peak = 0
    with wave.open(str(wav_path), "rb") as w:
        while frames := w.readframes(1 << 16):
            samples = array.array("h", frames)
            peak = max(peak, max(samples), -min(samples))
    return 20 * math.log10(peak / 32768) if peak > 0 else float("-inf")


def extract_audio(video_path: Path, dest: Path, audio_track: int = 0) -> None:
    """Mono 16kHz 16-bit PCM wav — the lossless intermediate used for the peak
    check and for Scribe."""
    cmd = [
        "ffmpeg", "-y", "-i", str(video_path),
        "-map", f"0:a:{audio_track}",
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        str(dest),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wav_to_mp3(wav_path: Path, dest: Path) -> None:
    """Small mono mp3 for the Whisper upload cap. 48kbps is ample for 16kHz
    speech ASR and keeps ~70 min under the 25MB request limit."""
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(wav_path), "-ac", "1", "-c:a", "libmp3lame",
         "-b:a", "48k", str(dest)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def call_scribe(
    audio_path: Path,
    api_key: str,
    language: str | None = None,
    num_speakers: int | None = None,
) -> dict:
    """ElevenLabs Scribe: verbatim + diarize + audio events + word timestamps.
    Returns the raw Scribe JSON, which is already the schema the skill reads."""
    data: dict[str, str] = {
        "model_id": "scribe_v1",
        "diarize": "true",
        "tag_audio_events": "true",
        "timestamps_granularity": "word",
    }
    if language:
        data["language_code"] = language
    if num_speakers:
        data["num_speakers"] = str(num_speakers)

    with open(audio_path, "rb") as f:
        resp = requests.post(
            SCRIBE_URL,
            headers={"xi-api-key": api_key},
            files={"file": (audio_path.name, f, "audio/wav")},
            data=data,
            timeout=1800,
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Scribe returned {resp.status_code}: {resp.text[:500]}")
    return resp.json()


def call_whisper(
    audio_path: Path,
    api_key: str,
    base_url: str,
    model: str,
    language: str | None = None,
) -> dict:
    """OpenAI-compatible Whisper (OpenAI, Groq). Requests word-level timestamps
    and normalizes the response to the Scribe schema."""
    size_mb = audio_path.stat().st_size / (1024 * 1024)
    if size_mb > WHISPER_MAX_UPLOAD_MB:
        raise RuntimeError(
            f"{audio_path.name} is {size_mb:.0f}MB, over the {WHISPER_MAX_UPLOAD_MB:.0f}MB "
            f"Whisper upload cap. Use --provider elevenlabs for long single files, "
            f"or split the source."
        )
    data = {
        "model": model,
        "response_format": "verbose_json",
        "timestamp_granularities[]": "word",
    }
    if language:
        data["language"] = language
    with open(audio_path, "rb") as f:
        resp = requests.post(
            f"{base_url}/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (audio_path.name, f, "audio/mpeg")},
            data=data,
            timeout=1800,
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Whisper ({base_url}) returned {resp.status_code}: {resp.text[:500]}")
    return normalize_whisper(resp.json())


def normalize_whisper(resp: dict) -> dict:
    """Map an OpenAI/Groq verbose_json response to the Scribe schema the skill
    consumes. Word entries become type 'word' with no speaker_id (Whisper does
    not diarize); a 'spacing' entry is synthesized for each inter-word gap so
    pack_transcripts' silence-based phrase splitting still works."""
    raw_words = resp.get("words") or []
    words: list[dict] = []
    prev_end: float | None = None
    for w in raw_words:
        text = w.get("word", w.get("text", ""))
        start = w.get("start")
        end = w.get("end", start)
        if start is None:
            continue
        if prev_end is not None and start > prev_end:
            # The gap between words — Scribe emits these as 'spacing'; the
            # downstream reads their duration to find silences to cut on.
            words.append({"text": " ", "start": prev_end, "end": start, "type": "spacing"})
        words.append({"text": text, "start": start, "end": end, "type": "word", "speaker_id": None})
        prev_end = end
    return {
        "language_code": resp.get("language"),
        "text": resp.get("text", ""),
        "words": words,
    }


def transcript_path(edit_dir: Path, video: Path, audio_track: int = 0) -> Path:
    """Where a video's transcript lands. Track 0 keeps the plain name."""
    suffix = "" if audio_track == 0 else f".track{audio_track}"
    return edit_dir / "transcripts" / f"{video.stem}{suffix}.json"


def transcribe_one(
    video: Path,
    edit_dir: Path,
    provider: str,
    api_key: str,
    language: str | None = None,
    num_speakers: int | None = None,
    verbose: bool = True,
    audio_track: int = 0,
) -> Path:
    """Transcribe a single video. Returns the transcript JSON path.
    Cached: returns immediately if the transcript already exists."""
    transcripts_dir = edit_dir / "transcripts"
    transcripts_dir.mkdir(parents=True, exist_ok=True)
    out_path = transcript_path(edit_dir, video, audio_track)

    if out_path.exists():
        if verbose:
            print(f"cached: {out_path.name}")
        return out_path

    kind = PROVIDERS[provider]["kind"]
    if verbose:
        print(f"  provider: {provider} ({kind})", flush=True)
        print(f"  extracting audio from {video.name}", flush=True)

    n_tracks = count_audio_tracks(video)
    if n_tracks > 1 and verbose:
        print(f"  note: {video.name} has {n_tracks} audio tracks, using track "
              f"{audio_track + 1} (--audio-track to change)", flush=True)

    t0 = time.time()
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / f"{video.stem}.wav"
        extract_audio(video, wav, audio_track)

        # Uploading silence costs the same as uploading speech and returns
        # nothing, so catch the wrong-track case before paying for it.
        peak = peak_dbfs(wav)
        if peak < -60.0:
            raise RuntimeError(
                f"track {audio_track + 1} of {video.name} is silent "
                f"(peak {peak:.1f} dBFS) - not uploading. "
                + (f"The file has {n_tracks} audio tracks; try --audio-track "
                   + " or ".join(str(i) for i in range(n_tracks) if i != audio_track) + "."
                   if n_tracks > 1 else "Check the source audio.")
            )

        if kind == "scribe":
            upload = wav
        else:
            upload = Path(tmp) / f"{video.stem}.mp3"
            wav_to_mp3(wav, upload)

        size_mb = upload.stat().st_size / (1024 * 1024)
        if verbose:
            print(f"  uploading {upload.name} ({size_mb:.1f} MB)", flush=True)

        if kind == "scribe":
            payload = call_scribe(upload, api_key, language, num_speakers)
        else:
            if num_speakers and verbose:
                print("  note: --num-speakers is ignored by Whisper (no diarization)", flush=True)
            payload = call_whisper(
                upload, api_key,
                PROVIDERS[provider]["base_url"], PROVIDERS[provider]["model"], language,
            )

    out_path.write_text(json.dumps(payload, indent=2))
    dt = time.time() - t0
    if verbose:
        kb = out_path.stat().st_size / 1024
        print(f"  saved: {out_path.name} ({kb:.1f} KB) in {dt:.1f}s")
        if isinstance(payload, dict) and "words" in payload:
            print(f"    words: {len(payload['words'])}")
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser(description="Transcribe a video (ElevenLabs Scribe or Whisper)")
    ap.add_argument("video", type=Path, help="Path to video file")
    ap.add_argument("--provider", type=str, default=None,
                    help="elevenlabs | groq | openai. Default: TRANSCRIBE_PROVIDER, "
                         "else the first key present (groq > openai > elevenlabs).")
    ap.add_argument("--edit-dir", type=Path, default=None,
                    help="Edit output directory (default: <video_parent>/edit)")
    ap.add_argument("--language", type=str, default=None,
                    help="Optional ISO language code (e.g., 'en'). Omit to auto-detect.")
    ap.add_argument("--num-speakers", type=int, default=None,
                    help="Optional speaker count (ElevenLabs only; ignored by Whisper).")
    ap.add_argument("--audio-track", type=int, default=0,
                    help="Zero-based audio track to transcribe.")
    args = ap.parse_args()

    video = args.video.resolve()
    if not video.exists():
        sys.exit(f"video not found: {video}")

    edit_dir = (args.edit_dir or (video.parent / "edit")).resolve()
    provider = resolve_provider(args.provider)
    api_key = load_env_key(PROVIDERS[provider]["key_env"])

    transcribe_one(
        video=video,
        edit_dir=edit_dir,
        provider=provider,
        api_key=api_key,
        language=args.language,
        num_speakers=args.num_speakers,
        audio_track=args.audio_track,
    )


if __name__ == "__main__":
    main()
