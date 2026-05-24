#!/usr/bin/env python3
"""Prepare the optional native DeepFilterNet denoise runtime."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path


VERSION = "0.5.6"
TAG = f"v{VERSION}"
MODEL_NAME = "DeepFilterNet3_onnx.tar.gz"
RELEASE_BASE = f"https://github.com/Rikorose/DeepFilterNet/releases/download/{TAG}"
MODEL_URL = f"https://raw.githubusercontent.com/Rikorose/DeepFilterNet/{TAG}/models/{MODEL_NAME}"
MIN_BINARY_BYTES = 1024 * 1024
MIN_MODEL_BYTES = 1024 * 1024


def emit(stage: str, progress: float, message: str, **extra: object) -> None:
    print(
        json.dumps(
            {
                "stage": stage,
                "progress": progress,
                "message": message,
                **extra,
            }
        ),
        flush=True,
    )


def platform_asset() -> tuple[str, str]:
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "darwin" and machine in {"arm64", "aarch64"}:
        return f"deep-filter-{VERSION}-aarch64-apple-darwin", "deep-filter"
    if system == "darwin" and machine in {"x86_64", "amd64"}:
        return f"deep-filter-{VERSION}-x86_64-apple-darwin", "deep-filter"
    if system == "linux" and machine in {"arm64", "aarch64"}:
        return f"deep-filter-{VERSION}-aarch64-unknown-linux-gnu", "deep-filter"
    if system == "linux" and machine in {"armv7l", "armv7"}:
        return f"deep-filter-{VERSION}-armv7-unknown-linux-gnueabihf", "deep-filter"
    if system == "linux" and machine in {"x86_64", "amd64"}:
        return f"deep-filter-{VERSION}-x86_64-unknown-linux-musl", "deep-filter"
    if system == "windows" and machine in {"x86_64", "amd64"}:
        return f"deep-filter-{VERSION}-x86_64-pc-windows-msvc.exe", "deep-filter.exe"

    raise RuntimeError(f"DeepFilterNet native runtime is not available for {system}/{machine}.")


def file_ready(path: Path, min_size: int, executable: bool = False) -> bool:
    if not path.is_file() or path.stat().st_size < min_size:
        return False
    return not executable or os.access(path, os.X_OK)


def download_file(url: str, destination: Path, min_size: int, executable: bool = False) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="local-editor-denoise-download-") as tmp:
        tmp_path = Path(tmp) / destination.name
        curl = shutil.which("curl")
        if curl:
            result = subprocess.run(
                [curl, "-L", "--fail", "--silent", "--show-error", "-o", str(tmp_path), url],
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                raise RuntimeError((result.stderr or result.stdout or "Download failed.").strip())
        else:
            import urllib.request

            with urllib.request.urlopen(url) as response, tmp_path.open("wb") as output:
                shutil.copyfileobj(response, output)

        if tmp_path.stat().st_size < min_size:
            raise RuntimeError(f"Downloaded file was unexpectedly small: {url}")
        if executable:
            mode = tmp_path.stat().st_mode
            tmp_path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        shutil.move(str(tmp_path), str(destination))


def ensure_binary(binary_path: Path) -> Path:
    if file_ready(binary_path, MIN_BINARY_BYTES, executable=True):
        emit("runtime", 0.4, "Denoise runtime ready", binary=str(binary_path))
        return binary_path

    asset_name, default_name = platform_asset()
    if binary_path.name in {"", "."}:
        binary_path = binary_path / default_name
    url = f"{RELEASE_BASE}/{asset_name}"
    emit("runtime", 0.12, "Downloading denoise runtime")
    download_file(url, binary_path, MIN_BINARY_BYTES, executable=True)
    emit("runtime", 0.4, "Denoise runtime ready", binary=str(binary_path))
    return binary_path


def ensure_model(model_path: Path) -> Path:
    if file_ready(model_path, MIN_MODEL_BYTES):
        emit("model", 1, "DeepFilterNet3 model ready", model=str(model_path))
        return model_path

    emit("model", 0.55, "Downloading DeepFilterNet3 model")
    download_file(MODEL_URL, model_path, MIN_MODEL_BYTES)
    emit("model", 1, "DeepFilterNet3 model ready", model=str(model_path))
    return model_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", type=Path, required=True)
    args = parser.parse_args()

    runtime_dir = args.runtime_dir.expanduser().resolve()
    default_asset, default_binary_name = platform_asset()
    binary_path = runtime_dir / "bin" / default_binary_name
    model_path = runtime_dir / "models" / MODEL_NAME

    try:
        emit("check", 0.04, "Checking denoise runtime", asset=default_asset)
        binary = ensure_binary(binary_path)
        model = ensure_model(model_path)
        print(json.dumps({"binary": str(binary), "model": str(model)}), flush=True)
        return 0
    except Exception as error:
        emit("error", 1, "Denoise setup failed")
        print(str(error), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
