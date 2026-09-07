"""Transcribe a video with a pluggable speech-to-text provider.

Fork-local overlay for the DeepSeek Harness deployment. Upstream ships an
ElevenLabs-Scribe-only transcriber; this version keeps Scribe and adds
Deepgram, AssemblyAI, and OpenAI-compatible Whisper (Groq, OpenAI). Every
provider is normalized to the same JSON the rest of the skill reads
(`{"words": [{text, start, end, type, speaker_id}], ...}`), so nothing
downstream changes.

Provider selection, in order:
  1. --provider / TRANSCRIBE_PROVIDER
     (deepgram | assemblyai | elevenlabs | groq | openai)
  2. auto: first key present, preferring diarization-capable providers —
     DEEPGRAM_API_KEY, ASSEMBLYAI_API_KEY, ELEVENLABS_API_KEY, then the
     Whisper keys GROQ_API_KEY, OPENAI_API_KEY.

Capability note: Deepgram, AssemblyAI, and ElevenLabs return per-word speaker
labels (diarization); with fillers kept they also preserve "um"/"uh" as words.
Whisper (Groq/OpenAI) returns word-level timestamps but a single speaker and no
event tags. Use a diarizing provider when per-speaker cutting matters.

Extracts mono 16kHz audio via ffmpeg. Whisper uploads a small mono mp3 (the
OpenAI/Groq 25MB request cap ~= 70 min at 48kbps); every other provider uploads
the lossless wav. Cached: if the transcript already exists, the upload is
skipped.

Usage:
    python helpers/transcribe.py <video_path>
    python helpers/transcribe.py <video_path> --provider deepgram
    python helpers/transcribe.py <video_path> --edit-dir /custom/edit
    python helpers/transcribe.py <video_path> --language en
    python helpers/transcribe.py <video_path> --num-speakers 2
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
DEEPGRAM_URL = "https://api.deepgram.com/v1/listen"
ASSEMBLYAI_BASE = "https://api.assemblyai.com/v2"

# name -> its key env var, its transcriber kind, and (whisper only) the
# OpenAI-compatible base URL + model. Add a row plus a call_/normalize_ pair to
# support another backend.
PROVIDERS: dict[str, dict[str, str]] = {
    "deepgram": {"key_env": "DEEPGRAM_API_KEY", "kind": "deepgram"},
    "assemblyai": {"key_env": "ASSEMBLYAI_API_KEY", "kind": "assemblyai"},
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

# Auto-detect order: diarization-capable first (fuller skill capability), then
# the Whisper backends. TRANSCRIBE_PROVIDER overrides this.
AUTO_ORDER = ["deepgram", "assemblyai", "elevenlabs", "groq", "openai"]

# OpenAI/Groq reject requests over 25MB; the mono mp3 stays far under that for
# normal clips, and we fail loudly rather than get a 413 mid-run.
WHISPER_MAX_UPLOAD_MB = 24.0

# AssemblyAI is async (upload -> create -> poll); cap the wait rather than loop
# forever if a job wedges.
ASSEMBLYAI_POLL_INTERVAL_S = 3
ASSEMBLYAI_MAX_WAIT_S = 3600


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
    check and for every provider except Whisper."""
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


def _interleave_spacing(words: list[dict]) -> list[dict]:
    """Insert a 'spacing' entry for every inter-word gap, the way Scribe does,
    so pack_transcripts' silence-based phrase splitting works for every
    provider. Input entries are already `{text, start, end, type:'word',
    speaker_id}`."""
    out: list[dict] = []
    prev_end: float | None = None
    for w in words:
        if prev_end is not None and w["start"] > prev_end:
            out.append({"text": " ", "start": prev_end, "end": w["start"], "type": "spacing"})
        out.append(w)
        prev_end = w["end"]
    return out


# ---- Scribe (ElevenLabs) — already the target schema -----------------------

def call_scribe(
    audio_path: Path,
    api_key: str,
    language: str | None = None,
    num_speakers: int | None = None,
) -> dict:
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


# ---- Whisper (OpenAI, Groq) ------------------------------------------------

def call_whisper(
    audio_path: Path,
    api_key: str,
    base_url: str,
    model: str,
    language: str | None = None,
) -> dict:
    size_mb = audio_path.stat().st_size / (1024 * 1024)
    if size_mb > WHISPER_MAX_UPLOAD_MB:
        raise RuntimeError(
            f"{audio_path.name} is {size_mb:.0f}MB, over the {WHISPER_MAX_UPLOAD_MB:.0f}MB "
            f"Whisper upload cap. Use a diarizing provider (deepgram/assemblyai/elevenlabs) "
            f"for long single files, or split the source."
        )
    data = {"model": model, "response_format": "verbose_json", "timestamp_granularities[]": "word"}
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
    words: list[dict] = []
    for w in resp.get("words") or []:
        start = w.get("start")
        if start is None:
            continue
        words.append({
            "text": w.get("word", w.get("text", "")),
            "start": start, "end": w.get("end", start),
            "type": "word", "speaker_id": None,
        })
    return {"language_code": resp.get("language"), "text": resp.get("text", ""),
            "words": _interleave_spacing(words)}


# ---- Deepgram --------------------------------------------------------------

