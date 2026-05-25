import { computeTimeline, getDurations, getPlainText, SKIP_EPSILON } from "./editorModel.js";

function asSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundSeconds(value) {
  return Number(Number(value).toFixed(3));
}

function hasKnownSourceDuration(clip) {
  return finiteNumber(clip?.duration, 0) > 0;
}

export function getClipTrimRange(clip) {
  const items = Array.isArray(clip?.items) ? clip.items : [];
  const itemEnd = items.length ? finiteNumber(items[items.length - 1].end) : 0;
  const sourceDuration = finiteNumber(clip?.duration, itemEnd);
  const fallbackEnd = sourceDuration > 0 ? sourceDuration : itemEnd;
  const trimStart = Math.max(0, finiteNumber(clip?.trimStart, 0));
  const trimEndRaw = clip?.trimEnd;
  const trimEnd =
    trimEndRaw == null || !Number.isFinite(Number(trimEndRaw))
      ? fallbackEnd
      : Math.max(0, Number(trimEndRaw));
  if (fallbackEnd > 0) {
    const start = Math.min(Math.max(0, trimStart), fallbackEnd);
    const end = Math.min(Math.max(0, trimEnd), fallbackEnd);
    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
    };
  }
  return {
    start: Math.min(trimStart, trimEnd),
    end: Math.max(trimStart, trimEnd),
  };
}

export function getClipVisibleDuration(clip) {
  if (clipStatusReady(clip)) {
    return getClipTimeline(clip).reduce((total, segment) => total + rangeDuration(segment), 0);
  }
  const range = getClipTrimRange(clip);
  return Math.max(0, range.end - range.start);
}

function clipSegmentToRange(segment, range) {
  const sourceStart = Math.max(Number(segment.source_start), range.start);
  const sourceEnd = Math.min(Number(segment.source_end), range.end);
  if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceEnd <= sourceStart) {
    return null;
  }
  return {
    source_start: Number(sourceStart.toFixed(3)),
    source_end: Number(sourceEnd.toFixed(3)),
  };
}

function rangeToSegment(start, end) {
  return {
    source_start: Number(start.toFixed(3)),
    source_end: Number(end.toFixed(3)),
  };
}

function getCutRanges(clip, range) {
  const cut = getExplicitCut(clip);
  const ranges = [];
  let current = null;
  const items = [...(clip?.items || [])].sort(
    (a, b) =>
      finiteNumber(a?.start) - finiteNumber(b?.start) ||
      finiteNumber(a?.end) - finiteNumber(b?.end)
  );

  for (const item of items) {
    if (!cut.has(item.id)) {
      current = null;
      continue;
    }

    const rangeForItem = clipSegmentToRange(
      { source_start: item.start, source_end: item.end },
      range
    );
    if (!rangeForItem) continue;

    if (!current) {
      current = { ...rangeForItem };
      ranges.push(current);
    } else {
      current.source_end = Math.max(current.source_end, rangeForItem.source_end);
    }
  }

  return mergeRanges(ranges).sort(
    (a, b) => a.source_start - b.source_start || a.source_end - b.source_end
  );
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges) {
    const start = finiteNumber(range.source_start);
    const end = finiteNumber(range.source_end);
    if (end <= start) continue;
    const previous = merged[merged.length - 1];
    if (previous && start <= previous.source_end) {
      previous.source_end = Math.max(previous.source_end, end);
    } else {
      merged.push({ source_start: start, source_end: end });
    }
  }
  return merged;
}

function keptSegmentsForRange(range, cutRanges) {
  const kept = [];
  let cursor = range.start;
  for (const cutRange of mergeRanges(cutRanges)) {
    const cutStart = Math.max(range.start, cutRange.source_start);
    const cutEnd = Math.min(range.end, cutRange.source_end);
    if (cutEnd <= cursor) continue;
    if (cutStart > cursor) kept.push(rangeToSegment(cursor, cutStart));
    cursor = Math.max(cursor, cutEnd);
  }
  if (cursor < range.end) kept.push(rangeToSegment(cursor, range.end));
  return kept.filter((segment) => segment.source_end > segment.source_start);
}

