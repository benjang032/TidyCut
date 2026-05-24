import {
  ChevronsLeft,
  ChevronsRight,
  FileSymlink,
  Film,
  Loader2,
  Plus,
  RotateCcw,
  Scissors,
  Trash2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatClock } from "../editorModel";
import { getClipCutRanges, getClipTrimRange, getClipVisibleDuration } from "../sequenceModel";

const CLIP_MIME = "application/x-local-editor-clip";
const PLACEHOLDER_DURATION_SECONDS = 30;
const MIN_PIXELS_PER_SECOND = 4;
const MAX_PIXELS_PER_SECOND = 80;
const DEFAULT_PIXELS_PER_SECOND = 18;
const ZOOM_FACTOR = 1.18;
const SNAP_TOLERANCE_PX = 12;
const TIME_STEP_SECONDS = 1 / 30;
const MIN_TRIM_DURATION_SECONDS = 0.1;
const ADD_BUTTON_WIDTH = 44;
const ADD_BUTTON_GAP = 6;

function dragHasVideoFiles(event) {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
}

function dragHasClip(event) {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === CLIP_MIME) return true;
  }
  return false;
}

function visibleDuration(clip) {
  const duration = getClipVisibleDuration(clip);
  if (duration > 0) return duration;
  return PLACEHOLDER_DURATION_SECONDS;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function quantizeTime(seconds) {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.round(seconds / TIME_STEP_SECONDS) * TIME_STEP_SECONDS);
}

function layoutClips(clips, pps) {
  let cursor = 0;
  return clips.map((clip) => {
    const width = Math.max(2, visibleDuration(clip) * pps);
    const block = { clipId: clip.id, x: cursor, width };
    cursor += width;
    return block;
  });
}

function pickRulerStep(pps) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((step) => step * pps >= 84) || steps.at(-1);
}

function buildRulerTicks(totalDuration, pps) {
  const majorStep = pickRulerStep(pps);
  const minorStep = Math.max(1, majorStep / 4);
  const ticks = [];
  for (let time = 0; time <= totalDuration + 0.001; time += minorStep) {
    const rounded = Number(time.toFixed(3));
    const isMajor = Math.abs(rounded / majorStep - Math.round(rounded / majorStep)) < 0.001;
    ticks.push({
      time: rounded,
      x: rounded * pps,
      major: isMajor,
      label: isMajor ? formatClock(rounded) : null,
    });
  }
  return ticks;
}

function buildWaveformBarPath(peaks) {
  if (!Array.isArray(peaks) || peaks.length === 0) return "";

  const normalized = peaks.map((value) => Math.max(0.025, Math.min(1, Number(value) || 0)));
  return normalized
    .map((peak, index) => {
      const x = Number((((index + 0.5) / normalized.length) * 100).toFixed(3));
      const height = peak * 47;
      const top = Number((50 - height).toFixed(3));
      const bottom = Number((50 + height).toFixed(3));
      return `M ${x} ${top} L ${x} ${bottom}`;
    })
    .join(" ");
}

function decorateTimelineAsset(payload) {
  if (!payload?.waveform?.peaks) return payload;
  return {
    ...payload,
    waveform: {
      ...payload.waveform,
      barsPath: buildWaveformBarPath(payload.waveform.peaks),
    },
  };
}

function useTimelineAssets(clips) {
  const [assetsByProject, setAssetsByProject] = useState({});

  useEffect(() => {
    const projectIds = [
      ...new Set(
        clips
          .filter((clip) => clip.status === "ready" && clip.projectId)
          .map((clip) => clip.projectId)
      ),
    ];

    for (const projectId of projectIds) {
      if (assetsByProject[projectId]) continue;

      setAssetsByProject((current) => ({
        ...current,
        [projectId]: { status: "loading", data: null, error: null },
      }));

      fetch(`/api/projects/${projectId}/timeline-assets`)
        .then((response) => {
          if (!response.ok) throw new Error(`Timeline assets failed (${response.status})`);
          return response.json();
        })
        .then((payload) => {
          setAssetsByProject((current) => ({
            ...current,
            [projectId]: { status: "ready", data: decorateTimelineAsset(payload), error: null },
          }));
        })
        .catch((error) => {
          setAssetsByProject((current) => ({
            ...current,
            [projectId]: {
              status: "error",
              data: null,
              error: error instanceof Error ? error.message : String(error),
            },
          }));
        });
    }
  }, [assetsByProject, clips]);

  return assetsByProject;
}

