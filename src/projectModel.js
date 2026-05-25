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
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
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

function normalizeTrimEnd(value, trimStart, duration) {
  const trimEnd = finiteNumberOrNull(value);
  if (trimEnd == null) return null;
  if (trimEnd === 0 && duration > trimStart) return null;
  return trimEnd;
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
  const mediaSourceId = stringOrNull(clip?.mediaSourceId);
  const items = Array.isArray(clip?.items) ? clip.items.map(normalizeItem) : [];
  const cut = normalizeCut(clip?.cut);
  const status = RESTORABLE_STATUSES.has(clip?.status) ? clip.status : items.length ? "ready" : "queued";
  const duration = finiteNumber(clip?.duration);
  const trimStart = finiteNumber(clip?.trimStart);

  return {
    id,
    mediaSourceId,
    projectId,
    projectDir: stringOrNull(clip?.projectDir),
    videoPath: stringOrNull(clip?.videoPath),
    videoUrl: projectId ? `/api/projects/${projectId}/video` : null,
    model: stringOrNull(clip?.model),
    source: cloneJsonObject(clip?.source),
    fileName: stringOrNull(clip?.fileName) || "Untitled clip",
    sourceMode: stringOrNull(clip?.sourceMode) || stringOrNull(clip?.source?.mode) || "managed",
    duration,
    wordCount: finiteNumberOrNull(clip?.wordCount),
    items,
    cut,
    trimStart,
    trimEnd: normalizeTrimEnd(clip?.trimEnd, trimStart, duration),
    status,
    error: stringOrNull(clip?.error),
  };
}

function mediaSourceKey(clip) {
  const mediaSourceId = stringOrNull(clip?.mediaSourceId);
  if (mediaSourceId) return `source:${mediaSourceId}`;
  const projectId = stringOrNull(clip?.projectId);
  if (projectId) return `project:${projectId}`;
  const videoPath = stringOrNull(clip?.videoPath);
  if (videoPath) return `path:${videoPath}`;
  const videoUrl = stringOrNull(clip?.videoUrl);
  if (videoUrl) return `url:${videoUrl}`;
  return `clip:${stringOrNull(clip?.id) || "unknown"}`;
}

function normalizeMediaSourceForProject(clip, index = 0) {
  const id = stringOrNull(clip?.mediaSourceId) || stringOrNull(clip?.id) || `source_${index}`;
  return {
    ...serializeClipForProject(
      {
        ...clip,
        id,
        mediaSourceId: id,
        trimStart: 0,
        trimEnd: null,
        cut: [],
      },
      index
    ),
    id,
    mediaSourceId: id,
    trimStart: 0,
    trimEnd: null,
    cut: [],
  };
}

function buildSerializedMediaSources(clips = []) {
  const byKey = new Map();
  clips.forEach((clip, index) => {
    const key = mediaSourceKey(clip);
    if (!byKey.has(key)) {
      byKey.set(key, normalizeMediaSourceForProject(clip, index));
    }
  });
  return [...byKey.values()];
}

export function serializeProjectDocument({
  project,
  clips,
  mediaSources,
  activeClipId,
  selectedModel,
  audioProcessing,
}) {
  const now = Date.now();
  const serializedClips = Array.isArray(clips)
    ? clips.map((clip, index) => serializeClipForProject(clip, index))
    : [];
  const serializedMediaSources =
    Array.isArray(mediaSources) && mediaSources.length > 0
      ? buildSerializedMediaSources(mediaSources)
      : buildSerializedMediaSources(serializedClips);
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
    mediaSources: serializedMediaSources,
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

function normalizeHydratedMediaSource(clip, index = 0) {
  const id = stringOrNull(clip?.mediaSourceId) || stringOrNull(clip?.id) || `source_${index}`;
  return {
    ...clip,
    id,
    mediaSourceId: id,
    trimStart: 0,
    trimEnd: null,
    cut: new Set(),
    aiEdit: undefined,
  };
}

function buildHydratedMediaSources(clips = []) {
  const byKey = new Map();
  clips.forEach((clip, index) => {
    const key = mediaSourceKey(clip);
    if (!byKey.has(key)) {
      byKey.set(key, normalizeHydratedMediaSource(clip, index));
    }
  });
  return [...byKey.values()];
}

function findMediaSourceForClip(clip, mediaSources = []) {
  const mediaSourceId = stringOrNull(clip?.mediaSourceId);
  if (mediaSourceId) {
    const byId = mediaSources.find((source) => source.id === mediaSourceId);
    if (byId) return byId;
  }
  const projectId = stringOrNull(clip?.projectId);
  if (projectId) {
    const byProject = mediaSources.find((source) => source.projectId === projectId);
    if (byProject) return byProject;
  }
  const videoPath = stringOrNull(clip?.videoPath);
  if (videoPath) {
    const byPath = mediaSources.find((source) => source.videoPath === videoPath);
    if (byPath) return byPath;
  }
  const videoUrl = stringOrNull(clip?.videoUrl);
  if (videoUrl) {
    const byUrl = mediaSources.find((source) => source.videoUrl === videoUrl);
    if (byUrl) return byUrl;
  }
  return mediaSources.find((source) => source.id === clip?.id) || null;
}

export function hydrateProjectDocument(rawDocument) {
  const now = Date.now();
  const id = stringOrNull(rawDocument?.id);
  const hydratedClips = Array.isArray(rawDocument?.clips)
    ? rawDocument.clips.map((clip, index) => hydrateClipFromProject(clip, index))
    : [];
  const persistedSources = Array.isArray(rawDocument?.mediaSources)
    ? rawDocument.mediaSources
        .map((clip, index) => hydrateClipFromProject(clip, index))
        .map(normalizeHydratedMediaSource)
    : [];
  const mediaSources = persistedSources.length
    ? persistedSources
    : buildHydratedMediaSources(hydratedClips);
  const clips = hydratedClips.map((clip) => {
    if (clip.mediaSourceId) return clip;
    const source = findMediaSourceForClip(clip, mediaSources);
    return source ? { ...clip, mediaSourceId: source.id } : clip;
  });
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
    mediaSources,
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