function subtractRangesFromSegments(segments, rangesToRemove) {
  const kept = [];
  const removals = mergeRanges(rangesToRemove);
  for (const segment of segments) {
    kept.push(...keptSegmentsForRange({ start: segment.source_start, end: segment.source_end }, removals));
  }
  return kept;
}

function rangeDuration(range) {
  return Math.max(0, finiteNumber(range.source_end) - finiteNumber(range.source_start));
}

function itemOverlapDuration(item, range) {
  const start = Math.max(finiteNumber(item?.start), range.start);
  const end = Math.min(finiteNumber(item?.end), range.end);
  return Math.max(0, end - start);
}

function itemOverlapsRange(item, range) {
  return itemOverlapDuration(item, range) > 0;
}

function itemCenterInRange(item, range) {
  const start = finiteNumber(item?.start);
  const end = finiteNumber(item?.end);
  const center = start + Math.max(0, end - start) / 2;
  return center >= range.start && center < range.end;
}

function getExplicitCut(clip) {
  return asSet(clip?.cut);
}

function getVisibleItems(clip) {
  const range = getClipTrimRange(clip);
  return (clip?.items || []).filter(
    (item) => itemOverlapsRange(item, range) && itemCenterInRange(item, range)
  );
}

function getVisibleCut(clip) {
  const cut = getExplicitCut(clip);
  const visibleIds = new Set(getVisibleItems(clip).map((item) => item.id));
  return new Set([...cut].filter((id) => visibleIds.has(id)));
}

function sequenceItemId(clipId, sourceId) {
  return `${clipId}::${sourceId}`;
}

function clipStatusReady(clip) {
  return !clip?.status || clip.status === "ready";
}

function getClipSourceDuration(clip) {
  const range = getClipTrimRange(clip);
  const sourceDuration =
    finiteNumber(clip?.duration, 0) ||
    finiteNumber(clip?.source?.duration, 0) ||
    finiteNumber(clip?.items?.at(-1)?.end, 0);
  return Math.max(range.end, sourceDuration);
}

function segmentTrimEnd(clip, end) {
  const sourceDuration = getClipSourceDuration(clip);
  return Math.abs(end - sourceDuration) <= SKIP_EPSILON ? null : end;
}

function selectionSet(selection) {
  return selection instanceof Set ? selection : new Set(Array.isArray(selection) ? selection : []);
}

function buildClipItemGroups(transcriptItems) {
  const groups = new Map();
  for (const item of transcriptItems || []) {
    if (!item?.clipId) continue;
    if (!groups.has(item.clipId)) groups.set(item.clipId, []);
    groups.get(item.clipId).push(item);
  }
  return groups;
}

function selectedClipTouchesKeptEdge(clipItems, transcriptCut, selection, direction) {
  const selected = selectionSet(selection);
  const cut = selectionSet(transcriptCut);
  const activeIndexes = [];
  const selectedActiveIndexes = [];

  clipItems.forEach((item, index) => {
    const isCut = cut.has(item.id);
    if (!isCut) activeIndexes.push(index);
    if (!isCut && selected.has(item.id)) selectedActiveIndexes.push(index);
  });

  if (!selectedActiveIndexes.length || !activeIndexes.length) return false;
  if (direction === "left") {
    return Math.min(...selectedActiveIndexes) === Math.min(...activeIndexes);
  }
  return Math.max(...selectedActiveIndexes) === Math.max(...activeIndexes);
}

