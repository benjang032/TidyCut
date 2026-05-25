import { buildItems, countWords } from "./editorModel.js";

const TRANSCRIBE_URL = "/api/transcribe";

export const DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo";
export const MODEL_OPTIONS = [
  {
    value: "mlx-community/whisper-large-v3-turbo",
    label: "Whisper large v3 turbo",
    size: "1.50 GB",
    pro: "Best default accuracy/speed",
    con: "Large first download",
  },
  {
    value: "mlx-community/whisper-large-v3-mlx",
    label: "Whisper large v3",
    size: "2.87 GB",
    pro: "Highest accuracy option",
    con: "Heaviest and slower",
  },
  {
    value: "mlx-community/whisper-medium-mlx-fp32",
    label: "Whisper medium",
    size: "2.84 GB",
    pro: "Solid accuracy",
    con: "Not much smaller than large",
  },
  {
    value: "mlx-community/whisper-small-mlx-fp32",
    label: "Whisper small",
    size: "0.90 GB",
    pro: "Faster and lighter",
    con: "Worse with noise/accents",
  },
  {
    value: "mlx-community/whisper-tiny",
    label: "Whisper tiny",
    size: "0.07 GB",
    pro: "Fast smoke tests",
    con: "Weak transcription accuracy",
  },
];

export function makeClipId(scope) {
  const randomPart =
    globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `clip_${scope || "x"}_${randomPart}`;
}

export function isObjectURL(url) {
  return typeof url === "string" && url.startsWith("blob:");
}

export function readVideoDurationFromUrl(url) {
  if (!url || typeof document === "undefined") return Promise.resolve(0);

  return new Promise((resolve) => {
    let settled = false;
    const video = document.createElement("video");
    const timer = globalThis.setTimeout(() => finish(0), 5000);

    function finish(duration) {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      resolve(Number.isFinite(duration) && duration > 0 ? duration : 0);
    }

    video.preload = "metadata";
    video.onloadedmetadata = () => finish(video.duration);
    video.onerror = () => finish(0);
    video.src = url;
  });
}

export function buildClipFromTranscript({ projectId, projectDir, videoPath, model, transcript }) {
  const words = Array.isArray(transcript?.words) ? transcript.words : [];
  const source = transcript?.source || {};
  const sourceDuration = Number(source.duration) || 0;
  const items = buildItems(words, { sourceDuration });
  const duration = sourceDuration || items.at(-1)?.end || 0;

  return {
    projectId,
    projectDir,
    videoPath: videoPath || null,
    videoUrl: `/api/projects/${projectId}/video`,
    model: model || null,
    source,
    fileName: source.file_name || "input video",
    sourceMode: source.mode || "managed",
    duration,
    wordCount: countWords(items),
    items,
    cut: new Set(),
  };
}

export function makeUploadClip(file) {
  const id = makeClipId("upload");
  return {
    id,
    mediaSourceId: id,
    projectId: null,
    projectDir: null,
    videoPath: null,
    videoUrl: URL.createObjectURL(file),
    model: null,
    source: { file_name: file.name, mode: "managed" },
    fileName: file.name,
    sourceMode: "managed",
    duration: 0,
    wordCount: 0,
    items: [],
    cut: new Set(),
    trimStart: 0,
    trimEnd: null,
    status: "probing",
    error: null,
    _pending: { file, sourceRef: null },
  };
}

export function makeReferencedClip(reference) {
  const id = makeClipId(reference.projectId);
  return {
    id,
    mediaSourceId: id,
    projectId: reference.projectId,
    projectDir: reference.projectDir,
    videoPath: reference.videoPath,
    videoUrl: reference.videoUrl,
    model: null,
    source: reference.source,
    fileName: reference.fileName,
    sourceMode: reference.mode || "reference",
    duration: Number(reference.duration) || Number(reference.source?.duration) || 0,
    wordCount: 0,
    items: [],
    cut: new Set(),
    trimStart: 0,
    trimEnd: null,
    status: "queued",
    error: null,
    _pending: { file: null, sourceRef: reference },
  };
}

export function buildSourceReference({ projectId, projectDir, videoPath, source }) {
  return {
    projectId,
    projectDir,
    videoPath: videoPath || source?.path || null,
    videoUrl: `/api/projects/${projectId}/video`,
    fileName: source?.file_name || "referenced video",
    source,
    name: source?.file_name || "referenced video",
    mode: source?.mode || "reference",
    duration: Number(source?.duration) || 0,
  };
}

export function applyTranscriptToClip(clip, payload) {
  const transcript = payload.transcript || {};
  const built = buildClipFromTranscript({
    projectId: payload.projectId,
    projectDir: payload.projectDir,
    videoPath: payload.videoPath,
    model: payload.model,
    transcript,
  });
  if (!built.items.length) {
    return {
      ...clip,
      status: "error",
      error: "No word-level timestamps were returned. Try a larger Whisper model.",
    };
  }
  const transcriptSourceDuration = Number(built.source?.duration) || 0;
  const duration = transcriptSourceDuration || clip.duration || built.duration || 0;
  return {
    ...clip,
    ...built,
    id: clip.id,
    videoUrl: isObjectURL(clip.videoUrl) ? clip.videoUrl : built.videoUrl,
    fileName: clip.fileName || built.fileName,
    source: {
      ...built.source,
      duration,
    },
    duration,
    trimStart: 0,
    trimEnd: null,
    status: "ready",
    error: null,
    _pending: undefined,
  };
}

export async function runTranscriptionRequest(pending, model) {
  let response;
  if (pending.sourceRef) {
    response = await fetch(`/api/projects/${pending.sourceRef.projectId}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
  } else if (pending.file) {
    const formData = new FormData();
    formData.append("video", pending.file);
    formData.append("model", model);
    response = await fetch(TRANSCRIBE_URL, { method: "POST", body: formData });
  } else {
    throw new Error("Missing source for transcription.");
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Transcription failed.");
  return payload;
}
