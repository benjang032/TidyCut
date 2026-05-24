# Local Video Editor

A local-first video transcript editor. Drop in a video, transcribe it on your
machine, and edit the transcript like a notepad that stays tied to the source
video.

No hosted transcription API is required. Video files, extracted audio,
transcripts, edit decisions, and model caches stay on your machine unless you
move them yourself.

## Run

```bash
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run dev
```

Open `http://localhost:5173`.

## What It Does

Choose a video, click `Transcribe`, and the backend runs local MLX Whisper
through `scripts/transcribe_local.py`. The transcript appears as editable
timestamped text beside the video. Clicking a timestamp jumps the video to that
line.

Before transcription, the backend runs local Silero VAD and sends only detected
speech ranges into MLX Whisper. The resulting word timestamps stay mapped to the
original video timeline, so playback and cuts still line up with the source.

Generated project files are stored under:

```text
projects/<project-id>/
├── input.<ext>
├── audio.wav
└── transcript.json
```

Whisper models are cached under `models/hf` by default. Silero VAD is installed
from the pinned Python package in `requirements.txt`.

## Features

- Local transcription with MLX Whisper.
- Word-level timestamps for transcript-driven editing.
- Silero VAD before transcription, so long silences do not confuse the model.
- Model picker with size and tradeoff notes.
- Text-first cut/restore workflow.
- FFmpeg render path for exporting the edited video.
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

You can also move project/model storage to any local folder, including an
external SSD:

```bash
LOCAL_EDITOR_PROJECTS="/path/to/projects" \
LOCAL_EDITOR_MODEL_CACHE="/path/to/models/hf" \
npm run dev
```

`npm run dev` builds the frontend and serves the app plus API from one local server on port `5173`, so there is no Vite HMR WebSocket. Use `npm run dev:vite` only if you specifically want Vite's hot-reload dev server.