export function getSelectedClipEdgeExtensionState(
  clips = [],
  transcriptItems = [],
  transcriptCut = new Set(),
  selection = new Set(),
  stepSeconds = 0.1
) {
  const clipItemsById = buildClipItemGroups(transcriptItems);
  const step = Math.max(0, finiteNumber(stepSeconds, 0.1));
  const leftClipIds = [];
  const rightClipIds = [];

  if (step <= 0) {
    return { canExtendLeft: false, canExtendRight: false, leftClipIds, rightClipIds };
  }

  for (const clip of clips || []) {
    if (!clipStatusReady(clip)) continue;
    const clipItems = clipItemsById.get(clip.id) || [];
    if (!clipItems.length) continue;

    const range = getClipTrimRange(clip);
    const sourceDuration = getClipSourceDuration(clip);
    if (
      range.start > SKIP_EPSILON &&
      selectedClipTouchesKeptEdge(clipItems, transcriptCut, selection, "left")
    ) {
      leftClipIds.push(clip.id);
    }
    if (
      sourceDuration > range.end + SKIP_EPSILON &&
      selectedClipTouchesKeptEdge(clipItems, transcriptCut, selection, "right")
    ) {
      rightClipIds.push(clip.id);
    }
  }

  return {
    canExtendLeft: leftClipIds.length > 0,
    canExtendRight: rightClipIds.length > 0,
    leftClipIds,
    rightClipIds,
  };
}

export function extendSelectedClipEdges(
  clips = [],
  transcriptItems = [],
  transcriptCut = new Set(),
  selection = new Set(),
  direction,
  stepSeconds = 0.1
) {
  const state = getSelectedClipEdgeExtensionState(
    clips,
    transcriptItems,
    transcriptCut,
    selection,
    stepSeconds
  );
  const clipIds =
    direction === "left"
      ? new Set(state.leftClipIds)
      : direction === "right"
        ? new Set(state.rightClipIds)
        : new Set();
  if (!clipIds.size) return clips;

  const step = Math.max(0, finiteNumber(stepSeconds, 0.1));
  let changed = false;
  const next = clips.map((clip) => {
    if (!clipIds.has(clip.id)) return clip;

    const range = getClipTrimRange(clip);
    if (direction === "left") {
      const trimStart = roundSeconds(Math.max(0, range.start - step));
      if (Math.abs(trimStart - range.start) <= SKIP_EPSILON) return clip;
      changed = true;
      return { ...clip, trimStart };
    }

    const sourceDuration = getClipSourceDuration(clip);
    const trimEnd = roundSeconds(Math.min(sourceDuration, range.end + step));
    if (Math.abs(trimEnd - range.end) <= SKIP_EPSILON) return clip;
    changed = true;
    return {
      ...clip,
      trimEnd: Math.abs(trimEnd - sourceDuration) <= SKIP_EPSILON ? null : trimEnd,
    };
  });

  return changed ? next : clips;
}

function getTrimmedTimeline(clip) {
  const range = getClipTrimRange(clip);
  if (hasKnownSourceDuration(clip)) {
    return keptSegmentsForRange(range, getCutRanges(clip, range));
  }
  const explicit = getExplicitCut(clip);
  return computeTimeline(clip?.items || [], explicit)
    .map((segment) => clipSegmentToRange(segment, range))
    .filter(Boolean);
}

function getTrimmedDurations(clip) {
  const range = getClipTrimRange(clip);
  if (hasKnownSourceDuration(clip)) {
    const total = Math.max(0, range.end - range.start);
    const cutTotal = mergeRanges(getCutRanges(clip, range)).reduce(
      (sum, cutRange) => sum + rangeDuration(cutRange),
      0
    );
    return { total, cut: cutTotal, kept: total - cutTotal };
  }
  const cut = getExplicitCut(clip);
  let total = 0;
  let cutTotal = 0;
  for (const item of clip?.items || []) {
    const overlap = itemOverlapDuration(item, range);
    total += overlap;
    if (cut.has(item.id)) cutTotal += overlap;
  }
  return { total, cut: cutTotal, kept: total - cutTotal };
}

export function getClipTimeline(clip) {
  return getTrimmedTimeline(clip);
}

export function getClipDurations(clip) {
  if (hasKnownSourceDuration(clip)) {
    return getTrimmedDurations(clip);
  }
  const range = getClipTrimRange(clip);
  if (range.start <= 0 && range.end === finiteNumber(clip?.items?.at(-1)?.end, range.end)) {
    return getDurations(clip?.items || [], getExplicitCut(clip));
  }
  return getTrimmedDurations(clip);
}

