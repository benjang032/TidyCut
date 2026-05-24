import {
  Check,
  Clock3,
  FilePlus2,
  Film,
  FolderOpen,
  Loader2,
  RefreshCcw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
  return `${files[0]} +${files.length - 1} more`;
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
  onDeleteProject,
  onRefresh,
}) {
  const [pendingId, setPendingId] = useState(null);
  const [pendingAction, setPendingAction] = useState(null); // "open" | "new" | "delete"
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) {
      setPendingId(null);
      setPendingAction(null);
      setConfirmDeleteId(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      if (confirmDeleteId) {
        event.stopPropagation();
        setConfirmDeleteId(null);
        return;
      }
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmDeleteId, onClose, open]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      dialogRef.current?.focus();
    });
  }, [open]);

  const isBusy = Boolean(pendingId);

  const openProject = useCallback(
    async (projectId) => {
      if (!projectId || isBusy) return;
      if (projectId === currentProjectId) {
        onClose();
        return;
      }
      setPendingId(projectId);
      setPendingAction("open");
      try {
        await onOpenProject(projectId);
      } catch {
        // Parent surfaces error.
      } finally {
        setPendingId(null);
        setPendingAction(null);
      }
    },
    [currentProjectId, isBusy, onClose, onOpenProject]
  );

  const createProject = useCallback(async () => {
    if (isBusy) return;
    setPendingId("__new__");
    setPendingAction("new");
    try {
      await onNewProject();
    } catch {
      // Parent surfaces error.
    } finally {
      setPendingId(null);
      setPendingAction(null);
    }
  }, [isBusy, onNewProject]);

  const requestDelete = useCallback(
    (event, projectId) => {
      event.stopPropagation();
      if (isBusy) return;
      setConfirmDeleteId(projectId);
    },
    [isBusy]
  );

  const cancelDelete = useCallback((event) => {
    event.stopPropagation();
    setConfirmDeleteId(null);
  }, []);

  const confirmDelete = useCallback(
    async (event, projectId) => {
      event.stopPropagation();
      if (!projectId || isBusy) return;
      setPendingId(projectId);
      setPendingAction("delete");
      try {
        await onDeleteProject(projectId);
        setConfirmDeleteId(null);
      } catch {
        // Parent surfaces error.
      } finally {
        setPendingId(null);
        setPendingAction(null);
      }
    },
    [isBusy, onDeleteProject]
  );

  if (!open) return null;

  const hasProjects = projects.length > 0;

  return (
    <div className="overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="project-browser"
        role="dialog"
        aria-modal="true"
        aria-label="Projects"
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="project-browser-head">
          <div>
            <span className="project-browser-kicker">Projects</span>
            <h2>Your edit projects</h2>
            <p className="project-browser-sub">
              Pick up where you left off, or start fresh. Edits autosave.
            </p>
          </div>
          <div className="project-browser-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={onRefresh}
              disabled={loading || isBusy}
              title="Refresh project list"
            >
              {loading ? <Loader2 className="spin" size={14} /> : <RefreshCcw size={14} />}
              <span>Refresh</span>
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={createProject}
              disabled={isBusy}
            >
              {pendingAction === "new" ? (
                <Loader2 className="spin" size={14} />
              ) : (
                <FilePlus2 size={14} />
              )}
              <span>New project</span>
            </button>
            <button
              type="button"
              className="btn icon"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {error ? (
          <div className="project-browser-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="project-list">
          {loading && !hasProjects ? (
            <div className="project-list-empty">
              <Loader2 className="spin" size={18} />
              <span>Loading projects…</span>
            </div>
          ) : null}

          {!loading && !hasProjects ? (
            <div className="project-list-empty is-cta">
              <FolderOpen size={26} />
              <span className="project-list-empty-title">No saved projects yet</span>
              <span className="project-list-empty-sub">
                Start a new one — it'll appear here as soon as you add a clip.
              </span>
              <button
                type="button"
                className="btn primary"
                onClick={createProject}
                disabled={isBusy}
              >
                {pendingAction === "new" ? (
                  <Loader2 className="spin" size={14} />
                ) : (
                  <FilePlus2 size={14} />
                )}
                <span>Create your first project</span>
              </button>
            </div>
          ) : null}

          {projects.map((project) => {
            const isCurrent = project.id === currentProjectId;
            const isOpening = pendingAction === "open" && pendingId === project.id;
            const isDeleting = pendingAction === "delete" && pendingId === project.id;
            const isConfirmingDelete = confirmDeleteId === project.id;
            const rowDisabled = isBusy && pendingId !== project.id;

            const onRowKeyDown = (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                openProject(project.id);
              } else if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                event.stopPropagation();
                event.nativeEvent?.stopImmediatePropagation?.();
                if (!isBusy) setConfirmDeleteId(project.id);
              }
            };

            return (
              <div
                key={project.id}
                className={`project-row${isCurrent ? " is-current" : ""}${
                  isConfirmingDelete ? " is-confirming-delete" : ""
                }`}
                role="button"
                tabIndex={rowDisabled ? -1 : 0}
                aria-disabled={rowDisabled}
                aria-current={isCurrent ? "true" : undefined}
                onClick={() => {
                  if (isConfirmingDelete || rowDisabled) return;
                  openProject(project.id);
                }}
                onKeyDown={onRowKeyDown}
              >
                <span className="project-row-icon" aria-hidden="true">
                  {isOpening || isDeleting ? (
                    <Loader2 className="spin" size={16} />
                  ) : isCurrent ? (
                    <Check size={16} />
                  ) : (
                    <Film size={16} />
                  )}
                </span>
                <span className="project-row-main">
                  <span className="project-row-name-line">
                    <span className="project-row-name">
                      {project.name || "Untitled project"}
                    </span>
                    {isCurrent ? <span className="project-row-tag">Current</span> : null}
                  </span>
                  <span className="project-row-files">{formatFileList(project)}</span>
                </span>
                <span className="project-row-meta">
                  <span>
                    {project.clipCount || 0} clip{project.clipCount === 1 ? "" : "s"}
                  </span>
                  {project.duration > 0 ? <span>{formatClock(project.duration)}</span> : null}
                  <span>
                    <Clock3 size={12} />
                    {formatSavedAt(project.updatedAt || project.createdAt)}
                  </span>
                </span>

                {isConfirmingDelete ? (
                  <div
                    className="project-row-confirm"
                    role="alertdialog"
                    aria-label={`Delete ${project.name || "Untitled project"}?`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <span className="project-row-confirm-text">
                      Delete <strong>{project.name || "Untitled project"}</strong>?
                      <span className="project-row-confirm-sub">
                        Source video files are not removed.
                      </span>
                    </span>
                    <div className="project-row-confirm-actions">
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={cancelDelete}
                        disabled={isDeleting}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn cut"
                        onClick={(event) => confirmDelete(event, project.id)}
                        disabled={isDeleting}
                        autoFocus
                      >
                        {isDeleting ? (
                          <Loader2 className="spin" size={13} />
                        ) : (
                          <Trash2 size={13} />
                        )}
                        <span>Delete</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="project-row-delete"
                    onClick={(event) => requestDelete(event, project.id)}
                    disabled={isBusy}
                    title="Delete project"
                    aria-label={`Delete ${project.name || "Untitled project"}`}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
