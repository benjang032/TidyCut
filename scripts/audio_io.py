"""Audio extraction and WAV helpers for local transcription."""

from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import numpy as np


SAMPLE_RATE = 16000


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def extract_audio(video_path: Path, audio_path: Path) -> None:
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            str(audio_path),
        ]
    )


def read_audio_samples(audio_path: Path) -> tuple[np.ndarray, int, float]:
    with wave.open(str(audio_path), "rb") as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        frames = wav.getnframes()
        raw = wav.readframes(frames)

    if channels != 1 or sample_width != 2:
        raise ValueError("Expected mono 16-bit PCM audio after ffmpeg extraction.")

    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    duration = frames / sample_rate if sample_rate else 0.0
    return samples, sample_rate, duration


def audio_duration(audio_path: Path) -> float:
    with wave.open(str(audio_path), "rb") as wav:
        return wav.getnframes() / wav.getframerate()