export function getClipPlainText(clip) {
  return getPlainText(getVisibleItems(clip), getVisibleCut(clip));
}

export function getSequenceDurations(clips = []) {
  return clips.reduce(
    (total, clip) => {
      const durations = getClipDurations(clip);
      return {
        total: total.total + durations.total,
        cut: total.cut + durations.cut,
        kept: total.kept + durations.kept,
      };
    },
    { total: 0, cut: 0, kept: 0 }
  );
}

export function getSequencePlainText(clips = []) {
  return clips
    .map((clip) => getClipPlainText(clip))
    .filter(Boolean)
    .join("\n\n");
}

export function buildSequencePlaybackEntries(clips = []) {
  const entries = [];
  let sequenceCursor = 0;

  for (const clip of clips) {
    const range = getClipTrimRange(clip);
    const ranges = clipStatusReady(clip)
      ? getClipTimeline(clip)
      : range.end > range.start
        ? [rangeToSegment(range.start, range.end)]
        : [];

    for (const segment of ranges) {
      const duration = rangeDuration(segment);
      if (duration <= 0) continue;
      entries.push({
        clipId: clip.id,
        clip,
        sourceStart: segment.source_start,
        sourceEnd: segment.source_end,
        sequenceStart: sequenceCursor,
        sequenceEnd: sequenceCursor + duration,
        duration,
        ready: clipStatusReady(clip) && duration > 0,
      });
      sequenceCursor += duration;
    }
  }

  return entries;
}

export function sourceTimeToSequenceTime(clips = [], clipId, sourceTime = 0) {
  const time = finiteNumber(sourceTime, 0);
  let sequenceCursor = 0;

  for (const clip of clips) {
    const ranges = clipStatusReady(clip)
      ? getClipTimeline(clip)
      : (() => {
          const range = getClipTrimRange(clip);
          return range.end > range.start ? [rangeToSegment(range.start, range.end)] : [];
        })();

    if (clip.id === clipId) {
      if (!ranges.length) return sequenceCursor;

      for (const segment of ranges) {
        const duration = rangeDuration(segment);
        if (duration <= 0) continue;
        if (time <= segment.source_start) return sequenceCursor;
        if (time < segment.source_end) return sequenceCursor + (time - segment.source_start);
        sequenceCursor += duration;
      }

      return sequenceCursor;
    }

    sequenceCursor += ranges.reduce((total, segment) => total + rangeDuration(segment), 0);
  }

  return 0;
}

export function sequenceTimeToSourceTime(clips = [], sequenceTime = 0) {
  const entries = buildSequencePlaybackEntries(clips);
  if (!entries.length) return null;
  const time = Math.max(0, finiteNumber(sequenceTime, 0));

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const isLast = index === entries.length - 1;
    if (time < entry.sequenceStart) continue;
    if (time >= entry.sequenceEnd && !(isLast && time <= entry.sequenceEnd)) continue;
    if (!entry.ready) return null;
    return {
      clipId: entry.clipId,
      sourceTime: Math.min(entry.sourceEnd, entry.sourceStart + (time - entry.sequenceStart)),
      entry,
    };
  }

  const last = entries[entries.length - 1];
  if (!last?.ready) return null;
  return {
    clipId: last.clipId,
    sourceTime: last.sourceEnd,
    entry: last,
  };
}

export function getNextReadyPlaybackEntry(clips = [], clipId) {
  const clipIndex = clips.findIndex((clip) => clip.id === clipId);
  if (clipIndex < 0) return null;
  const laterClipIds = new Set(clips.slice(clipIndex + 1).map((clip) => clip.id));
  return (
    buildSequencePlaybackEntries(clips).find(
      (entry) => entry.ready && laterClipIds.has(entry.clipId)
    ) || null
  );
}

export function getFirstReadyPlaybackEntry(clips = []) {
  return buildSequencePlaybackEntries(clips).find((entry) => entry.ready) || null;
}

