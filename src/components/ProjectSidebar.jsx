import { Loader2, Plus, Settings, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatClock } from "../editorModel";

function formatSavedAt(value) {
  const date = new Date(Number(value) || 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function ProjectSidebar({
  open,
  projects,
  currentProjectId,
  loading,
  error,
  onClose,
  onOpenProject,
  onNewProject,
  onDeleteProject,
  onOpenSettings,
}) {
  const [pendingId, setPendingId] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const panelRef = useRef(null);

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
      panelRef.current?.focus();
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
  const runAndClose = (handler) => {
    if (typeof handler !== "function") return;
    handler();
    onClose();
  };

  return (
    <div className="sidebar-overlay" role="presentation" onMouseDown={onClose}>
      <aside
        className="project-sidebar"
        role="dialog"
        aria-modal="true"
        aria-label="Projects"
        tabIndex={-1}
        ref={panelRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="project-sidebar-head">
          <h2>Projects</h2>
          <div className="project-sidebar-head-actions">
            <button
              type="button"
              className="project-sidebar-iconbtn"
              onClick={() => runAndClose(onOpenSettings)}
              title="Settings"
              aria-label="Settings"
            >
              <Settings size={14} />
            </button>
            <button
              type="button"
              className="project-sidebar-iconbtn"
              onClick={createProject}
              disabled={isBusy}
              title="New project"
              aria-label="New project"
            >
              {pendingAction === "new" ? (
                <Loader2 className="spin" size={14} />
              ) : (
                <Plus size={14} />
              )}
            </button>
            <button
              type="button"
              className="project-sidebar-iconbtn"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        {error ? (
          <div className="project-sidebar-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="project-sidebar-list">
          {loading && !hasProjects ? (
            <div className="project-sidebar-empty">
              <Loader2 className="spin" size={14} />
              <span>Loading…</span>
            </div>
          ) : null}

          {!loading && !hasProjects ? (
            <div className="project-sidebar-empty">
              <span className="project-sidebar-empty-title">No projects yet</span>
              <span className="project-sidebar-empty-sub">
                Add a clip and your project appears here.
              </span>
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

            const metaParts = [
              `${project.clipCount || 0} clip${project.clipCount === 1 ? "" : "s"}`,
              project.duration > 0 ? formatClock(project.duration) : null,
              formatSavedAt(project.updatedAt || project.createdAt),
            ].filter(Boolean);

            return (
              <div
                key={project.id}
                className={`sidebar-row${isCurrent ? " is-current" : ""}${
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
                <span className="sidebar-row-marker" aria-hidden="true" />
                <div className="sidebar-row-main">
                  <span className="sidebar-row-name">
                    <span className="sidebar-row-name-text">
                      {project.name || "Untitled project"}
                    </span>
                    {isOpening || isDeleting ? (
                      <Loader2 className="spin" size={11} />
                    ) : null}
                  </span>
                  <span className="sidebar-row-meta">{metaParts.join(" · ")}</span>
                </div>

                {isConfirmingDelete ? (
                  <div
                    className="sidebar-row-confirm"
                    role="alertdialog"
                    aria-label={`Delete ${project.name || "Untitled project"}?`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <span className="sidebar-row-confirm-text">Delete this project?</span>
                    <div className="sidebar-row-confirm-actions">
                      <button
                        type="button"
                        className="sidebar-row-confirm-btn"
                        onClick={cancelDelete}
                        disabled={isDeleting}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="sidebar-row-confirm-btn is-danger"
                        onClick={(event) => confirmDelete(event, project.id)}
                        disabled={isDeleting}
                        autoFocus
                      >
                        {isDeleting ? (
                          <Loader2 className="spin" size={12} />
                        ) : (
                          "Delete"
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="sidebar-row-delete"
                    onClick={(event) => requestDelete(event, project.id)}
                    disabled={isBusy}
                    title="Delete project"
                    aria-label={`Delete ${project.name || "Untitled project"}`}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
