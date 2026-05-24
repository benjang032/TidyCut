import { FileVideo, Loader2, Pause, Play, Volume2 } from "lucide-react";
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
  onChooseVideo,
  onTogglePlayback,
}) {
  return (
    <aside className="video-pane">
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
    </aside>
  );
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