export function isSequencePlaybackComplete(
  clips = [],
  activeClipId,
  sourceTime = 0,
  sequenceTime = 0
) {
  const readyEntries = buildSequencePlaybackEntries(clips).filter((entry) => entry.ready);
  const last = readyEntries.at(-1);
  if (!last) return false;
  const sourceAtEnd =
    activeClipId === last.clipId && finiteNumber(sourceTime) >= last.sourceEnd - SKIP_EPSILON;
  const sequenceAtEnd = finiteNumber(sequenceTime) >= last.sequenceEnd - SKIP_EPSILON;
  return sourceAtEnd || sequenceAtEnd;
}

export function buildSequenceTranscriptItems(clips = []) {
  const sequenceItems = [];
  let sequenceCursor = 0;

  clips.forEach((clip, clipIndex) => {
    const range = getClipTrimRange(clip);
    const fallbackSegment = range.end > range.start ? [rangeToSegment(range.start, range.end)] : [];
    const segments = clipStatusReady(clip) ? getClipTimeline(clip) : fallbackSegment;
    if (!clipStatusReady(clip) || !Array.isArray(clip.items) || !segments.length) {
      sequenceCursor += segments.reduce((total, segment) => total + rangeDuration(segment), 0);
      return;
    }

    let emittedForClip = 0;
    for (const segment of segments) {
      const segmentRange = { start: segment.source_start, end: segment.source_end };
      const segmentCursor = sequenceCursor;

      for (const item of clip.items) {
        if (!itemCenterInRange(item, segmentRange)) continue;
        const start = Math.max(finiteNumber(item.start), segmentRange.start);
        const end = Math.min(finiteNumber(item.end), segmentRange.end);
        if (end <= start) continue;

        sequenceItems.push({
          ...item,
          id: sequenceItemId(clip.id, item.id),
          sourceId: item.id,
          sourceStart: finiteNumber(item.start),
          sourceEnd: finiteNumber(item.end),
          start,
          end,
          clipId: clip.id,
          clipIndex,
          clipName: clip.fileName || `Clip ${clipIndex + 1}`,
          sequenceStart: segmentCursor + (start - segmentRange.start),
          sequenceEnd: segmentCursor + (end - segmentRange.start),
          isClipStart: emittedForClip === 0,
        });
        emittedForClip += 1;
      }

      sequenceCursor += rangeDuration(segment);
    }
  });

  return sequenceItems;
}

export function getSequenceTranscriptCut(clips = [], transcriptItems = buildSequenceTranscriptItems(clips)) {
  const cutsByClip = new Map(clips.map((clip) => [clip.id, getExplicitCut(clip)]));
  return new Set(
    transcriptItems
      .filter((item) => cutsByClip.get(item.clipId)?.has(item.sourceId))
      .map((item) => item.id)
  );
}

export function applySequenceTranscriptCut(clips = [], transcriptItems = [], transcriptCut = new Set()) {
  const visibleByClip = new Map();
  const cutByClip = new Map();

  for (const item of transcriptItems) {
    if (!item?.clipId || !item?.sourceId) continue;
    if (!visibleByClip.has(item.clipId)) visibleByClip.set(item.clipId, new Set());
    visibleByClip.get(item.clipId).add(item.sourceId);

    if (transcriptCut.has(item.id)) {
      if (!cutByClip.has(item.clipId)) cutByClip.set(item.clipId, new Set());
      cutByClip.get(item.clipId).add(item.sourceId);
    }
  }

  if (!visibleByClip.size) return clips;

  let changed = false;
  const next = clips.map((clip) => {
    const visibleIds = visibleByClip.get(clip.id);
    if (!visibleIds) return clip;

    const currentCut = getExplicitCut(clip);
    const nextCut = new Set(currentCut);
    for (const id of visibleIds) nextCut.delete(id);
    for (const id of cutByClip.get(clip.id) || []) nextCut.add(id);

    if (setsEqual(currentCut, nextCut)) return clip;
    changed = true;
    return { ...clip, cut: nextCut };
  });

  return changed ? next : clips;
}

