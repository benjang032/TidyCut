"""Voice activity detection and clip planning for transcription."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from audio_io import SAMPLE_RATE, audio_duration, read_audio_samples


DEFAULT_VAD_ONSET = 0.5
DEFAULT_VAD_CHUNK_SIZE = 30.0
DEFAULT_VAD_MIN_SILENCE_MS = 100
DEFAULT_VAD_SPEECH_PAD_MS = 160


@dataclass(frozen=True, slots=True)
class SpeechSegment:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(frozen=True, slots=True)
class VadChunk:
    start: float
    end: float
    segments: tuple[SpeechSegment, ...]

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(frozen=True, slots=True)
class VadSettings:
    enabled: bool = True
    onset: float = DEFAULT_VAD_ONSET
    chunk_size: float = DEFAULT_VAD_CHUNK_SIZE
    min_silence_ms: int = DEFAULT_VAD_MIN_SILENCE_MS
    speech_pad_ms: int = DEFAULT_VAD_SPEECH_PAD_MS

    def validate(self) -> None:
        if not (0 < self.onset < 1):
            raise ValueError("--vad-onset must be between 0 and 1.")
        if self.chunk_size <= 0:
            raise ValueError("--vad-chunk-size must be greater than 0.")


@dataclass(frozen=True, slots=True)
class VadMetadata:
    enabled: bool
    method: str
    audio_seconds: float
    speech_seconds: float
    transcribed_seconds: float
    speech_segments: int
    merged_chunks: int
    onset: float | None = None
    chunk_size: float | None = None
    min_silence_ms: int | None = None
    speech_pad_ms: int | None = None

    def to_json(self) -> dict[str, object]:
        data: dict[str, object] = {
            "enabled": self.enabled,
            "method": self.method,
            "speech_segments": self.speech_segments,
            "merged_chunks": self.merged_chunks,
            "audio_seconds": round(self.audio_seconds, 3),
            "speech_seconds": round(self.speech_seconds, 3),
            "transcribed_seconds": round(self.transcribed_seconds, 3),
        }
        if self.enabled:
            data.update(
                {
                    "onset": self.onset,
                    "chunk_size": self.chunk_size,
                    "min_silence_ms": self.min_silence_ms,
                    "speech_pad_ms": self.speech_pad_ms,
                }
            )
        return data


def clamp_segments(
    segments: Iterable[SpeechSegment], duration: float
) -> list[SpeechSegment]:
    clean: list[SpeechSegment] = []
    for segment in sorted(segments, key=lambda item: item.start):
        start = max(0.0, min(duration, segment.start))
        end = max(0.0, min(duration, segment.end))
        if end <= start:
            continue

        next_segment = SpeechSegment(start, end)
        if clean and next_segment.start <= clean[-1].end:
            previous = clean[-1]
            clean[-1] = SpeechSegment(previous.start, max(previous.end, next_segment.end))
        else:
            clean.append(next_segment)

    return clean


def merge_vad_chunks(
    segments: list[SpeechSegment], chunk_size: float
) -> list[VadChunk]:
    """Merge speech spans into bounded chunks using WhisperX's chunk shape."""

    if not segments:
        return []

    merged: list[VadChunk] = []
    current_start = segments[0].start
    current_end = 0.0
    current_segments: list[SpeechSegment] = []

    for segment in segments:
        if segment.end - current_start > chunk_size and current_end - current_start > 0:
            merged.append(
                VadChunk(
                    start=current_start,
                    end=current_end,
                    segments=tuple(current_segments),
                )
            )
            current_start = segment.start
            current_segments = []

        current_end = segment.end
        current_segments.append(segment)

    merged.append(
        VadChunk(
            start=current_start,
            end=current_end,
            segments=tuple(current_segments),
        )
    )
    return merged


def full_audio_clips(duration: float) -> tuple[list[VadChunk], VadMetadata]:
    chunks = []
    if duration > 0:
        segment = SpeechSegment(0.0, duration)
        chunks = [VadChunk(0.0, duration, (segment,))]

    return chunks, VadMetadata(
        enabled=False,
        method="none",
        audio_seconds=duration,
        speech_seconds=duration,
        transcribed_seconds=duration,
        speech_segments=len(chunks),
        merged_chunks=len(chunks),
    )


def detect_speech_clips(
    audio_path: Path,
    settings: VadSettings,
) -> tuple[list[VadChunk], VadMetadata]:
    settings.validate()

    try:
        import torch  # type: ignore
        from silero_vad import get_speech_timestamps, load_silero_vad  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            "Silero VAD requires torch, torchaudio, and silero-vad. "
            "Install requirements.txt or rerun with --no-vad."
        ) from exc

    samples, sample_rate, duration = read_audio_samples(audio_path)
    if sample_rate != SAMPLE_RATE:
        raise ValueError(f"Expected {SAMPLE_RATE}Hz audio, got {sample_rate}Hz.")

    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    timestamps = get_speech_timestamps(
        torch.from_numpy(samples),
        model=load_silero_vad(onnx=False),
        sampling_rate=sample_rate,
        max_speech_duration_s=settings.chunk_size,
        threshold=settings.onset,
        min_silence_duration_ms=settings.min_silence_ms,
        speech_pad_ms=settings.speech_pad_ms,
    )
    speech_segments = clamp_segments(
        (
            SpeechSegment(
                start=float(item["start"]) / sample_rate,
                end=float(item["end"]) / sample_rate,
            )
            for item in timestamps
        ),
        duration,
    )
    chunks = merge_vad_chunks(speech_segments, settings.chunk_size)
    speech_seconds = sum(segment.duration for segment in speech_segments)
    transcribed_seconds = sum(chunk.duration for chunk in chunks)

    return chunks, VadMetadata(
        enabled=True,
        method="silero",
        onset=settings.onset,
        chunk_size=settings.chunk_size,
        min_silence_ms=settings.min_silence_ms,
        speech_pad_ms=settings.speech_pad_ms,
        speech_segments=len(speech_segments),
        merged_chunks=len(chunks),
        audio_seconds=duration,
        speech_seconds=speech_seconds,
        transcribed_seconds=transcribed_seconds,
    )


def plan_transcription_clips(
    audio_path: Path,
    settings: VadSettings,
) -> tuple[list[VadChunk], VadMetadata]:
    if settings.enabled:
        return detect_speech_clips(audio_path, settings)
    return full_audio_clips(audio_duration(audio_path))


def clip_timestamps(chunks: Iterable[VadChunk]) -> list[float]:
    return [
        timestamp
        for chunk in chunks
        for timestamp in (round(chunk.start, 3), round(chunk.end, 3))
    ]
