import { Check, ChevronDown, Clock, Copy, Download, Loader2, Play, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatClock } from "../editorModel";

export function Topbar({
  fileInputRef,
  videoFile,
  status,
  statusText,
  statusTone,
  hasTranscript,
  durations,
  isBusy,
  canRender,
  modelOptions,
  selectedModel,
  onFileSelected,
  onChooseVideo,
  onModelChange,
  onTranscribe,
  onOpenCopy,
  onRenderAndDownload,
  onOpenProject,
}) {
  return (
    <header className="topbar">
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
        ) : null}
      </div>

      <div className="actions">
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          hidden
          onChange={(event) => onFileSelected(event.target.files?.[0])}
        />
        <button className="btn ghost" onClick={onChooseVideo}>
          <Upload size={15} />
          <span>{videoFile ? "Change" : "Video"}</span>
        </button>
        <RecentProjects disabled={isBusy} onOpenProject={onOpenProject} />
        <ModelPicker
          options={modelOptions}
          value={selectedModel}
          disabled={isBusy}
          onChange={onModelChange}
        />
        <button className="btn primary" onClick={onTranscribe} disabled={!videoFile || isBusy}>
          {status === "transcribing" ? <Loader2 className="spin" size={15} /> : <Play size={15} />}
          <span>Transcribe</span>
        </button>
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

function RecentProjects({ disabled, onOpenProject }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState(null);
  const [loadingId, setLoadingId] = useState(null);
  const [error, setError] = useState("");
  const wrapRef = useRef(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/projects");
      if (!response.ok) throw new Error(`Failed to load (${response.status})`);
      const payload = await response.json();
      setProjects(Array.isArray(payload?.projects) ? payload.projects : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
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
  }, [open, load]);

  const handlePick = async (project) => {
    if (!project.hasTranscript || loadingId) return;
    setLoadingId(project.projectId);
    try {
      await onOpenProject(project);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="recent-projects" ref={wrapRef}>
      <button
        type="button"
        className="btn ghost"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Clock size={15} />
        <span>Recent</span>
      </button>
      {open ? (
        <div className="recent-projects-menu" role="listbox">
          <div className="recent-projects-head">Recent projects</div>
          {projects === null ? (
            <div className="recent-projects-empty">Loading…</div>
          ) : projects.length === 0 ? (
            <div className="recent-projects-empty">
              No saved projects yet. Transcribe a video to create one.
            </div>
          ) : (
            <div className="recent-projects-list">
              {projects.map((project) => (
                <button
                  key={project.projectId}
                  type="button"
                  role="option"
                  className="recent-project"
                  disabled={!project.hasTranscript || loadingId !== null}
                  onClick={() => handlePick(project)}
                  title={project.hasTranscript ? "Open project" : "Transcription incomplete"}
                >
                  <div className="recent-project-head">
                    <span className="recent-project-name">
                      {project.fileName || project.projectId}
                    </span>
                    {loadingId === project.projectId ? (
                      <Loader2 size={13} className="spin" />
                    ) : null}
                  </div>
                  <div className="recent-project-meta">
                    <span>{formatRelative(project.createdAt)}</span>
                    {project.duration ? <span>· {formatClock(project.duration)}</span> : null}
                    {project.wordCount ? <span>· {project.wordCount} words</span> : null}
                    {project.hasRender ? <span className="recent-project-tag">rendered</span> : null}
                    {!project.hasTranscript ? (
                      <span className="recent-project-tag warn">no transcript</span>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          )}
          {error ? <div className="recent-projects-error">{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function formatRelative(timestamp) {
  if (!timestamp) return "Unknown";
  const diff = Date.now() - timestamp;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function Stat({ label, value, tone }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
