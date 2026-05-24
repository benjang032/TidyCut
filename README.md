# Local Video Editor

Edit video like a notepad.

Drop in a clip, transcribe it locally, select words or pauses, cut what you do
not want, then export a clean MP4.

## Why

- Edit offline. Your video, transcript, cuts, previews, and exports stay on your
  machine.
- Use local models. No hosted transcription API is required.
- Notepad first. Work from readable transcript text instead of a complicated
  timeline.
- Reduce noise and export. Preview denoise/normalization, then render the final
  edit with FFmpeg.

## Run Locally

```bash
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
brew install ffmpeg
npm run dev
```

Open `http://localhost:5173`.

`npm run dev` builds the frontend and serves the app plus API from one local
server.

## What You Can Do

- Transcribe video with local MLX Whisper.
- Cut or restore words and pauses directly in the transcript.
- Add multiple clips, reorder them, split them, and trim them.
- Save and reopen edit projects.
- Generate timeline thumbnails and waveform previews.
- Optional voice denoise with DeepFilterNet3.
- Optional loudness normalization to -16 LUFS / -1.5 dBTP.
- Export the stitched edit as MP4.

## Local Storage

Project data is stored locally:

```text
projects/
models/
```

You can move those folders to another drive:

```bash
LOCAL_EDITOR_PROJECTS="/path/to/projects" \
LOCAL_EDITOR_MODEL_CACHE="/path/to/models/hf" \
npm run dev
```
