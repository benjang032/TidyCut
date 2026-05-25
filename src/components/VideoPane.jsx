import {
  FileSymlink,
  FileVideo,
  Film,
  Loader2,
  Pause,
  Play,
  Plus,
  Upload,
  Volume2,
} from "lucide-react";
import { useState } from "react";
import { MEDIA_SOURCE_MIME } from "../dragTypes";
import { formatClock } from "../editorModel";

export function VideoPane({
  videoUrl,
  videoRef,
  nextVideoUrl,
  audioRef,
  audioPreview,
  usePreviewAudio,
  clipName,
  projectMeta,
  isPlaying,
  hasTranscript,
  sourceDuration,
  items,
  cut,
  durations,
  error,
  mediaSources = [],
  onChooseVideo,
  onReferencePath,
  onAddClipCopy,
  onTogglePlayback,
}) {
  const [paneMode, setPaneMode] = useState("preview");

  return (
    <aside className="video-pane">
      <div className="video-pane-switch" role="tablist" aria-label="Video panel">
        <button
          type="button"
          role="tab"
          aria-selected={paneMode === "preview"}
          className={paneMode === "preview" ? "is-active" : ""}
          onClick={() => setPaneMode("preview")}
        >
          <FileVideo size={14} />
          <span>Output</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={paneMode === "clips"}
          className={paneMode === "clips" ? "is-active" : ""}
          onClick={() => setPaneMode("clips")}
        >
          <Film size={14} />
          <span>Clips</span>
          <strong>{mediaSources.length}</strong>
        </button>
      </div>

      {paneMode === "clips" ? (
        <MediaLibrary
          mediaSources={mediaSources}
          onChooseVideo={onChooseVideo}
          onReferencePath={onReferencePath}
          onAddClipCopy={onAddClipCopy}
        />
      ) : (
        <>
          <div className="video-frame">
            {videoUrl ? (
              <>
                <video
                  ref={videoRef}
                  src={videoUrl}
                  muted={usePreviewAudio}
                  playsInline
                />
                {nextVideoUrl ? (
                  <video
                    className="preload-video"
                    src={nextVideoUrl}
                    muted
                    preload="auto"
                    playsInline
                    aria-hidden="true"
                  />
                ) : null}
              </>
            ) : (
              <button className="empty-video" onClick={onChooseVideo}>
                <FileVideo size={36} />
                <span>Choose a video</span>
              </button>
            )}
          </div>

          {videoUrl ? (
            <div className="player-controls">
              <button className="btn play" onClick={onTogglePlayback}>
                {isPlaying ? <Pause size={15} /> : <Play size={15} />}
                <span>{isPlaying ? "Pause" : "Play"}</span>
              </button>
              <audio
                ref={audioRef}
                className="preview-audio"
                src={audioPreview?.url || undefined}
                preload="auto"
              />
              <div className="player-meta">
                {projectMeta?.model ? <code>{projectMeta.model}</code> : null}
                {clipName ? <span title={clipName}>{clipName}</span> : null}
                {!hasTranscript && sourceDuration > 0 ? (
                  <span>{formatClock(sourceDuration)}</span>
                ) : null}
                <AudioPreviewPill audioPreview={audioPreview} usePreviewAudio={usePreviewAudio} />
              </div>
            </div>
          ) : null}

          <AudioPreviewProgress audioPreview={audioPreview} />

          {hasTranscript ? <TimelineRibbon items={items} cut={cut} durations={durations} /> : null}

          {error ? <pre className="error-box">{error}</pre> : null}
        </>
      )}
    </aside>
  );
}

function MediaLibrary({ mediaSources, onChooseVideo, onReferencePath, onAddClipCopy }) {
  const [pathOpen, setPathOpen] = useState(false);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submitPath = async (event) => {
    event.preventDefault();
    if (!path.trim() || loading || !onReferencePath) return;
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
    <div className="media-library">
      <div className="media-library-actions">
        <button type="button" className="btn primary" onClick={onChooseVideo}>
          <Upload size={14} />
          <span>Upload</span>
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            setPathOpen((open) => !open);
            setError("");
          }}
        >
          <FileSymlink size={14} />
          <span>Reference</span>
        </button>
      </div>

      {pathOpen ? (
        <form className="media-library-path" onSubmit={submitPath}>
          <input
            autoFocus
            value={path}
            placeholder="/Volumes/Drive/folder/video.mov"
            disabled={loading}
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="submit" className="btn primary" disabled={!path.trim() || loading}>
            {loading ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
            <span>Add</span>
          </button>
          {error ? <div className="media-library-error">{error}</div> : null}
        </form>
      ) : null}

      {mediaSources.length ? (
        <div className="media-source-list">
          {mediaSources.map((source) => (
            <MediaSourceCard
              key={source.id}
              source={source}
              onAddClipCopy={onAddClipCopy}
            />
          ))}
        </div>
      ) : (
        <div className="media-library-empty">
          <Film size={24} />
          <span>No clips yet</span>
        </div>
      )}
    </div>
  );
}

