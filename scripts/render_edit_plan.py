#!/usr/bin/env python3
"""Render an edit-plan JSON file with ffmpeg.

The edit plan is the JSON exported from the Local Editor UI. This renderer
uses frame-accurate trim filters and re-encodes output for clean jump cuts.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


def number(value: float | int) -> str:
    return f"{float(value):.3f}".rstrip("0").rstrip(".")


def render(source_video: Path, edit_plan: Path, output: Path) -> None:
    plan = json.loads(edit_plan.read_text(encoding="utf-8"))
    timeline = plan.get("timeline") or []
    if not timeline:
        raise SystemExit("Edit plan has no kept timeline segments.")

    filters: list[str] = []
    concat_inputs: list[str] = []
    for index, segment in enumerate(timeline):
        start = number(segment["source_start"])
        end = number(segment["source_end"])
        filters.append(f"[0:v]trim=start={start}:end={end},setpts=PTS-STARTPTS[v{index}]")
        filters.append(f"[0:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS[a{index}]")
        concat_inputs.append(f"[v{index}][a{index}]")

    filters.append(f"{''.join(concat_inputs)}concat=n={len(timeline)}:v=1:a=1[outv][outa]")

    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(source_video),
        "-filter_complex",
        ";".join(filters),
        "-map",
        "[outv]",
        "-map",
        "[outa]",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(output),
    ]
    subprocess.run(command, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-video", type=Path, required=True)
    parser.add_argument("--edit-plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    render(args.source_video.expanduser().resolve(), args.edit_plan.expanduser().resolve(), args.output.expanduser().resolve())
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