export function deleteSequenceTranscriptSelection(
  clips = [],
  transcriptItems = [],
  selection = new Set(),
  makeClipId
) {
  const selected = selectionSet(selection);
  if (!selected.size) return clips;

  const selectedByClip = new Map();
  const visibleByClip = new Map();
  for (const item of transcriptItems) {
    if (!item?.clipId || !item?.sourceId) continue;
    if (!visibleByClip.has(item.clipId)) visibleByClip.set(item.clipId, new Set());
    visibleByClip.get(item.clipId).add(item.id);
    if (!selected.has(item.id)) continue;
    if (!selectedByClip.has(item.clipId)) selectedByClip.set(item.clipId, []);
    selectedByClip.get(item.clipId).push(item);
  }
  if (!selectedByClip.size) return clips;

  let changed = false;
  const next = [];

  for (const clip of clips) {
    const selectedItems = selectedByClip.get(clip.id) || [];
    if (!selectedItems.length || !clipStatusReady(clip)) {
      next.push(clip);
      continue;
    }

    const visibleIds = visibleByClip.get(clip.id) || new Set();
    const allVisibleSelected =
      visibleIds.size > 0 && [...visibleIds].every((id) => selected.has(id));
    const range = getClipTrimRange(clip);
    const existingSegments = getClipTimeline(clip);
    const deleteRanges = allVisibleSelected
      ? [rangeToSegment(range.start, range.end)]
      : selectedItems
          .map((item) =>
            clipSegmentToRange(
              {
                source_start: item.sourceStart ?? item.start,
                source_end: item.sourceEnd ?? item.end,
              },
              range
            )
          )
          .filter(Boolean);
    const keptSegments = subtractRangesFromSegments(existingSegments, deleteRanges);

    if (!keptSegments.length) {
      changed = true;
      continue;
    }

    keptSegments.forEach((segment, segmentIndex) => {
      const sourceStart = roundSeconds(segment.source_start);
      const sourceEnd = roundSeconds(segment.source_end);
      const id =
        segmentIndex === 0
          ? clip.id
          : makeClipId
            ? makeClipId(clip)
            : `${clip.id}_cut_${segmentIndex + 1}`;
      next.push({
        ...clip,
        id,
        trimStart: sourceStart,
        trimEnd: segmentTrimEnd(clip, sourceEnd),
        cut: new Set(),
      });
    });
    changed = true;
  }

  return changed ? next : clips;
}

export function buildSequenceRenderClips(clips = []) {
  return clips
    .map((clip) => ({
      clipId: clip.id,
      projectId: clip.projectId,
      label: clip.fileName || clip.projectId,
      timeline: getClipTimeline(clip),
    }))
    .filter((clip) => clip.projectId && clip.timeline.length > 0);
}

export function moveClipBefore(clips, srcId, targetId, side = "before") {
  if (srcId === targetId) return clips;
  const srcIndex = clips.findIndex((clip) => clip.id === srcId);
  const targetIndex = clips.findIndex((clip) => clip.id === targetId);
  if (srcIndex < 0 || targetIndex < 0) return clips;

  const next = [...clips];
  const [src] = next.splice(srcIndex, 1);
  let insertIndex = next.findIndex((clip) => clip.id === targetId);
  if (insertIndex < 0) return clips;
  if (side === "after") insertIndex += 1;
  next.splice(insertIndex, 0, src);
  return next;
}

export function splitClip(clips, clipId, time, makeId) {
  const index = clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return clips;
  const clip = clips[index];
  if (clip.status && clip.status !== "ready") return clips;
  const { start: trimStart, end: trimEnd } = getClipTrimRange(clip);
  if (time <= trimStart + 0.05 || time >= trimEnd - 0.05) return clips;

  const left = { ...clip, trimEnd: time };
  const right = {
    ...clip,
    id: makeId ? makeId(clip) : `${clip.id}_split_${Math.random().toString(16).slice(2, 8)}`,
    trimStart: time,
    cut: new Set(asSet(clip.cut)),
  };
  const next = [...clips];
  next.splice(index, 1, left, right);
  return next;
}
