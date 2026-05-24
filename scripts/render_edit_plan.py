#!/usr/bin/env python3
"""Render an edit-plan JSON file with ffmpeg.

The edit plan is the JSON exported from the Local Editor UI. This renderer
uses frame-accurate trim filters and re-encodes output for clean jump cuts.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path


def number(value: float | int) -> str:
    return f"{float(value):.3f}".rstrip("0").rstrip(".")


DEFAULT_LOUDNESS_TARGET = -16.0
DEFAULT_TRUE_PEAK = -1.5
DEFAULT_LRA = 11.0


def probe_video_size(source_video: Path) -> tuple[int, int]:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
            str(source_video),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    stream = (payload.get("streams") or [{}])[0]
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    if width <= 0 or height <= 0:
        raise SystemExit(f"Could not read video dimensions for {source_video}.")
    return width - (width % 2), height - (height % 2)


def collect_segments(source_video: Path | None, plan: dict) -> tuple[list[Path], list[dict]]:
    if isinstance(plan.get("clips"), list):
        inputs: list[Path] = []
        segments: list[dict] = []
        for clip in plan["clips"]:
            source = clip.get("source_video")
            timeline = clip.get("timeline") or []
            if not source:
                raise SystemExit("A sequence clip is missing source_video.")
            if not timeline:
                continue
            input_index = len(inputs)
            inputs.append(Path(source).expanduser().resolve())
            for segment in timeline:
                segments.append({**segment, "input_index": input_index})
        return inputs, segments

    timeline = plan.get("timeline") or []
    if source_video is None:
        raise SystemExit("Single-source edit plans require --source-video.")
    return [source_video], [{**segment, "input_index": 0} for segment in timeline]


def build_concat_filters(
    inputs: list[Path],
    segments: list[dict],
    denoise_audio: bool,
) -> tuple[list[str], int, int]:
    target_width, target_height = probe_video_size(inputs[0])
    filters: list[str] = []
    concat_inputs: list[str] = []
    channel_layout = "mono" if denoise_audio else "stereo"
    for index, segment in enumerate(segments):
        input_index = int(segment["input_index"])
        start = number(segment["source_start"])
        end = number(segment["source_end"])
        filters.append(
            f"[{input_index}:v]"
            f"trim=start={start}:end={end},setpts=PTS-STARTPTS,"
            f"scale=w={target_width}:h={target_height}:force_original_aspect_ratio=decrease,"
            f"pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2,"
            f"setsar=1,format=yuv420p[v{index}]"
        )
        filters.append(
            f"[{input_index}:a]"
            f"atrim=start={start}:end={end},asetpts=PTS-STARTPTS,"
            f"aresample=48000,aformat=sample_rates=48000:channel_layouts={channel_layout}[a{index}]"
        )
        concat_inputs.append(f"[v{index}][a{index}]")

    filters.append(f"{''.join(concat_inputs)}concat=n={len(segments)}:v=1:a=1[outv][outa]")
    return filters, target_width, target_height


def render_intermediate(
    inputs: list[Path],
    segments: list[dict],
    video_output: Path,
    audio_output: Path,
    denoise_audio: bool,
) -> None:
    filters, _target_width, _target_height = build_concat_filters(inputs, segments, denoise_audio)

    command = ["ffmpeg", "-y", "-v", "error"]
    for input_path in inputs:
        command.extend(["-i", str(input_path)])
    command.extend([
        "-filter_complex",
        ";".join(filters),
        "-map",
        "[outv]",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        str(video_output),
        "-map",
        "[outa]",
        "-vn",
        "-c:a",
        "pcm_s16le",
        "-ar",
        "48000",
        str(audio_output),
    ])
    subprocess.run(command, check=True)


def run_deepfilternet(
    input_audio: Path,
    work_dir: Path,
    denoise_binary: Path | None,
    denoise_model: Path | None,
) -> Path:
    output_dir = work_dir / "denoised"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_audio = output_dir / input_audio.name
    if not denoise_binary or not denoise_binary.is_file():
        raise SystemExit("Denoise runtime is not ready. Try the Denoise toggle again.")
    if not denoise_model or not denoise_model.is_file():
        raise SystemExit("DeepFilterNet3 model is not ready. Try the Denoise toggle again.")

    command = [
        str(denoise_binary),
        "-m",
        str(denoise_model),
        "-D",
        "-o",
        str(output_dir),
        str(input_audio),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        details = (result.stderr or result.stdout or "").strip()
        raise SystemExit(details or "DeepFilterNet audio denoise failed.")
    if not output_audio.exists():
        candidates = sorted(output_dir.glob("*.wav"))
        if candidates:
            return candidates[0]
        raise SystemExit("DeepFilterNet finished without writing an enhanced WAV.")
    return output_audio


def parse_loudnorm_stats(output: str) -> dict:
    match = re.search(r"\{\s*\"input_i\".*?\}", output, re.DOTALL)
    if not match:
        raise SystemExit("FFmpeg loudnorm did not return measurement JSON.")
    return json.loads(match.group(0))


def measure_loudness(audio_path: Path, target: float, true_peak: float, lra: float) -> dict:
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(audio_path),
            "-af",
            f"loudnorm=I={number(target)}:TP={number(true_peak)}:LRA={number(lra)}:print_format=json",
            "-f",
            "null",
            "-",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return parse_loudnorm_stats(f"{result.stdout}\n{result.stderr}")


def loudnorm_filter(stats: dict, target: float, true_peak: float, lra: float) -> str:
    return (
        f"loudnorm=I={number(target)}:TP={number(true_peak)}:LRA={number(lra)}:"
        f"measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
        f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:"
        f"offset={stats['target_offset']}:linear=true:print_format=summary"
    )


def mux_final(
    video_path: Path,
    audio_path: Path,
    output: Path,
    normalize_audio: bool,
    loudness_target: float,
    true_peak: float,
    lra: float,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    command = ["ffmpeg", "-y", "-v", "error", "-i", str(video_path), "-i", str(audio_path)]
    if normalize_audio:
        stats = measure_loudness(audio_path, loudness_target, true_peak, lra)
        command.extend(
            [
                "-filter_complex",
                f"[1:a]{loudnorm_filter(stats, loudness_target, true_peak, lra)},"
                "aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[aout]",
                "-map",
                "0:v:0",
                "-map",
                "[aout]",
            ]
        )
    else:
        command.extend(["-map", "0:v:0", "-map", "1:a:0", "-ar", "48000", "-ac", "2"])

    command.extend(
        [
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )
    subprocess.run(command, check=True)


def render(
    source_video: Path | None,
    edit_plan: Path,
    output: Path,
    denoise_audio: bool = False,
    normalize_audio: bool = False,
    denoise_binary: Path | None = None,
    denoise_model: Path | None = None,
    loudness_target: float = DEFAULT_LOUDNESS_TARGET,
    true_peak: float = DEFAULT_TRUE_PEAK,
    lra: float = DEFAULT_LRA,
) -> None:
    plan = json.loads(edit_plan.read_text(encoding="utf-8"))
    inputs, segments = collect_segments(source_video, plan)
    if not segments:
        raise SystemExit("Edit plan has no kept timeline segments.")

    with tempfile.TemporaryDirectory(prefix="local-editor-render-") as tmp:
        work_dir = Path(tmp)
        video_stage = work_dir / "video.mp4"
        audio_stage = work_dir / "audio.wav"
        render_intermediate(inputs, segments, video_stage, audio_stage, denoise_audio)
        audio_for_mux = (
            run_deepfilternet(audio_stage, work_dir, denoise_binary, denoise_model)
            if denoise_audio
            else audio_stage
        )
        mux_final(
            video_stage,
            audio_for_mux,
            output,
            normalize_audio,
            loudness_target,
            true_peak,
            lra,
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-video", type=Path)
    parser.add_argument("--edit-plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--denoise-audio", action="store_true")
    parser.add_argument("--denoise-binary", type=Path)
    parser.add_argument("--denoise-model", type=Path)
    parser.add_argument("--normalize-audio", action="store_true")
    parser.add_argument("--loudness-target", type=float, default=DEFAULT_LOUDNESS_TARGET)
    parser.add_argument("--true-peak", type=float, default=DEFAULT_TRUE_PEAK)
    parser.add_argument("--lra", type=float, default=DEFAULT_LRA)
    args = parser.parse_args()
    source_video = args.source_video.expanduser().resolve() if args.source_video else None
    render(
        source_video,
        args.edit_plan.expanduser().resolve(),
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
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
