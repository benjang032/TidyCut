import {
  AudioLines,
  Check,
  ChevronDown,
  Copy,
  Download,
  FilePlus2,
  FolderOpen,
  Loader2,
  Plus,
  Volume2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatClock } from "../editorModel";

export function Topbar({
  fileInputRef,
  projectNameInputRef,
  status,
  statusText,
  statusTone,
  projectName,
  projectSaveState,
  projectError,
  hasTranscript,
  durations,
  sourceDuration,
  isBusy,
  canRender,
  modelOptions,
  selectedModel,
  audioProcessing,
  onProjectNameChange,
  onNewProject,
  onOpenProjectBrowser,
  onFilesSelected,
  onChooseVideo,
  onModelChange,
  onAudioProcessingChange,
  onOpenCopy,
  onRenderAndDownload,
}) {
  return (
    <header className="topbar">
      <ProjectControl
        name={projectName}
        saveState={projectSaveState}
        error={projectError}
        disabled={isBusy}
        nameInputRef={projectNameInputRef}
        onNameChange={onProjectNameChange}
        onNewProject={onNewProject}
        onOpenProjectBrowser={onOpenProjectBrowser}
      />

      <div className="topbar-status">
        <span className={`status-dot tone-${statusTone}`} />
        <span className="status-text">{statusText}</span>
      </div>

      <div className="topbar-stats">
        {hasTranscript ? (
          <>
            <Stat label="Original" value={formatClock(durations.total)} />
            <Stat label="Cut" value={formatClock(durations.cut)} tone="cut" />
            <Stat label="Final" value={formatClock(durations.kept)} tone="keep" />
          </>
        ) : sourceDuration > 0 ? (
          <Stat label="Video" value={formatClock(sourceDuration)} />
        ) : null}
      </div>

      <div className="actions">
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
        <button className="btn primary" onClick={onChooseVideo}>
          <Plus size={15} />
          <span>Add clip</span>
        </button>
        <ModelPicker
          options={modelOptions}
          value={selectedModel}
          disabled={isBusy}
          onChange={onModelChange}
        />
        <AudioProcessingToggles
          options={audioProcessing}
          disabled={isBusy}
          onChange={onAudioProcessingChange}
        />
        <button className="btn ghost" onClick={onOpenCopy} disabled={!hasTranscript}>
          <Copy size={15} />
          <span>Copy text</span>
        </button>
        <button className="btn primary" onClick={onRenderAndDownload} disabled={!canRender}>
          {status === "rendering" ? (
            <Loader2 className="spin" size={15} />
          ) : (
            <Download size={15} />
          )}
          <span>Download</span>
        </button>
      </div>
    </header>
  );
}

function ProjectControl({
  name,
  saveState,
  error,
  disabled,
  nameInputRef,
  onNameChange,
  onNewProject,
  onOpenProjectBrowser,
}) {
  const label = (() => {
    if (saveState === "loading") return "Loading";
    if (saveState === "saving") return "Saving";
    if (saveState === "error") return "Save failed";
    if (saveState === "saved") return "Saved";
    return "Draft";
  })();

  const handleKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };

  return (
    <div className="project-control">
      <div className="project-name-wrap">
        <span className="project-name-kicker">Project</span>
        <input
          ref={nameInputRef}
          className="project-name-input"
          value={name || ""}
          aria-label="Project name"
          placeholder="Untitled project"
          spellCheck={false}
          disabled={disabled || saveState === "loading"}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <span
          className={`project-save-state is-${saveState || "idle"}`}
          title={error || label}
        >
          {saveState === "saving" || saveState === "loading" ? (
            <Loader2 className="spin" size={11} />
          ) : null}
          <span>{label}</span>
        </span>
      </div>
      <div className="project-buttons">
        <button
          type="button"
          className="btn ghost"
          onClick={onNewProject}
          disabled={disabled || saveState === "loading"}
          title="Start a fresh project (current edits autosave)"
        >
          <FilePlus2 size={14} />
          <span>New</span>
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={onOpenProjectBrowser}
          disabled={disabled || saveState === "loading"}
          title="Browse saved projects"
        >
          <FolderOpen size={14} />
          <span>Projects</span>
        </button>
      </div>
    </div>
  );
}

function AudioProcessingToggles({ options, disabled, onChange }) {
  const denoise = Boolean(options?.denoise);
  const normalize = Boolean(options?.normalize);

  const toggle = (key) => {
    onChange({
      ...options,
      [key]: !Boolean(options?.[key]),
    });
  };

  return (
    <div className="audio-toggles" aria-label="Audio processing">
      <button
        type="button"
        className={`btn toggle${denoise ? " is-on" : ""}`}
        aria-pressed={denoise}
        disabled={disabled}
        title="Remove background noise with DeepFilterNet3. First use prepares the local runtime and model."
        onClick={() => toggle("denoise")}
      >
        <AudioLines size={15} />
        <span>Denoise</span>
      </button>
      <button
        type="button"
        className={`btn toggle${normalize ? " is-on" : ""}`}
        aria-pressed={normalize}
        disabled={disabled}
        title="Normalize preview and export audio to -16 LUFS and -1.5 dBTP"
        onClick={() => toggle("normalize")}
      >
        <Volume2 size={15} />
        <span>Normalize</span>
      </button>
    </div>
  );
}

function ModelPicker({ options, value, disabled, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const selected = options.find((o) => o.value === value) || options[0];

  useEffect(() => {
    if (!open) return;
    function onDocDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="model-picker" ref={wrapRef}>
      <span className="model-picker-label">Model</span>
      <button
        type="button"
        className="model-picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="model-picker-trigger-text">{selected?.label}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="model-picker-menu" role="listbox">
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`model-picker-option${isSelected ? " is-selected" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <div className="model-picker-option-head">
                  <span className="model-picker-option-name">{option.label}</span>
                  <span className="model-picker-option-size">{option.size}</span>
                  {isSelected ? <Check size={13} className="model-picker-option-check" /> : null}
                </div>
                <div className="model-picker-option-meta">
                  <span className="hint-pro"><em>+</em> {option.pro}</span>
                  <span className="hint-con"><em>−</em> {option.con}</span>
                </div>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
