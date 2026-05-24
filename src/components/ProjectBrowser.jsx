import {
  Check,
  Clock3,
  FilePlus2,
  Film,
  FolderOpen,
  Loader2,
  RefreshCcw,
  X,
} from "lucide-react";
import { useState } from "react";
import { formatClock } from "../editorModel";

function formatSavedAt(value) {
  const date = new Date(Number(value) || 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return "Never saved";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatFileList(project) {
  const files = Array.isArray(project.fileNames) ? project.fileNames.filter(Boolean) : [];
  if (!files.length) return "No clips yet";
  if (files.length === 1) return files[0];
  return `${files[0]} +${files.length - 1}`;
}

export function ProjectBrowser({
  open,
  projects,
  currentProjectId,
  loading,
  error,
  onClose,
  onOpenProject,
  onNewProject,
  onRefresh,
}) {
  const [openingId, setOpeningId] = useState(null);
  if (!open) return null;

  const openProject = async (projectId) => {
    if (!projectId || openingId) return;
    setOpeningId(projectId);
    try {
      await onOpenProject(projectId);
    } catch {
      // The parent surfaces the actionable error in the dialog.
    } finally {
      setOpeningId(null);
    }
  };

  const createProject = async () => {
    if (openingId) return;
    setOpeningId("new");
    try {
      await onNewProject();
    } catch {
      // The parent surfaces the actionable error in the dialog.
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="project-browser"
        role="dialog"
        aria-modal="true"
        aria-label="Open project"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="project-browser-head">
          <div>
            <span className="project-browser-kicker">Projects</span>
            <h2>Open previous work</h2>
          </div>
          <div className="project-browser-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={onRefresh}
              disabled={loading || Boolean(openingId)}
              title="Refresh projects"
            >
              {loading ? <Loader2 className="spin" size={14} /> : <RefreshCcw size={14} />}
              <span>Refresh</span>
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={createProject}
              disabled={Boolean(openingId)}
            >
              {openingId === "new" ? <Loader2 className="spin" size={14} /> : <FilePlus2 size={14} />}
              <span>New</span>
            </button>
            <button type="button" className="btn icon" onClick={onClose} title="Close">
              <X size={16} />
            </button>
          </div>
        </header>

        {error ? <div className="project-browser-error">{error}</div> : null}

        <div className="project-list">
          {loading && !projects.length ? (
            <div className="project-list-empty">
              <Loader2 className="spin" size={18} />
              <span>Loading projects</span>
            </div>
          ) : null}

          {!loading && !projects.length ? (
            <div className="project-list-empty">
              <FolderOpen size={22} />
              <span>No saved edit projects yet</span>
            </div>
          ) : null}

          {projects.map((project) => {
            const isCurrent = project.id === currentProjectId;
            const isOpening = openingId === project.id;
            return (
              <button
                type="button"
                key={project.id}
                className={`project-row${isCurrent ? " is-current" : ""}`}
                onClick={() => openProject(project.id)}
                disabled={Boolean(openingId)}
              >
                <span className="project-row-icon">
                  {isOpening ? (
                    <Loader2 className="spin" size={16} />
                  ) : isCurrent ? (
                    <Check size={16} />
                  ) : (
                    <Film size={16} />
                  )}
                </span>
                <span className="project-row-main">
                  <span className="project-row-name">{project.name || "Untitled project"}</span>
                  <span className="project-row-files">{formatFileList(project)}</span>
                </span>
                <span className="project-row-meta">
                  <span>{project.clipCount || 0} clips</span>
                  {project.duration > 0 ? <span>{formatClock(project.duration)}</span> : null}
                  <span>
                    <Clock3 size={12} />
                    {formatSavedAt(project.updatedAt || project.createdAt)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
