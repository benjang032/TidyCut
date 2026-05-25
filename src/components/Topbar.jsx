import { AudioLines, Copy, Download, Loader2, PanelLeft, Volume2, WandSparkles } from "lucide-react";

export function Topbar({
  fileInputRef,
  projectNameInputRef,
  status,
  projectName,
  projectSaveState,
  projectError,
  hasTranscript,
  isAiEditing,
  canAiEdit,
  canRender,
  isBusy,
  audioProcessing,
  audioProcessingDisabled = false,
  onProjectNameChange,
  onToggleSidebar,
  onFilesSelected,
  onToggleAudioProcessing,
  onOpenCopy,
  onAutoEdit,
  onRenderAndDownload,
}) {
  const denoiseOn = Boolean(audioProcessing?.denoise);
  const normalizeOn = Boolean(audioProcessing?.normalize);

  return (
    <header className="topbar">
      <ProjectControl
        name={projectName}
        disabled={isBusy}
        nameInputRef={projectNameInputRef}
        onNameChange={onProjectNameChange}
        onToggleSidebar={onToggleSidebar}
      />

      <div className="topbar-right">
        <SaveIndicator saveState={projectSaveState} error={projectError} />
        <div className="topbar-actions">
          <div className="topbar-audio-controls" aria-label="Audio processing">
            <button
              type="button"
              className={`btn toggle${denoiseOn ? " is-on" : ""}`}
              aria-pressed={denoiseOn}
              disabled={audioProcessingDisabled}
              title="Applies to new audio previews and exports"
              onClick={() => onToggleAudioProcessing("denoise")}
            >
              <AudioLines size={15} />
              <span>Denoise</span>
            </button>
            <button
              type="button"
              className={`btn toggle${normalizeOn ? " is-on" : ""}`}
              aria-pressed={normalizeOn}
              disabled={audioProcessingDisabled}
              title="Applies to new audio previews and exports"
              onClick={() => onToggleAudioProcessing("normalize")}
            >
              <Volume2 size={15} />
              <span>Normalize</span>
            </button>
          </div>
          <button
            type="button"
            className="btn ghost"
            onClick={onOpenCopy}
            disabled={!hasTranscript}
          >
            <Copy size={15} />
            <span>Copy text</span>
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={onAutoEdit}
            disabled={!canAiEdit}
            title="Ask GPT-5.4 through OpenRouter to infer complete takes and apply a first-pass edit"
          >
            {isAiEditing ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <WandSparkles size={15} />
            )}
            <span>AI edit</span>
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={onRenderAndDownload}
            disabled={!canRender}
          >
            {status === "rendering" ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <Download size={15} />
            )}
            <span>Download</span>
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          if (files.length) onFilesSelected(files);
          event.target.value = "";
        }}
      />
    </header>
  );
}

function ProjectControl({ name, disabled, nameInputRef, onNameChange, onToggleSidebar }) {
  const handleKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };

  return (
    <div className="project-control">
      <button
        type="button"
        className="project-sidebar-toggle"
        onClick={onToggleSidebar}
        title="Projects"
        aria-label="Open projects"
      >
        <PanelLeft size={16} />
      </button>
      <input
        ref={nameInputRef}
        className="project-name-input"
        value={name || ""}
        aria-label="Project name"
        placeholder="Untitled project"
        spellCheck={false}
        disabled={disabled}
        onChange={(event) => onNameChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}

function SaveIndicator({ saveState, error }) {
  const label = (() => {
    if (saveState === "loading") return "Loading";
    if (saveState === "saving") return "Saving";
    if (saveState === "error") return "Save failed";
    if (saveState === "saved") return "Saved";
    return "Draft";
  })();

  return (
    <span
      className={`project-save-state is-${saveState || "idle"}`}
      title={error || label}
    >
      {saveState === "saving" || saveState === "loading" ? (
        <Loader2 className="spin" size={11} />
      ) : null}
      <span>{label}</span>
    </span>
  );
}
