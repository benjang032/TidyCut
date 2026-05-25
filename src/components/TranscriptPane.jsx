import { Fragment } from "react";
import {
  FileVideo,
  Loader2,
  MoveLeft,
  MoveRight,
  Scissors,
  Undo2,
} from "lucide-react";
import { formatClock, formatPauseLabel } from "../editorModel";

export function TranscriptPane({
  hasTranscript,
  status,
  statusText,
  transcriptRef,
  items,
  cut,
  selection,
  activeId,
  activeChipRef,
  selectionStats,
  transcriptionProgress,
  onTokenPointerDown,
  onTokenPointerEnter,
  onTranscriptPointerLeave,
  onCut,
  onRestore,
  canExtendLeft,
  canExtendRight,
  onExpandLeft,
  onExpandRight,
}) {
  const hasSelection = selection.size > 0;

  return (
    <section className="transcript-pane">
      {hasTranscript ? (
        <>
          <div className="transcript-toolbar">
            <p className="legend">
              <span className="legend-dot keep" /> kept
              <span className="legend-dot pause" /> pause
            </p>
            <p className="hint">
              Click to seek &middot; drag or shift-click to select &middot; <kbd>Del</kbd> to delete
            </p>
          </div>

          <div
            ref={transcriptRef}
            className="transcript-doc"
            onPointerLeave={onTranscriptPointerLeave}
          >
            {items.map((item, index) => {
              const startsClip = item.clipId && item.clipId !== items[index - 1]?.clipId;
              return (
                <Fragment key={item.id}>
                  {startsClip ? <ClipBreak item={item} /> : null}
                  <Token
                    item={item}
                    isSelected={selection.has(item.id)}
                    isCut={cut.has(item.id)}
                    isActive={activeId === item.id}
                    activeRef={activeId === item.id ? activeChipRef : null}
                    onPointerDown={onTokenPointerDown}
                    onPointerEnter={onTokenPointerEnter}
                  />
                </Fragment>
              );
            })}
          </div>
        </>
      ) : (
        <div className="empty-transcript">
          {status === "transcribing" ? (
            <TranscriptionProgress progress={transcriptionProgress} statusText={statusText} />
          ) : (
            <>
              <FileVideo size={28} />
              <span>Transcribe a video to start cutting words.</span>
            </>
          )}
        </div>
      )}

      {hasSelection ? (
        <SelectionBar
          stats={selectionStats}
          onCut={onCut}
          onRestore={onRestore}
          canExtendLeft={canExtendLeft}
          canExtendRight={canExtendRight}
          onExpandLeft={onExpandLeft}
          onExpandRight={onExpandRight}
        />
      ) : null}
    </section>
  );
}

function ClipBreak({ item }) {
  return (
    <span className="transcript-clip-break">
      <span className="transcript-clip-name" title={item.clipName}>
        {item.clipName || `Clip ${item.clipIndex + 1}`}
      </span>
      <span className="transcript-clip-time">{formatClock(item.sequenceStart || 0)}</span>
    </span>
  );
}

function TranscriptionProgress({ progress, statusText }) {
  return (
    <div className="transcription-progress">
      <Loader2 className="spin" size={28} />
      <div
        className="progress-meter"
        role="progressbar"
        aria-label="Transcription progress"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={progress}
      >
        <span className="progress-fill" style={{ width: `${progress}%` }} />
      </div>
      <div className="progress-copy">
        <span>{statusText}</span>
        <strong>{progress}%</strong>
      </div>
    </div>
  );
}

function Token({ item, isSelected, isCut, isActive, activeRef, onPointerDown, onPointerEnter }) {
  const classes = ["tok", `tok-${item.kind}`];
  if (isSelected) classes.push("is-selected");
  if (isCut) classes.push("is-cut");
  if (isActive) classes.push("is-active");

  if (item.kind === "gap") {
    return (
      <span
        ref={activeRef}
        className={classes.join(" ")}
        onPointerDown={(e) => onPointerDown(e, item)}
        onPointerEnter={() => onPointerEnter(item)}
        title={`Pause ${formatPauseLabel(item.end - item.start)}`}
      >
        <span className="gap-bar" />
        <span className="gap-label">{formatPauseLabel(item.end - item.start)}</span>
      </span>
    );
  }

  return (
    <span
      ref={activeRef}
      className={classes.join(" ")}
      onPointerDown={(e) => onPointerDown(e, item)}
      onPointerEnter={() => onPointerEnter(item)}
    >
      {item.text}
    </span>
  );
}

function SelectionBar({
  stats,
  onCut,
  onRestore,
  canExtendLeft,
  canExtendRight,
  onExpandLeft,
  onExpandRight,
}) {
  return (
    <div className="selection-bar">
      <div className="selection-summary">
        <span className="selection-label">{selectionLabel(stats)}</span>
      </div>
      <div className="selection-actions">
        <button
          className="selection-tool"
          onClick={onExpandLeft}
          disabled={!canExtendLeft}
          title="Extend clip 0.1s earlier"
          aria-label="Extend clip 0.1s earlier"
        >
          <MoveLeft size={15} />
        </button>
        <button
          className="selection-tool"
          onClick={onExpandRight}
          disabled={!canExtendRight}
          title="Extend clip 0.1s later"
          aria-label="Extend clip 0.1s later"
        >
          <MoveRight size={15} />
        </button>
        {stats.activeCount > 0 ? (
          <button
            className="selection-tool selection-tool-cut"
            onClick={onCut}
            title="Delete selection"
            aria-label="Delete selection"
          >
            <Scissors size={15} />
          </button>
        ) : null}
        {stats.cutCount > 0 ? (
          <button
            className="selection-tool"
            onClick={onRestore}
            title="Restore selection"
            aria-label="Restore selection"
          >
            <Undo2 size={15} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function selectionLabel(stats) {
  const parts = [];
  if (stats.words) parts.push(`${stats.words} word${stats.words === 1 ? "" : "s"}`);
  if (stats.gaps) parts.push(`${stats.gaps} pause${stats.gaps === 1 ? "" : "s"}`);
  if (!parts.length) return `${stats.size} selected`;
  return `${parts.join(" ")} selected`;
}
