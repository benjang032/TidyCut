import { getClipTrimRange } from "./sequenceModel.js";

export const AI_EDIT_URL = "/api/ai/edit-plan";
export const OPENROUTER_SETTINGS_URL = "/api/settings/openrouter";

function asSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundSeconds(value) {
  return Number(Number(value).toFixed(3));
}

function itemOverlapsRange(item, range) {
  const start = finiteNumber(item?.start);
  const end = finiteNumber(item?.end);
  return Math.max(start, range.start) < Math.min(end, range.end);
}

function itemCenterInRange(item, range) {
  const start = finiteNumber(item?.start);
  const end = finiteNumber(item?.end);
  const center = start + Math.max(0, end - start) / 2;
  return center >= range.start && center < range.end;
}

function clipVisibleTranscriptItems(clip) {
  const range = getClipTrimRange(clip);
  const cut = asSet(clip?.cut);
  return (Array.isArray(clip?.items) ? clip.items : [])
    .filter((item) => {
      if (!itemOverlapsRange(item, range) || !itemCenterInRange(item, range)) return false;
      return !cut.has(item.id);
    })
    .map((item) => {
      const start = Math.max(finiteNumber(item.start), range.start);
      const end = Math.min(finiteNumber(item.end), range.end);
      const duration = Math.max(0, end - start);
      return {
        id: item.id,
        kind: item.kind === "gap" ? "gap" : "word",
        start: roundSeconds(start),
        end: roundSeconds(end),
        duration: roundSeconds(duration),
        text:
          item.kind === "gap"
            ? `[pause ${duration >= 1 ? duration.toFixed(1) : Math.round(duration * 1000)}${
                duration >= 1 ? "s" : "ms"
              }]`
            : String(item.text || "").trim(),
      };
    })
    .filter((item) => item.end > item.start);
}

export function buildAiEditRequestClips(clips = []) {
  return clips
    .filter((clip) => clip?.status === "ready" && Array.isArray(clip.items))
    .map((clip, index) => {
      const range = getClipTrimRange(clip);
      return {
        clip_id: clip.id,
        label: clip.fileName || `Clip ${index + 1}`,
        duration: roundSeconds(finiteNumber(clip.duration, range.end)),
        trim_start: roundSeconds(range.start),
        trim_end: roundSeconds(range.end),
        transcript_items: clipVisibleTranscriptItems(clip),
      };
    })
    .filter((clip) => clip.transcript_items.some((item) => item.kind === "word"));
}

function normalizeTimelineEntry(entry, index, clipById) {
  const sourceClipId = String(entry?.source_clip_id || "");
  const sourceClip = clipById.get(sourceClipId);
  if (!sourceClip) return null;

  const range = getClipTrimRange(sourceClip);
  const start = Math.min(
    Math.max(finiteNumber(entry?.source_start, range.start), range.start),
    range.end
  );
  const end = Math.min(Math.max(finiteNumber(entry?.source_end, range.end), range.start), range.end);
  if (end <= start) return null;

  return {
    editId: String(entry?.edit_id || `edit_${index + 1}`),
    sourceClipId,
    sourceStart: roundSeconds(start),
    sourceEnd: roundSeconds(end),
    text: String(entry?.text || "").trim(),
    sceneType: String(entry?.scene_type || "complete_take"),
    canStandAlone: Boolean(entry?.can_stand_alone),
    reason: String(entry?.reason || "Selected by AI edit.").trim(),
    confidence: Math.min(1, Math.max(0, finiteNumber(entry?.confidence, 0))),
  };
}

export function normalizeAiEditPlan(plan, sourceClips = []) {
  const clipById = new Map(sourceClips.map((clip) => [clip.id, clip]));
  const timeline = (Array.isArray(plan?.timeline) ? plan.timeline : [])
    .map((entry, index) => normalizeTimelineEntry(entry, index, clipById))
    .filter(Boolean);

  return {
    version: "tidycut_ai_edit_v1",
    model: String(plan?.model || ""),
    editingMode: String(plan?.editing_mode || "coherence_story_v1"),
    summary: String(plan?.summary || "").trim(),
    timeline,
    removed: Array.isArray(plan?.removed) ? plan.removed : [],
    warnings: Array.isArray(plan?.warnings) ? plan.warnings : [],
  };
}

export function applyAiEditPlanToClips(sourceClips = [], plan, makeClipId) {
  const normalized = normalizeAiEditPlan(plan, sourceClips);
  const clipById = new Map(sourceClips.map((clip) => [clip.id, clip]));

  const nextClips = normalized.timeline
    .map((entry, index) => {
      const sourceClip = clipById.get(entry.sourceClipId);
      if (!sourceClip) return null;
      return {
        ...sourceClip,
        id:
          typeof makeClipId === "function"
            ? makeClipId(sourceClip, entry, index)
            : `${sourceClip.id}_ai_${index + 1}`,
        trimStart: entry.sourceStart,
        trimEnd: entry.sourceEnd,
        cut: new Set(asSet(sourceClip.cut)),
        aiEdit: {
          editId: entry.editId,
          sourceClipId: entry.sourceClipId,
          sceneType: entry.sceneType,
          canStandAlone: entry.canStandAlone,
          reason: entry.reason,
          confidence: entry.confidence,
          text: entry.text,
        },
      };
    })
    .filter(Boolean);

  return {
    clips: nextClips,
    plan: normalized,
  };
}
