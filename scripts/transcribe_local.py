#!/usr/bin/env python3
"""Transcribe a local video into the editor's canonical JSON shape.

This script expects ffmpeg on PATH and the Python packages from requirements.txt
installed in the active environment. Model files and project outputs can live on
an external SSD.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from audio_io import audio_duration, extract_audio
from vad import (
    DEFAULT_VAD_CHUNK_SIZE,
    DEFAULT_VAD_MIN_SILENCE_MS,
    DEFAULT_VAD_ONSET,
    DEFAULT_VAD_SPEECH_PAD_MS,
    VadSettings,
    clip_timestamps,
    plan_transcription_clips,
)


def words_from_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    for segment in result.get("segments", []):
        for word in segment.get("words", []):
            start = word.get("start")
            end = word.get("end")
            text = str(word.get("word") or word.get("text") or "").strip()
            if start is None or end is None or not text:
                continue
            words.append(
                {
                    "id": f"w_{len(words) + 1:06d}",
                    "text": text,
                    "start": round(float(start), 3),
                    "end": round(float(end), 3),
                    "confidence": word.get("probability"),
                }
            )
    return words


def phrase_from_segment(segment: dict[str, Any], index: int) -> dict[str, Any]:
    return {
        "id": f"p_{index:04d}",
        "start": round(float(segment.get("start", 0.0)), 3),
        "end": round(float(segment.get("end", 0.0)), 3),
        "text": str(segment.get("text", "")).strip(),
        "intent": "unlabeled",
        "confidence": 1.0,
        "speaker": segment.get("speaker") or "A",
    }


def mlx_transcribe_with_dtype_fallback(
    mlx_whisper: Any,
    audio_path: Path,
    *,
    model: str,
    timestamps: list[float],
) -> dict[str, Any]:
    options: dict[str, Any] = {
        "path_or_hf_repo": model,
        "word_timestamps": True,
        "condition_on_previous_text": False,
        "no_speech_threshold": 0.6,
        "hallucination_silence_threshold": 1.0,
        "clip_timestamps": timestamps,
    }

    try:
        return mlx_whisper.transcribe(str(audio_path), **options)
    except TypeError as exc:
        if "audio_features has an incorrect dtype" not in str(exc):
            raise
        return mlx_whisper.transcribe(str(audio_path), **options, fp16=False)


def transcribe(
    audio_path: Path,
    model: str,
    cache_dir: Path | None,
    vad_settings: VadSettings,
) -> tuple[dict[str, Any], dict[str, object]]:
    if cache_dir:
        os.environ.setdefault("HF_HOME", str(cache_dir))
        os.environ.setdefault("HF_HUB_CACHE", str(cache_dir / "hub"))

    try:
        import mlx_whisper  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            "mlx-whisper is not installed. Install requirements.txt, then rerun this script."
        ) from exc

    chunks, vad_metadata = plan_transcription_clips(audio_path, vad_settings)
    if not chunks:
        return {"text": "", "segments": [], "language": "unknown"}, vad_metadata.to_json()

    result = mlx_transcribe_with_dtype_fallback(
        mlx_whisper,
        audio_path,
        model=model,
        timestamps=clip_timestamps(chunks),
    )
    return result, vad_metadata.to_json()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--project-dir", type=Path, required=True)
    parser.add_argument("--model", default="mlx-community/whisper-large-v3-turbo")
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--no-vad", action="store_true", help="Transcribe the full audio file.")
    parser.add_argument("--vad-onset", type=float, default=DEFAULT_VAD_ONSET)
    parser.add_argument("--vad-chunk-size", type=float, default=DEFAULT_VAD_CHUNK_SIZE)
    parser.add_argument("--vad-min-silence-ms", type=int, default=DEFAULT_VAD_MIN_SILENCE_MS)
    parser.add_argument("--vad-speech-pad-ms", type=int, default=DEFAULT_VAD_SPEECH_PAD_MS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    video_path = args.video.expanduser().resolve()
    project_dir = args.project_dir.expanduser().resolve()
    audio_path = project_dir / "audio.wav"
    transcript_path = project_dir / "transcript.json"

    if not video_path.exists():
        raise SystemExit(f"Video not found: {video_path}")

    project_dir.mkdir(parents=True, exist_ok=True)
    extract_audio(video_path, audio_path)
    result, vad_metadata = transcribe(
        audio_path,
        args.model,
        args.cache_dir,
        VadSettings(
            enabled=not args.no_vad,
            onset=args.vad_onset,
            chunk_size=args.vad_chunk_size,
            min_silence_ms=args.vad_min_silence_ms,
            speech_pad_ms=args.vad_speech_pad_ms,
        ),
    )

    phrases = [
        phrase_from_segment(segment, index)
        for index, segment in enumerate(result.get("segments", []), start=1)
        if str(segment.get("text", "")).strip()
    ]
    words = words_from_result(result)

    project = {
        "version": 1,
        "project_id": project_dir.name,
        "source": {
            "video_id": video_path.stem,
            "file_name": video_path.name,
            "path": str(video_path),
            "duration": vad_metadata.get("audio_seconds") or audio_duration(audio_path),
        },
        "vad": vad_metadata,
        "transcript": phrases,
        "words": words,
        "render": {
            "format": "mp4",
            "resolution": "source",
            "crossfade_ms": 0,
        },
    }

    transcript_path.write_text(json.dumps(project, indent=2), encoding="utf-8")
    print(transcript_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