export function Timeline({
  clips,
  activeClipId,
  videoTime,
  sequenceTime,
  isPlaying,
  onChooseVideo,
  onFilesSelected,
  onReferencePath,
  onSelectClip,
  onReorderClip,
  onRemoveClip,
  onRetryClip,
  onSetClipTrim,
  onSplitActiveClip,
  onSeekToSequenceTime,
  onScrubStart,
  onScrubEnd,
}) {
  const [pps, setPps] = useState(DEFAULT_PIXELS_PER_SECOND);
  const [isFileDrag, setIsFileDrag] = useState(false);
  const [dragInfo, setDragInfo] = useState(null);
  const fileDragDepthRef = useRef(0);
  const trackRef = useRef(null);
  const activeSnapRef = useRef(null);
  const assetsByProject = useTimelineAssets(clips);

  const isEmpty = clips.length === 0;
  const blocks = useMemo(() => layoutClips(clips, pps), [clips, pps]);
  const totalWidth = blocks.length ? blocks[blocks.length - 1].x + blocks[blocks.length - 1].width : 0;
  const totalDuration = blocks.length ? totalWidth / pps : 0;
  const rulerTicks = useMemo(() => buildRulerTicks(totalDuration, pps), [pps, totalDuration]);
  const activeBlock = blocks.find((b) => b.clipId === activeClipId) || null;
  const activeClip = clips.find((c) => c.id === activeClipId) || null;
  const activeTrim = activeClip ? getClipTrimRange(activeClip) : null;
  const playheadX = activeBlock
    ? clamp((Number(sequenceTime) || 0) * pps, 0, Math.max(0, totalWidth))
    : null;

  const activeClipReady = activeClip?.status === "ready";
  const canCutLeft =
    activeClipReady &&
    activeTrim &&
    videoTime > activeTrim.start &&
    videoTime < activeTrim.end - MIN_TRIM_DURATION_SECONDS;
  const canCutRight =
    activeClipReady &&
    activeTrim &&
    videoTime > activeTrim.start + MIN_TRIM_DURATION_SECONDS &&
    videoTime < activeTrim.end;

  const onCutLeft = useCallback(() => {
    if (!canCutLeft || !activeClip) return;
    onSetClipTrim(activeClip.id, { trimStart: quantizeTime(videoTime) });
  }, [activeClip, canCutLeft, onSetClipTrim, videoTime]);

  const onCutRight = useCallback(() => {
    if (!canCutRight || !activeClip) return;
    onSetClipTrim(activeClip.id, { trimEnd: quantizeTime(videoTime) });
  }, [activeClip, canCutRight, onSetClipTrim, videoTime]);

  const snapTargets = useMemo(() => {
    const targets = [{ label: "sequence:start", x: 0 }];
    for (const block of blocks) {
      targets.push(
        { label: `${block.clipId}:start`, x: block.x },
        { label: `${block.clipId}:end`, x: block.x + block.width }
      );
    }
    if (playheadX != null) targets.push({ label: "playhead", x: playheadX });
    return targets;
  }, [blocks, playheadX]);

  const resetSnap = useCallback((key = null) => {
    if (!key || activeSnapRef.current?.key === key) {
      activeSnapRef.current = null;
    }
  }, []);

  const snapSequenceX = useCallback(
    (rawX, key, excludeLabels = []) => {
      const maxX = Math.max(0, totalWidth - 0.001);
      const x = clamp(rawX, 0, maxX);
      const excluded = new Set(excludeLabels);
      const active = activeSnapRef.current;

      if (active?.key === key && !excluded.has(active.label)) {
        const activeTarget = snapTargets.find((target) => target.label === active.label);
        if (activeTarget && Math.abs(activeTarget.x - x) <= SNAP_TOLERANCE_PX) {
          return clamp(activeTarget.x, 0, maxX);
        }
      }

      let nearest = null;
      for (const target of snapTargets) {
        if (excluded.has(target.label)) continue;
        const distance = Math.abs(target.x - x);
        if (distance > SNAP_TOLERANCE_PX) continue;
        if (!nearest || distance < nearest.distance) {
          nearest = { ...target, distance };
        }
      }

      if (nearest) {
        activeSnapRef.current = { key, label: nearest.label };
        return clamp(nearest.x, 0, maxX);
      }

      resetSnap(key);
      return x;
    },
    [resetSnap, snapTargets, totalWidth]
  );

  const zoomAt = useCallback((factor, clientX = null) => {
    const scroll = trackRef.current;
    setPps((value) => {
      const next = Math.min(
        MAX_PIXELS_PER_SECOND,
        Math.max(MIN_PIXELS_PER_SECOND, Math.round(value * factor))
      );
      if (scroll && clientX != null && next !== value) {
        const rect = scroll.getBoundingClientRect();
        const anchorX = clientX - rect.left;
        const anchorTime = (scroll.scrollLeft + anchorX) / value;
        requestAnimationFrame(() => {
          scroll.scrollLeft = Math.max(0, anchorTime * next - anchorX);
        });
      }
      return next;
    });
  }, []);

  const getPlayheadClientX = useCallback(() => {
    const scroll = trackRef.current;
    if (!scroll || playheadX == null) return null;
    const rect = scroll.getBoundingClientRect();
    const clientX = rect.left + playheadX - scroll.scrollLeft;
    if (clientX >= rect.left && clientX <= rect.right) return clientX;
    return rect.left + rect.width / 2;
  }, [playheadX]);

  const onZoomIn = () => zoomAt(ZOOM_FACTOR, getPlayheadClientX());
  const onZoomOut = () => zoomAt(1 / ZOOM_FACTOR, getPlayheadClientX());

  const onTimelineWheel = useCallback(
    (event) => {
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        zoomAt(event.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR, event.clientX);
        return;
      }

      if (event.shiftKey) {
        const scroll = trackRef.current;
        if (!scroll) return;
        event.preventDefault();
        scroll.scrollLeft += event.deltaY || event.deltaX;
      }
    },
    [zoomAt]
  );

  const seekFromClientX = useCallback(
    (clientX, options = {}) => {
      const scroll = trackRef.current;
      if (!scroll) return;
      const rect = scroll.getBoundingClientRect();
      if (totalWidth <= 0) return;
      const rawX = clientX - rect.left + scroll.scrollLeft;
      const x =
        options.snap === false
          ? clamp(rawX, 0, totalWidth)
          : snapSequenceX(rawX, options.snapKey || "seek");
      const sequenceTime = clamp(quantizeTime(x / pps), 0, totalDuration);
      onSeekToSequenceTime(sequenceTime, { scrubbing: Boolean(options.scrubbing) });
    },
    [onSeekToSequenceTime, pps, snapSequenceX, totalDuration, totalWidth]
  );

  const startTimelineScrub = useCallback(
    (event, snapKey = "ruler") => {
      if (event.button !== 0) return;
      event.preventDefault();
      resetSnap();
      onScrubStart?.();
      seekFromClientX(event.clientX, { snap: false, snapKey, scrubbing: true });

      const onMove = (moveEvent) => {
        moveEvent.preventDefault();
        seekFromClientX(moveEvent.clientX, { snap: false, snapKey, scrubbing: true });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        resetSnap();
        onScrubEnd?.();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [onScrubEnd, onScrubStart, resetSnap, seekFromClientX]
  );
  const startRulerDrag = useCallback(
    (event) => startTimelineScrub(event, "ruler"),
    [startTimelineScrub]
  );
  const startPlayheadDrag = useCallback(
    (event) => startTimelineScrub(event, "playhead"),
    [startTimelineScrub]
  );

  // File drag-and-drop on the strip.
  const onDragEnter = useCallback((event) => {
    if (!dragHasVideoFiles(event)) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setIsFileDrag(true);
  }, []);
  const onDragOver = useCallback((event) => {
    if (!dragHasVideoFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);
  const onDragLeave = useCallback(() => {
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setIsFileDrag(false);
  }, []);
  const onDrop = useCallback(
    (event) => {
      if (dragHasClip(event)) return;
      event.preventDefault();
      fileDragDepthRef.current = 0;
      setIsFileDrag(false);
      const files = Array.from(event.dataTransfer?.files || []).filter((file) =>
        file.type
          ? file.type.startsWith("video/")
          : /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)
      );
      if (files.length) onFilesSelected(files);
    },
    [onFilesSelected]
  );

  // Clip reorder via internal drag.
  const onClipDragStart = useCallback((event, clipId) => {
    event.dataTransfer.setData(CLIP_MIME, clipId);
    event.dataTransfer.effectAllowed = "move";
    setDragInfo({ srcId: clipId, overId: null, side: null });
  }, []);
  const onClipDragOver = useCallback((event, clipId) => {
    if (!dragHasClip(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const side = x < rect.width / 2 ? "before" : "after";
    setDragInfo((prev) =>
      prev && (prev.overId !== clipId || prev.side !== side)
        ? { ...prev, overId: clipId, side }
        : prev
    );
  }, []);
  const onClipDrop = useCallback(
    (event, targetId) => {
      if (!dragHasClip(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const srcId = event.dataTransfer.getData(CLIP_MIME);
      const side = dragInfo?.side || "before";
      setDragInfo(null);
      if (srcId && srcId !== targetId) onReorderClip(srcId, targetId, side);
    },
    [dragInfo, onReorderClip]
  );
  const onClipDragEnd = useCallback(() => setDragInfo(null), []);

  // Click on empty track area → seek to that time within whichever clip is under the cursor.
  const onTrackClick = useCallback(
    (event) => {
      if (event.target !== event.currentTarget) return;
      seekFromClientX(event.clientX, { snap: false });
    },
    [seekFromClientX]
  );

  // Auto-scroll playhead into view when playing.
  useEffect(() => {
    if (!isPlaying || playheadX == null) return;
    const scroll = trackRef.current;
    if (!scroll) return;
    const left = scroll.scrollLeft;
    const right = left + scroll.clientWidth;
    if (playheadX < left + 40 || playheadX > right - 80) {
      scroll.scrollTo({ left: Math.max(0, playheadX - 80), behavior: "smooth" });
    }
  }, [isPlaying, playheadX]);

  return (
    <section
      className={`timeline${isFileDrag ? " is-drop-target" : ""}`}
      aria-label="Sequence timeline"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="timeline-toolbar">
        <div className="timeline-title">
          <Film size={15} />
          <span>Sequence</span>
          <strong>{clips.length}</strong>
        </div>
        <div className="timeline-tools">
          <button
            type="button"
            className="btn ghost"
            onClick={onCutLeft}
            disabled={!canCutLeft}
            title="Split at playhead and delete everything before it"
          >
            <ChevronsLeft size={14} />
            <span>Trim left</span>
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={onCutRight}
            disabled={!canCutRight}
            title="Split at playhead and delete everything after it"
          >
            <ChevronsRight size={14} />
            <span>Trim right</span>
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={onSplitActiveClip}
            disabled={!activeClip || activeClip.status !== "ready"}
            title="Split active clip at playhead into two clips (S)"
          >
            <Scissors size={14} />
            <span>Split</span>
          </button>
          <button
            type="button"
            className="btn icon"
            onClick={onZoomOut}
            disabled={pps <= MIN_PIXELS_PER_SECOND}
            title="Zoom out"
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            className="btn icon"
            onClick={onZoomIn}
            disabled={pps >= MAX_PIXELS_PER_SECOND}
            title="Zoom in"
          >
            <ZoomIn size={14} />
          </button>
          <button type="button" className="btn primary" onClick={onChooseVideo} title="Add clip">
            <Plus size={14} />
            <span>Add</span>
          </button>
        </div>
      </div>

      {isEmpty ? (
        <EmptyDropzone onChooseVideo={onChooseVideo} onReferencePath={onReferencePath} />
      ) : (
        <div className="timeline-scroll" ref={trackRef} onWheel={onTimelineWheel}>
          <div
            className="timeline-content"
            style={{ width: Math.max(totalWidth + ADD_BUTTON_GAP + ADD_BUTTON_WIDTH, 100) }}
          >
            <TimelineRuler ticks={rulerTicks} onPointerDown={startRulerDrag} />
            <div className="timeline-track" onClick={onTrackClick}>
              {clips.map((clip, index) => {
                const block = blocks[index];
                return (
                  <ClipBlock
                    key={clip.id}
                    clip={clip}
                    x={block.x}
                    width={block.width}
                    pps={pps}
                    mediaAsset={assetsByProject[clip.projectId]}
                    isActive={clip.id === activeClipId}
                    isDragging={dragInfo?.srcId === clip.id}
                    dropSide={dragInfo?.overId === clip.id ? dragInfo.side : null}
                    onClick={() => onSelectClip(clip.id)}
                    onRemove={() => onRemoveClip(clip.id)}
                    onRetry={() => onRetryClip(clip.id)}
                    onDragStart={(event) => onClipDragStart(event, clip.id)}
                    onDragOver={(event) => onClipDragOver(event, clip.id)}
                    onDrop={(event) => onClipDrop(event, clip.id)}
                    onDragEnd={onClipDragEnd}
                  />
                );
              })}
              <button
                type="button"
                className="tl-add"
                style={{ left: totalWidth + ADD_BUTTON_GAP, width: ADD_BUTTON_WIDTH }}
                onClick={(event) => {
                  event.stopPropagation();
                  onChooseVideo();
                }}
                title="Add clip"
                aria-label="Add clip"
              >
                <Plus size={18} />
              </button>
            </div>
            {playheadX != null ? (
              <div className="timeline-playhead" style={{ left: playheadX }}>
                <div
                  className="timeline-playhead-head"
                  onPointerDown={startPlayheadDrag}
                  title="Drag to scrub"
                />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function TimelineRuler({ ticks, onPointerDown }) {
  return (
    <div
      className="timeline-ruler"
      onPointerDown={onPointerDown}
      title="Drag to scrub the timeline"
    >
      {ticks.map((tick) => (
        <div
          key={`${tick.time}-${tick.major ? "major" : "minor"}`}
          className={`timeline-ruler-tick${tick.major ? " is-major" : " is-minor"}`}
          style={{ left: tick.x }}
        >
          {tick.label ? (
            <span className={`timeline-ruler-label${tick.time === 0 ? " is-start" : ""}`}>
              {tick.label}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ClipBlock({
  clip,
  x,
  width,
  pps,
  mediaAsset,
  isActive,
  isDragging,
  dropSide,
  onClick,
  onRemove,
  onRetry,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}) {
  const status = clip.status || "ready";
  const { start: trimStart, end: trimEnd } = getClipTrimRange(clip);

  const className = [
    "tl-clip",
    `tl-clip-${status}`,
    isActive ? "is-active" : "",
    isDragging ? "is-dragging" : "",
    dropSide === "before" ? "drop-before" : "",
    dropSide === "after" ? "drop-after" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      style={{ left: x, width }}
      draggable={status === "ready"}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onClick}
    >
      <div className="tl-clip-body">
        {status === "ready" ? (
          <ClipMedia clip={clip} mediaAsset={mediaAsset} trimStart={trimStart} trimEnd={trimEnd} />
        ) : null}
        {status === "ready" && trimEnd > trimStart ? (
          <CutOverlays clip={clip} pps={pps} trimStart={trimStart} trimEnd={trimEnd} />
        ) : null}
        {status === "transcribing" ? (
          <div className="tl-clip-progress" aria-hidden="true">
            <span />
          </div>
        ) : null}
        <div className="tl-clip-label">
          <span className="tl-clip-name" title={clip.fileName}>
            {clip.fileName || "Untitled"}
          </span>
        </div>
      </div>

      <div className="tl-clip-actions">
        {status === "error" && clip._pending ? (
          <button
            type="button"
            className="btn icon"
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
            title="Retry"
          >
            <RotateCcw size={13} />
          </button>
        ) : null}
        <button
          type="button"
          className="btn icon"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Remove"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

function ClipMedia({ clip, mediaAsset, trimStart, trimEnd }) {
  const asset = mediaAsset?.data;
  const waveformBars = asset?.waveform?.barsPath || "";
  const visibleDuration = Math.max(0.001, trimEnd - trimStart);
  const sourceDuration = Math.max(
    visibleDuration,
    Number(asset?.duration) || Number(clip.duration) || visibleDuration
  );
  const stripStyle = {
    left: `${-(trimStart / visibleDuration) * 100}%`,
    width: `${(sourceDuration / visibleDuration) * 100}%`,
  };

  if (asset?.thumbnails?.length) {
    return (
      <div className="tl-clip-media" aria-hidden="true">
        <div className="tl-thumb-strip" style={stripStyle}>
          {asset.thumbnails.map((thumbnail, index) => (
            <img
              key={`${thumbnail.time}-${index}`}
              className="tl-thumb"
              src={thumbnail.url}
              alt=""
              draggable="false"
            />
          ))}
        </div>
        {waveformBars ? (
          <svg
            className="tl-waveform"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            style={stripStyle}
          >
            <line className="tl-waveform-mid" x1="0" x2="100" y1="50" y2="50" />
            <path className="tl-waveform-bars" d={waveformBars} />
          </svg>
        ) : null}
      </div>
    );
  }

  return (
    <div className="tl-clip-media tl-clip-media-loading" aria-hidden="true">
      <span />
    </div>
  );
}

function CutOverlays({ clip, pps, trimStart, trimEnd }) {
  const overlays = getClipCutRanges(clip)
    .filter((range) => range.source_end > trimStart && range.source_start < trimEnd)
    .map((range) => {
      const start = Math.max(range.source_start, trimStart);
      const end = Math.min(range.source_end, trimEnd);
      return (
        <div
          key={`${range.source_start}:${range.source_end}`}
          className="tl-clip-cut"
          style={{ left: (start - trimStart) * pps, width: Math.max(1, (end - start) * pps) }}
        />
      );
    });
  return <>{overlays}</>;
}

function EmptyDropzone({ onChooseVideo, onReferencePath }) {
  const [pathOpen, setPathOpen] = useState(false);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submitPath = async (event) => {
    event.preventDefault();
    if (!path.trim() || loading) return;
    setLoading(true);
    setError("");
    try {
      await onReferencePath(path);
      setPath("");
      setPathOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="timeline-empty">
      <button type="button" className="timeline-empty-zone" onClick={onChooseVideo}>
        <Upload size={22} />
        <span className="timeline-empty-title">Click or drop video files</span>
        <span className="timeline-empty-sub">
          Each clip uploads and transcribes in the background.
        </span>
      </button>
      {pathOpen ? (
        <form className="timeline-empty-path" onSubmit={submitPath}>
          <input
            autoFocus
            value={path}
            placeholder="/Volumes/Drive/folder/video.mov"
            onChange={(event) => setPath(event.target.value)}
            disabled={loading}
          />
          <button className="btn primary" type="submit" disabled={!path.trim() || loading}>
            {loading ? <Loader2 className="spin" size={14} /> : <FileSymlink size={14} />}
            <span>Reference</span>
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setPathOpen(false);
              setPath("");
              setError("");
            }}
            disabled={loading}
          >
            Cancel
          </button>
          {error ? <div className="timeline-empty-error">{error}</div> : null}
        </form>
      ) : (
        <button type="button" className="timeline-empty-link" onClick={() => setPathOpen(true)}>
          or reference a local file path
        </button>
      )}
    </div>
  );
}
