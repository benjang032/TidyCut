#!/usr/bin/env python3
"""Build an audio-only preview track for the local editor."""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from render_edit_plan import (
    DEFAULT_LOUDNESS_TARGET,
    DEFAULT_LRA,
    DEFAULT_TRUE_PEAK,
    loudnorm_filter,
    measure_loudness,
    number,
    run_deepfilternet,
)


def emit(stage: str, progress: float, message: str) -> None:
    print(
        json.dumps(
            {
                "stage": stage,
                "progress": progress,
                "message": message,
            }
        ),
        flush=True,
    )


def extract_audio(source_video: Path, output: Path, denoise_audio: bool) -> None:
    channel_count = "1" if denoise_audio else "2"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(source_video),
            "-vn",
            "-ac",
            channel_count,
            "-ar",
            "48000",
            "-c:a",
            "pcm_s16le",
            str(output),
        ],
        check=True,
    )


def encode_preview(
    audio_path: Path,
    output: Path,
    normalize_audio: bool,
    loudness_target: float,
    true_peak: float,
    lra: float,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    command = ["ffmpeg", "-y", "-v", "error", "-i", str(audio_path), "-vn"]
    if normalize_audio:
        stats = measure_loudness(audio_path, loudness_target, true_peak, lra)
        command.extend(
            [
                "-filter_complex",
                f"[0:a]{loudnorm_filter(stats, loudness_target, true_peak, lra)},"
                "aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[aout]",
                "-map",
                "[aout]",
            ]
        )
    else:
        command.extend(["-ar", "48000", "-ac", "2"])

    command.extend(
        [
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )
    subprocess.run(command, check=True)


def process_preview(
    source_video: Path,
    output: Path,
    denoise_audio: bool,
    normalize_audio: bool,
    denoise_binary: Path | None,
    denoise_model: Path | None,
    loudness_target: float,
    true_peak: float,
    lra: float,
) -> None:
    with tempfile.TemporaryDirectory(prefix="local-editor-audio-preview-") as tmp:
        work_dir = Path(tmp)
        extracted_audio = work_dir / "source.wav"

        emit("extract", 0.15, "Extracting preview audio")
        extract_audio(source_video, extracted_audio, denoise_audio)
        audio_for_encode = extracted_audio

        if denoise_audio:
            emit("denoise", 0.35, "Removing background noise")
            audio_for_encode = run_deepfilternet(
                extracted_audio,
                work_dir,
                denoise_binary,
                denoise_model,
            )

        if normalize_audio:
            emit("normalize", 0.7, "Measuring and normalizing loudness")
        else:
            emit("encode", 0.8, "Encoding preview audio")
        encode_preview(
            audio_for_encode,
            output,
            normalize_audio,
            loudness_target,
            true_peak,
            lra,
        )

    emit("ready", 1, "Audio preview ready")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-video", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--denoise-audio", action="store_true")
    parser.add_argument("--denoise-binary", type=Path)
    parser.add_argument("--denoise-model", type=Path)
    parser.add_argument("--normalize-audio", action="store_true")
    parser.add_argument("--loudness-target", type=float, default=DEFAULT_LOUDNESS_TARGET)
    parser.add_argument("--true-peak", type=float, default=DEFAULT_TRUE_PEAK)
    parser.add_argument("--lra", type=float, default=DEFAULT_LRA)
    args = parser.parse_args()
    process_preview(
        args.source_video.expanduser().resolve(),
        args.output.expanduser().resolve(),
        denoise_audio=args.denoise_audio,
        normalize_audio=args.normalize_audio,
        denoise_binary=(
            args.denoise_binary.expanduser().resolve() if args.denoise_binary else None
        ),
        denoise_model=args.denoise_model.expanduser().resolve() if args.denoise_model else None,
        loudness_target=args.loudness_target,
        true_peak=args.true_peak,
        lra=args.lra,
    )
    print(args.output, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
