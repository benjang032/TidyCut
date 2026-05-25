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

function normalizeTrimEnd(value, trimStart, duration) {
  const trimEnd = finiteNumberOrNull(value);
  if (trimEnd == null) return null;
  if (trimEnd === 0 && duration > trimStart) return null;
  return trimEnd;
}

function roundSeconds(value) {
  return Number(Number(value).toFixed(3));
}

function legacyCutIdSet(cut) {
  const values = cut instanceof Set ? [...cut] : Array.isArray(cut) ? cut : [];
  return new Set(values.map(stringOrNull).filter(Boolean));
}

function clipTrimRange(clip) {
  const items = Array.isArray(clip?.items) ? clip.items : [];
  const itemEnd = items.length ? finiteNumber(items.at(-1)?.end) : 0;
  const duration = finiteNumber(clip?.duration, itemEnd);
  const fallbackEnd = duration > 0 ? duration : itemEnd;
  const trimStart = Math.max(0, finiteNumber(clip?.trimStart));
  const trimEndRaw = finiteNumberOrNull(clip?.trimEnd);
  const trimEnd = trimEndRaw == null ? fallbackEnd : Math.max(0, trimEndRaw);
  if (fallbackEnd <= 0) {
    return {
      start: Math.min(trimStart, trimEnd),
      end: Math.max(trimStart, trimEnd),
      sourceEnd: fallbackEnd,
    };
  }
  const start = Math.min(Math.max(0, trimStart), fallbackEnd);
  const end = Math.min(Math.max(0, trimEnd), fallbackEnd);
  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
    sourceEnd: fallbackEnd,
  };
}

function mergeSourceRanges(ranges) {
  const merged = [];
  for (const range of ranges) {
    const start = finiteNumber(range.start);
    const end = finiteNumber(range.end);
    if (end <= start) continue;
    const previous = merged.at(-1);
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      merged.push({ start, end });
    }
  }
  return merged;
}

function legacyCutRanges(clip, cutIds, trimRange) {
  const ranges = [];
  let current = null;
  const items = [...(clip?.items || [])].sort(
    (a, b) =>
      finiteNumber(a?.start) - finiteNumber(b?.start) ||
      finiteNumber(a?.end) - finiteNumber(b?.end)
  );

  for (const item of items) {
    if (!cutIds.has(item.id)) {
      current = null;
      continue;
    }

    const start = Math.max(finiteNumber(item.start), trimRange.start);
    const end = Math.min(finiteNumber(item.end), trimRange.end);
    if (end <= start) continue;

    if (!current) {
      current = { start, end };
      ranges.push(current);
    } else {
      current.end = Math.max(current.end, end);
    }
  }

  return mergeSourceRanges(ranges);
}

function subtractSourceRanges(range, rangesToRemove) {
  const kept = [];
  let cursor = range.start;
  for (const removal of mergeSourceRanges(rangesToRemove)) {
    const start = Math.max(range.start, removal.start);
    const end = Math.min(range.end, removal.end);
    if (end <= cursor) continue;
    if (start > cursor) kept.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < range.end) kept.push({ start: cursor, end: range.end });
  return kept;
}

function migrateLegacyCutClip(clip, rawCut, index) {
  const cutIds = legacyCutIdSet(rawCut);
  if (!cutIds.size || !Array.isArray(clip?.items) || !clip.items.length) return [clip];

  const range = clipTrimRange(clip);
  if (range.end <= range.start) return [clip];

  const cutRanges = legacyCutRanges(clip, cutIds, range);
  if (!cutRanges.length) return [clip];

  const keptRanges = subtractSourceRanges(range, cutRanges);
  return keptRanges.map((kept, keptIndex) => ({
    ...clip,
    id: keptIndex === 0 ? clip.id : `${clip.id}_migrated_${index}_${keptIndex}`,
    trimStart: roundSeconds(kept.start),
    trimEnd: Math.abs(kept.end - range.sourceEnd) <= 0.001 ? null : roundSeconds(kept.end),
  }));
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
      },
      index
    ),
    id,
    mediaSourceId: id,
    trimStart: 0,
    trimEnd: null,
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
  const projectId = stringOrNull(clip.projectId);
  const hasPersistedTranscript = projectId && clip.items.length > 0;
  const hasRecoverableSource = projectId && !hasPersistedTranscript;
  const status = hasPersistedTranscript ? "ready" : hasRecoverableSource ? "queued" : "error";

  return {
    ...clip,
    videoUrl: projectId ? `/api/projects/${projectId}/video` : "",
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
    ? rawDocument.clips.flatMap((clip, index) =>
        migrateLegacyCutClip(hydrateClipFromProject(clip, index), clip?.cut, index)
      )
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
