import { AudioLines, KeyRound, Loader2, Volume2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function SettingsModal({
  open,
  state,
  error,
  modelOptions,
  selectedModel,
  audioProcessing,
  openRouterSettings,
  onSave,
  onClose,
}) {
  const [draftModel, setDraftModel] = useState(selectedModel || "");
  const [draftAudioProcessing, setDraftAudioProcessing] = useState(audioProcessing || {});
  const [apiKey, setApiKey] = useState("");
  const selectRef = useRef(null);

  useEffect(() => {
    if (!open) {
      setApiKey("");
      return;
    }
    setDraftModel(selectedModel || modelOptions?.[0]?.value || "");
    setDraftAudioProcessing(audioProcessing || {});
    requestAnimationFrame(() => selectRef.current?.focus());
  }, [audioProcessing, modelOptions, open, selectedModel]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape" && state !== "saving") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, open, state]);

  if (!open) return null;

  const isSaving = state === "saving";
  const hasSavedKey = Boolean(openRouterSettings?.configured);
  const keySource = openRouterSettings?.keySource || "none";
  const aiEditModel = openRouterSettings?.model || "Default";

  const toggleAudio = (key) => {
    setDraftAudioProcessing((current) => ({
      ...current,
      [key]: !Boolean(current?.[key]),
    }));
  };

  const submit = (event) => {
    event.preventDefault();
    if (isSaving) return;
    onSave({
      selectedModel: draftModel,
      audioProcessing: draftAudioProcessing,
      apiKey,
    });
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={isSaving ? undefined : onClose}>
      <form
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-modal-head">
          <div>
            <span className="settings-modal-kicker">Project settings</span>
            <h2 id="settings-title">Defaults and AI edit</h2>
          </div>
          <button
            type="button"
            className="btn icon"
            onClick={onClose}
            disabled={isSaving}
            title="Close"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="settings-modal-body">
          <label className="settings-field">
            <span>Transcription model</span>
            <select
              ref={selectRef}
              value={draftModel}
              disabled={isSaving}
              onChange={(event) => setDraftModel(event.target.value)}
            >
              {modelOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div className="settings-checks" aria-label="Audio processing">
            <button
              type="button"
              className={`settings-check${draftAudioProcessing?.denoise ? " is-on" : ""}`}
              aria-pressed={Boolean(draftAudioProcessing?.denoise)}
              disabled={isSaving}
              onClick={() => toggleAudio("denoise")}
            >
              <AudioLines size={16} />
              <span>Denoise</span>
            </button>
            <button
              type="button"
              className={`settings-check${draftAudioProcessing?.normalize ? " is-on" : ""}`}
              aria-pressed={Boolean(draftAudioProcessing?.normalize)}
              disabled={isSaving}
              onClick={() => toggleAudio("normalize")}
            >
              <Volume2 size={16} />
              <span>Normalize</span>
            </button>
          </div>

          <label className="settings-field">
            <span>OpenRouter API key</span>
            <input
              type="password"
              value={apiKey}
              placeholder={hasSavedKey ? "Key already saved" : "sk-or-v1-..."}
              autoComplete="off"
              spellCheck={false}
              disabled={isSaving}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>

          <div className="settings-summary">
            <span>
              {hasSavedKey ? `OpenRouter key: ${keySource}` : "OpenRouter key: not saved"}
            </span>
            <span>AI edit model: {aiEditModel}</span>
          </div>

          {error ? (
            <div className="settings-modal-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <footer className="settings-modal-footer">
          <span>Defaults are stored locally on this machine.</span>
          <button className="btn primary" type="submit" disabled={isSaving || !draftModel}>
            {isSaving ? <Loader2 className="spin" size={15} /> : <KeyRound size={15} />}
            <span>{isSaving ? "Saving" : "Save settings"}</span>
          </button>
        </footer>
      </form>
    </div>
  );
}
