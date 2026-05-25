import { Download, FolderOpen, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function ExportModal({
  open,
  state,
  error,
  defaultFileName,
  canChooseDestination,
  onExport,
  onClose,
}) {
  const [draftFileName, setDraftFileName] = useState(defaultFileName || "");
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setDraftFileName(defaultFileName || "");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [defaultFileName, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape" && state !== "rendering") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, open, state]);

  if (!open) return null;

  const isRendering = state === "rendering";
  const canSubmit = Boolean(draftFileName.trim()) && !isRendering;

  const submit = (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    onExport(draftFileName);
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={isRendering ? undefined : onClose}>
      <form
        className="export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="export-modal-head">
          <div>
            <span className="settings-modal-kicker">Export video</span>
            <h2 id="export-title">Save rendered MP4</h2>
          </div>
          <button
            type="button"
            className="btn icon"
            onClick={onClose}
            disabled={isRendering}
            title="Close"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="export-modal-body">
          <label className="settings-field">
            <span>File name</span>
            <input
              ref={inputRef}
              type="text"
              value={draftFileName}
              autoComplete="off"
              spellCheck={false}
              disabled={isRendering}
              onChange={(event) => setDraftFileName(event.target.value)}
            />
          </label>

          {!canChooseDestination ? (
            <div className="export-fallback-note">
              This browser will use its default download location.
            </div>
          ) : null}

          {error ? (
            <div className="settings-modal-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <footer className="export-modal-footer">
          <span>{canChooseDestination ? "Destination selected by your browser." : "MP4 export"}</span>
          <button className="btn primary" type="submit" disabled={!canSubmit}>
            {isRendering ? (
              <Loader2 className="spin" size={15} />
            ) : canChooseDestination ? (
              <FolderOpen size={15} />
            ) : (
              <Download size={15} />
            )}
            <span>
              {isRendering
                ? "Rendering"
                : canChooseDestination
                  ? "Choose destination"
                  : "Download"}
            </span>
          </button>
        </footer>
      </form>
    </div>
  );
}
