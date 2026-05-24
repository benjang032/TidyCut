# Local Video Editor

A local-first video transcript editor. Drop in a video, transcribe it on your
machine, edit each transcript like a notepad that stays tied to the source
video, then arrange file references into a simple sequence for export.

No hosted transcription API is required. Video files, extracted audio,
transcripts, edit decisions, and model caches stay on your machine unless you
move them yourself.

## Try It Locally

```bash
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run dev
```

Open `http://localhost:5173`.

You also need FFmpeg available on your machine:

```bash
brew install ffmpeg
```

This project is local-first by design. The easiest public demo today is a short
screen recording plus the GitHub repo; the easiest nontechnical install path is
a signed desktop app release, not a hosted cloud deployment.

## Current Deployment Status

As of May 24, 2026, the working deployment target is the local single-server
build:

```bash
npm run dev
```

That command builds the Vite frontend and serves the static app plus Express API
from `http://localhost:5173`. This is the path used for current testing and
demo recording. There is no hosted cloud deployment configured because source
video, transcription, thumbnails, audio previews, and FFmpeg renders are all
designed to run on the user's machine.

## Distribution Plan

For nontechnical testers, package this as a desktop app for macOS first. A
desktop build can bundle the web UI, local Node server, Python runtime, FFmpeg
checks, and setup flow behind one app icon while still keeping video files and
models on the user's machine.

Recommended rollout:

1. GitHub repo for developers and contributors.
2. GitHub Releases with a signed/notarized macOS `.dmg` for creators who just
   want to try it.
3. A lightweight landing page with a video demo, screenshots, download link, and
   privacy/storage explanation.
4. Later, optional Docker packaging for technical users on Linux/Windows.

A hosted deployment is not the best default for this app. Uploading large video
files to a server would make the app slower, more expensive, less private, and
harder to operate because transcription and rendering are long-running local
compute jobs.

## What It Does

Reference a local video path, click `Transcribe clip`, and the backend runs
local MLX Whisper through `scripts/transcribe_local.py`. The transcript appears
as editable timestamped text beside the video. Clicking a timestamp jumps the
video to that line.

Before transcription, the backend runs local Silero VAD and sends only detected
speech ranges into MLX Whisper. The resulting word timestamps stay mapped to the
original video timeline, so playback and cuts still line up with the source.

Each transcribed video becomes a clip in the sequence strip. You can add more
clips from local file references, fallback uploads, or recent local projects,
select a clip to edit its transcript, reorder clips, remove clips, and download
one stitched MP4.

The editor also keeps an autosaved edit project for the whole workspace. Use
`New` to start a clean edit project and `Open` to load previous sequence work;
the current project is restored after a page reload.

Generated project files are stored under:

```text
projects/<project-id>/
├── project.json
├── audio.wav
└── transcript.json

projects/_edit-projects/<edit-project-id>/
└── edit-project.json
```

When you use `Reference path`, the original video stays at its existing path.
The project stores only metadata, extracted audio, transcript JSON, edit plans,
and render outputs. `Upload copy` remains available as a fallback when you
intentionally want the app to manage a copied source file.

Whisper models are cached under `models/hf` by default. Silero VAD is installed
from the pinned Python package in `requirements.txt`.

## Features

- Local transcription with MLX Whisper.
- Word-level timestamps for transcript-driven editing.
- Silero VAD before transcription, so long silences do not confuse the model.
- Model picker with size and tradeoff notes.
- Local media references that avoid copying source video files.
- Text-first cut/restore workflow per clip.
- Multi-clip sequence strip for selecting, reordering, and removing clips.
- Autosaved edit projects with New/Open workflow and reload restore.
- FFmpeg render path for exporting the stitched edit.
- Optional export-time voice denoise with DeepFilterNet3.
- Optional export-time loudness normalization to -16 LUFS / -1.5 dBTP.
- Background audio previews for the denoise/normalize toggles during playback.
- Portable project folders for source video, extracted audio, transcript JSON,
  and outputs.

## Models

The default model is `mlx-community/whisper-large-v3-turbo`.

The app header also has a model dropdown, so you can choose the transcription model before clicking `Transcribe`.

You can override the startup default:

```bash
LOCAL_EDITOR_MODEL=mlx-community/whisper-large-v3-turbo npm run dev
```

VAD is enabled by default. To compare against full-audio transcription:

```bash
LOCAL_EDITOR_VAD=0 npm run dev
```

The `Denoise` toggle uses DeepFilterNet3 for both preview playback and export.
On first use, the backend downloads a platform-specific `deep-filter` runtime
and the DeepFilterNet3 ONNX model into the project folder:

```text
models/denoise/deepfilternet/
├── bin/deep-filter
└── models/DeepFilterNet3_onnx.tar.gz
```

## Media Storage Model

The editor keeps source media as referenced assets and stores splits, trims,
reorders, transcript cuts, and audio settings as metadata. Splitting a clip does
not copy the original video; it creates another timeline clip that points at the
same source with a different source-time range.

Generated files such as thumbnails, waveforms, denoised/normalized audio
previews, and export renders live under the project/cache folders and can be
regenerated from the original media.

You can also move project/model storage to any local folder, including an
external SSD:

```bash
LOCAL_EDITOR_PROJECTS="/path/to/projects" \
LOCAL_EDITOR_MODEL_CACHE="/path/to/models/hf" \
npm run dev
```

`npm run dev` builds the frontend and serves the app plus API from one local server on port `5173`, so there is no Vite HMR WebSocket. Use `npm run dev:vite` only if you specifically want Vite's hot-reload dev server.
