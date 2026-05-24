export const EDIT_PROJECTS_URL = "/api/edit-projects";
export const LAST_PROJECT_STORAGE_KEY = "local-editor:last-edit-project-id";
export const PROJECT_DOCUMENT_VERSION = 1;
export const DEFAULT_PROJECT_NAME = "Untitled project";

const DEFAULT_AUDIO_PROCESSING = {
  denoise: false,
  normalize: false,
  loudnessTarget: -16,
  truePeak: -1.5,
  lra: 11,
};

const RESTORABLE_STATUSES = new Set(["ready", "queued", "transcribing", "probing", "error"]);

function stringOrNull(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteNumber(value, fallback = 0) {
  const number = finiteNumberOrNull(value);
  return number == null ? fallback : number;
}

function cloneJsonObject(value, fallback = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeItem(item, index) {
  const id = stringOrNull(item?.id) || `item_${index}`;
  const kind = item?.kind === "gap" ? "gap" : "word";
  return {
    id,
    kind,
    text: kind === "word" ? String(item?.text || "").trim() : "",
    start: finiteNumber(item?.start),
    end: finiteNumber(item?.end),
  };
}

function normalizeCut(cut) {
  const values = cut instanceof Set ? [...cut] : Array.isArray(cut) ? cut : [];
  return values.map(stringOrNull).filter(Boolean);
}

export function cleanProjectName(name) {
  return stringOrNull(name)?.slice(0, 120) || DEFAULT_PROJECT_NAME;
}

export function normalizeAudioProcessing(options) {
  const source = options && typeof options === "object" ? options : {};
  return {
    denoise: Boolean(source.denoise),
    normalize: Boolean(source.normalize),
    loudnessTarget: finiteNumber(source.loudnessTarget, DEFAULT_AUDIO_PROCESSING.loudnessTarget),
    truePeak: finiteNumber(source.truePeak, DEFAULT_AUDIO_PROCESSING.truePeak),
    lra: finiteNumber(source.lra, DEFAULT_AUDIO_PROCESSING.lra),
  };
}

export function serializeClipForProject(clip, index = 0) {
  const projectId = stringOrNull(clip?.projectId);
  const id = stringOrNull(clip?.id) || `clip_${index}`;
  const items = Array.isArray(clip?.items) ? clip.items.map(normalizeItem) : [];
  const cut = normalizeCut(clip?.cut);
  const status = RESTORABLE_STATUSES.has(clip?.status) ? clip.status : items.length ? "ready" : "queued";

  return {
    id,
    projectId,
    projectDir: stringOrNull(clip?.projectDir),
    videoPath: stringOrNull(clip?.videoPath),
    videoUrl: projectId ? `/api/projects/${projectId}/video` : null,
    model: stringOrNull(clip?.model),
    source: cloneJsonObject(clip?.source),
    fileName: stringOrNull(clip?.fileName) || "Untitled clip",
    sourceMode: stringOrNull(clip?.sourceMode) || stringOrNull(clip?.source?.mode) || "managed",
    duration: finiteNumber(clip?.duration),
    wordCount: finiteNumberOrNull(clip?.wordCount),
    items,
    cut,
    trimStart: finiteNumber(clip?.trimStart),
    trimEnd: finiteNumberOrNull(clip?.trimEnd),
    status,
    error: stringOrNull(clip?.error),
  };
}

export function serializeProjectDocument({
  project,
  clips,
  activeClipId,
  selectedModel,
  audioProcessing,
}) {
  const now = Date.now();
  const serializedClips = Array.isArray(clips)
    ? clips.map((clip, index) => serializeClipForProject(clip, index))
    : [];
  const activeId =
    stringOrNull(activeClipId) && serializedClips.some((clip) => clip.id === activeClipId)
      ? activeClipId
      : serializedClips[0]?.id || null;

  return {
    version: PROJECT_DOCUMENT_VERSION,
    id: stringOrNull(project?.id),
    name: cleanProjectName(project?.name),
    createdAt: finiteNumber(project?.createdAt, now),
    updatedAt: finiteNumber(project?.updatedAt, now),
    activeClipId: activeId,
    selectedModel: stringOrNull(selectedModel),
    audioProcessing: normalizeAudioProcessing(audioProcessing),
    clips: serializedClips,
  };
}

export function hydrateClipFromProject(rawClip, index = 0) {
  const clip = serializeClipForProject(rawClip, index);
  const cut = new Set(clip.cut);
  const projectId = stringOrNull(clip.projectId);
  const hasPersistedTranscript = projectId && clip.items.length > 0;
  const hasRecoverableSource = projectId && !hasPersistedTranscript;
  const status = hasPersistedTranscript ? "ready" : hasRecoverableSource ? "queued" : "error";

  return {
    ...clip,
    videoUrl: projectId ? `/api/projects/${projectId}/video` : "",
    cut,
    status,
    error:
      status === "error"
        ? clip.error || "This clip was not saved before transcription finished. Add it again."
        : clip.error,
    _pending: hasRecoverableSource
      ? {
          file: null,
          sourceRef: {
            projectId,
            projectDir: clip.projectDir,
            videoPath: clip.videoPath,
            videoUrl: `/api/projects/${projectId}/video`,
            fileName: clip.fileName,
            source: clip.source,
            mode: clip.sourceMode,
            duration: clip.duration,
          },
        }
      : undefined,
  };
}

export function hydrateProjectDocument(rawDocument) {
  const now = Date.now();
  const id = stringOrNull(rawDocument?.id);
  const clips = Array.isArray(rawDocument?.clips)
    ? rawDocument.clips.map((clip, index) => hydrateClipFromProject(clip, index))
    : [];
  const activeClipId =
    stringOrNull(rawDocument?.activeClipId) &&
    clips.some((clip) => clip.id === rawDocument.activeClipId)
      ? rawDocument.activeClipId
      : clips[0]?.id || null;

  return {
    project: {
      id,
      name: cleanProjectName(rawDocument?.name),
      createdAt: finiteNumber(rawDocument?.createdAt, now),
      updatedAt: finiteNumber(rawDocument?.updatedAt, now),
    },
    clips,
    activeClipId,
    selectedModel: stringOrNull(rawDocument?.selectedModel),
    audioProcessing: normalizeAudioProcessing(rawDocument?.audioProcessing),
  };
}

export function projectDocumentSignature(document) {
  if (!document) return "";
  const { updatedAt, ...stableDocument } = document;
  return JSON.stringify(stableDocument);
}
