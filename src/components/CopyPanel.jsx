import { useEffect, useRef } from "react";
import { Check, Copy, X } from "lucide-react";

export function CopyPanel({ text, state, onCopy, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="copy-panel" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <span className="copy-title">Transcript</span>
          <button className="btn icon" onClick={onClose} title="Close (Esc)">
            <X size={14} />
          </button>
        </header>
        <textarea ref={ref} readOnly value={text} spellCheck="false" />
        <footer>
          <span className="copy-meta">
            {text ? `${text.split(/\s+/).filter(Boolean).length} words` : "Empty"}
          </span>
          <button className="btn primary" onClick={onCopy} disabled={!text}>
            <CopyStateIcon state={state} />
          </button>
        </footer>
      </div>
    </div>
  );
}

function CopyStateIcon({ state }) {
  if (state === "copied") {
    return (
      <>
        <Check size={15} />
        <span>Copied</span>
      </>
    );
  }

  if (state === "error") {
    return (
      <>
        <X size={15} />
        <span>Failed</span>
      </>
    );
  }

  return (
    <>
      <Copy size={15} />
      <span>Copy</span>
    </>
  );
}