def call_deepgram(audio_path: Path, api_key: str, language: str | None = None) -> dict:
    """Deepgram pre-recorded, one sync POST. Diarize + fillers preserve the
    per-speaker and editorial signal the skill wants."""
    params = {
        "model": "nova-2",
        "smart_format": "true",
        "punctuate": "true",
        "diarize": "true",
        "filler_words": "true",
    }
    if language:
        params["language"] = language
    with open(audio_path, "rb") as f:
        resp = requests.post(
            DEEPGRAM_URL,
            headers={"Authorization": f"Token {api_key}", "Content-Type": "audio/wav"},
            params=params, data=f, timeout=1800,
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Deepgram returned {resp.status_code}: {resp.text[:500]}")
    return normalize_deepgram(resp.json())


def normalize_deepgram(resp: dict) -> dict:
    channels = resp.get("results", {}).get("channels", [])
    alt = (channels[0].get("alternatives", [{}])[0] if channels else {})
    words: list[dict] = []
    for w in alt.get("words", []):
        start = w.get("start")
        if start is None:
            continue
        spk = w.get("speaker")
        words.append({
            "text": w.get("punctuated_word") or w.get("word", ""),
            "start": start, "end": w.get("end", start),
            "type": "word", "speaker_id": f"speaker_{spk}" if spk is not None else None,
        })
    return {"language_code": None, "text": alt.get("transcript", ""),
            "words": _interleave_spacing(words)}


# ---- AssemblyAI ------------------------------------------------------------

def call_assemblyai(
    audio_path: Path,
    api_key: str,
    language: str | None = None,
    num_speakers: int | None = None,
) -> dict:
    """AssemblyAI is async: upload the audio, create a transcript job, poll.
    speaker_labels + disfluencies keep diarization and fillers."""
    hdr = {"Authorization": api_key}
    with open(audio_path, "rb") as f:
        up = requests.post(f"{ASSEMBLYAI_BASE}/upload", headers=hdr, data=f, timeout=1800)
    if up.status_code != 200:
        raise RuntimeError(f"AssemblyAI upload returned {up.status_code}: {up.text[:300]}")
    body: dict = {
        "audio_url": up.json()["upload_url"],
        "speaker_labels": True,
        "disfluencies": True,
        "punctuate": True,
        "format_text": True,
    }
    if language:
        body["language_code"] = language
    else:
        body["language_detection"] = True
    if num_speakers:
        body["speakers_expected"] = num_speakers
    cr = requests.post(f"{ASSEMBLYAI_BASE}/transcript", headers=hdr, json=body, timeout=60)
    if cr.status_code != 200:
        raise RuntimeError(f"AssemblyAI create returned {cr.status_code}: {cr.text[:300]}")
    tid = cr.json()["id"]

    waited = 0
    while waited <= ASSEMBLYAI_MAX_WAIT_S:
        pr = requests.get(f"{ASSEMBLYAI_BASE}/transcript/{tid}", headers=hdr, timeout=60).json()
        status = pr.get("status")
        if status == "completed":
            return normalize_assemblyai(pr)
        if status == "error":
            raise RuntimeError(f"AssemblyAI transcription failed: {pr.get('error')}")
        time.sleep(ASSEMBLYAI_POLL_INTERVAL_S)
        waited += ASSEMBLYAI_POLL_INTERVAL_S
    raise RuntimeError(f"AssemblyAI job {tid} did not finish within {ASSEMBLYAI_MAX_WAIT_S}s")


def normalize_assemblyai(resp: dict) -> dict:
    """AssemblyAI word times are in milliseconds; speaker is a letter."""
    words: list[dict] = []
    for w in resp.get("words", []):
        start = w.get("start")
        if start is None:
            continue
        end = w.get("end", start)
        spk = w.get("speaker")
        words.append({
            "text": w.get("text", ""),
            "start": start / 1000.0, "end": end / 1000.0,
            "type": "word", "speaker_id": f"speaker_{spk}" if spk is not None else None,
        })
    return {"language_code": resp.get("language_code"), "text": resp.get("text", ""),
            "words": _interleave_spacing(words)}


# ---- Orchestration ---------------------------------------------------------

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

        if kind == "whisper":
            upload = Path(tmp) / f"{video.stem}.mp3"
            wav_to_mp3(wav, upload)
        else:
            upload = wav

        size_mb = upload.stat().st_size / (1024 * 1024)
        if verbose:
            print(f"  uploading {upload.name} ({size_mb:.1f} MB)", flush=True)
            if num_speakers and kind in ("whisper", "deepgram"):
                print(f"  note: --num-speakers is ignored by {provider}", flush=True)

        if kind == "scribe":
            payload = call_scribe(upload, api_key, language, num_speakers)
        elif kind == "whisper":
            payload = call_whisper(
                upload, api_key,
                PROVIDERS[provider]["base_url"], PROVIDERS[provider]["model"], language,
            )
        elif kind == "deepgram":
            payload = call_deepgram(upload, api_key, language)
        elif kind == "assemblyai":
            payload = call_assemblyai(upload, api_key, language, num_speakers)
        else:
            raise RuntimeError(f"unhandled provider kind {kind!r}")

    out_path.write_text(json.dumps(payload, indent=2))
    dt = time.time() - t0
    if verbose:
        kb = out_path.stat().st_size / 1024
        print(f"  saved: {out_path.name} ({kb:.1f} KB) in {dt:.1f}s")
        if isinstance(payload, dict) and "words" in payload:
            print(f"    words: {len(payload['words'])}")
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser(description="Transcribe a video (Scribe/Deepgram/AssemblyAI/Whisper)")
    ap.add_argument("video", type=Path, help="Path to video file")
    ap.add_argument("--provider", type=str, default=None,
                    help="deepgram | assemblyai | elevenlabs | groq | openai. Default: "
                         "TRANSCRIBE_PROVIDER, else the first key present.")
    ap.add_argument("--edit-dir", type=Path, default=None,
                    help="Edit output directory (default: <video_parent>/edit)")
    ap.add_argument("--language", type=str, default=None,
                    help="Optional ISO language code (e.g., 'en'). Omit to auto-detect.")
    ap.add_argument("--num-speakers", type=int, default=None,
                    help="Optional speaker count (ElevenLabs/AssemblyAI; ignored elsewhere).")
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
