import { FileVideo, Loader2, Scissors, Undo2, X } from "lucide-react";
import { formatPauseLabel } from "../editorModel";

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
  onClear,
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
              <span className="legend-dot cut" /> cut
            </p>
            <p className="hint">
              Click to seek &middot; drag or shift-click to select &middot; <kbd>Del</kbd> to cut
            </p>
          </div>

          <div
            ref={transcriptRef}
            className="transcript-doc"
            onPointerLeave={onTranscriptPointerLeave}
          >
            {items.map((item) => (
              <Token
                key={item.id}
                item={item}
                isSelected={selection.has(item.id)}
                isCut={cut.has(item.id)}
                isActive={activeId === item.id}
                activeRef={activeId === item.id ? activeChipRef : null}
                onPointerDown={onTokenPointerDown}
                onPointerEnter={onTokenPointerEnter}
              />
            ))}
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
        <SelectionBar stats={selectionStats} onCut={onCut} onRestore={onRestore} onClear={onClear} />
      ) : null}
    </section>
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

function SelectionBar({ stats, onCut, onRestore, onClear }) {
  return (
    <div className="selection-bar">
      <div className="selection-summary">
        <span className="selection-count">{stats.size}</span>
        <span className="selection-label">{selectionLabel(stats)}</span>
      </div>
      <div className="selection-actions">
        {stats.activeCount > 0 ? (
          <button className="btn cut" onClick={onCut}>
            <Scissors size={14} />
            <span>Cut {stats.activeCount}</span>
          </button>
        ) : null}
        {stats.cutCount > 0 ? (
          <button className="btn ghost" onClick={onRestore}>
            <Undo2 size={14} />
            <span>Restore {stats.cutCount}</span>
          </button>
        ) : null}
        <button className="btn icon" onClick={onClear} title="Clear (Esc)">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function selectionLabel(stats) {
  const parts = [];
  if (stats.words) parts.push(`${stats.words} word${stats.words === 1 ? "" : "s"}`);
  if (stats.gaps) parts.push(`${stats.gaps} pause${stats.gaps === 1 ? "" : "s"}`);
  if (!parts.length) return `${stats.size} selected`;
  return `${parts.join(", ")} selected`;
}
