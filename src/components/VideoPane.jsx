import { FileVideo, Pause, Play } from "lucide-react";
import { formatClock } from "../editorModel";

export function VideoPane({
  videoUrl,
  videoRef,
  videoFile,
  projectMeta,
  isPlaying,
  hasTranscript,
  items,
  cut,
  durations,
  error,
  onChooseVideo,
  onTogglePlayback,
  onVideoMetadata,
}) {
  return (
    <aside className="video-pane">
      <div className="video-frame">
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            playsInline
            onLoadedMetadata={(event) => onVideoMetadata(event.currentTarget.duration)}
          />
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
          <div className="player-meta">
            {projectMeta?.model ? <code>{projectMeta.model}</code> : null}
            {videoFile?.name ? <span title={videoFile.name}>{videoFile.name}</span> : null}
          </div>
        </div>
      ) : null}

      {hasTranscript ? <TimelineRibbon items={items} cut={cut} durations={durations} /> : null}

      {error ? <pre className="error-box">{error}</pre> : null}
    </aside>
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