function MediaSourceCard({ source, onAddClipCopy }) {
  const ready = source.status === "ready";
  const duration = Number(source.duration) || 0;

  const onDragStart = (event) => {
    if (!ready) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(MEDIA_SOURCE_MIME, source.id);
    event.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div
      className={`media-source-card is-${source.status || "ready"}`}
      draggable={ready}
      onDragStart={onDragStart}
    >
      <div className="media-source-thumb">
        {source.videoUrl ? (
          <video src={source.videoUrl} muted preload="metadata" playsInline />
        ) : (
          <FileVideo size={20} />
        )}
      </div>
      <div className="media-source-main">
        <span className="media-source-name" title={source.fileName}>
          {source.fileName || "Untitled clip"}
        </span>
        <span className="media-source-meta">
          {ready && duration > 0 ? formatClock(duration) : statusLabel(source.status)}
        </span>
      </div>
      <button
        type="button"
        className="btn icon"
        disabled={!ready}
        onClick={() => onAddClipCopy?.(source.id)}
        title="Add copy to timeline"
        aria-label={`Add copy of ${source.fileName || "clip"} to timeline`}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

function statusLabel(status) {
  if (status === "transcribing") return "Transcribing";
  if (status === "queued") return "Queued";
  if (status === "probing") return "Reading";
  if (status === "error") return "Error";
  return "Ready";
}

function AudioPreviewPill({ audioPreview, usePreviewAudio }) {
  if (!audioPreview || audioPreview.status === "idle") return null;
  if (audioPreview.status === "processing") {
    return (
      <span className="audio-preview-pill is-processing">
        <Loader2 className="spin" size={12} />
        Previewing
      </span>
    );
  }
  if (audioPreview.status === "ready" && usePreviewAudio) {
    return (
      <span className="audio-preview-pill is-ready">
        <Volume2 size={12} />
        Processed audio
      </span>
    );
  }
  if (audioPreview.status === "error") {
    const label =
      audioPreview.message && audioPreview.message !== "Audio preview failed"
        ? audioPreview.message
        : "Preview failed";
    return (
      <span className="audio-preview-pill is-error" title={audioPreview.error || label}>
        {label}
      </span>
    );
  }
  if (audioPreview.status === "waiting") {
    return <span className="audio-preview-pill">Audio preview waiting</span>;
  }
  return null;
}

function AudioPreviewProgress({ audioPreview }) {
  if (!audioPreview) return null;
  if (audioPreview.status !== "processing" && audioPreview.status !== "error") return null;
  const progress = Math.max(0.04, Math.min(1, Number(audioPreview.progress) || 0));
  return (
    <div className={`audio-preview-progress is-${audioPreview.status}`}>
      <div className="audio-preview-progress-bar">
        <span style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <span>{audioPreview.error || audioPreview.message || "Preparing audio preview"}</span>
    </div>
  );
}

function TimelineRibbon({ items, cut, durations }) {
  if (!items.length || durations.total <= 0) return null;
  const start = items[0].start;
  const span = items[items.length - 1].end - start;
  if (span <= 0) return null;

  return (
    <div className="ribbon">
      <div className="ribbon-track">
        {items.map((it) => {
          const left = ((it.start - start) / span) * 100;
          const width = ((it.end - it.start) / span) * 100;
          const cls = ["ribbon-cell", `ribbon-${it.kind}`];
          if (cut.has(it.id)) cls.push("is-cut");
          return (
            <span
              key={it.id}
              className={cls.join(" ")}
              style={{ left: `${left}%`, width: `${Math.max(width, 0.15)}%` }}
            />
          );
        })}
      </div>
      <div className="ribbon-meta">
        <span>{formatClock(durations.kept)} kept</span>
        <span className="ribbon-dim">of {formatClock(durations.total)}</span>
      </div>
    </div>
  );
}
