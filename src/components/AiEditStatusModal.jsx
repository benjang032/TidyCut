import { AlertTriangle, CheckCircle2, Clock3, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const STEPS = [
  { id: "preparing", label: "Building silence-cleaned candidates" },
  { id: "waiting", label: "Waiting on OpenRouter" },
  { id: "parsing", label: "Reading structured plan" },
  { id: "applying", label: "Applying timeline" },
];

const STEP_INDEX = new Map(STEPS.map((step, index) => [step.id, index]));

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : "0";
}

function formatMetric(value) {
  return value == null ? "-" : formatNumber(value);
}

function statusForStep(stepId, phase, failedPhase) {
  if (phase === "complete") return "done";
  if (phase === "error") {
    const currentIndex = STEP_INDEX.get(failedPhase) ?? STEP_INDEX.get("waiting");
    const stepIndex = STEP_INDEX.get(stepId);
    return stepIndex < currentIndex ? "done" : stepIndex === currentIndex ? "error" : "pending";
  }
  const currentIndex = STEP_INDEX.get(phase) ?? 0;
  const stepIndex = STEP_INDEX.get(stepId) ?? 0;
  if (stepIndex < currentIndex) return "done";
  if (stepIndex === currentIndex) return "active";
  return "pending";
}

function StepIcon({ status }) {
  if (status === "done") return <CheckCircle2 size={15} />;
  if (status === "error") return <AlertTriangle size={15} />;
  if (status === "active") return <Loader2 className="spin" size={15} />;
  return <Clock3 size={15} />;
}

export function AiEditStatusModal({ run, onClose }) {
  const [now, setNow] = useState(() => Date.now());
  const open = Boolean(run?.open);
  const phase = run?.phase || "idle";
  const isRunning = open && !["complete", "error"].includes(phase);

  useEffect(() => {
    if (!open || !run?.startedAt || !isRunning) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [isRunning, open, run?.startedAt]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape" && !isRunning) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isRunning, onClose, open]);

  const elapsed = useMemo(() => {
    if (!run?.startedAt) return "0s";
    return formatDuration((run.completedAt || now) - run.startedAt);
  }, [now, run?.completedAt, run?.startedAt]);

  if (!open) return null;

  const usage = run?.usage || {};
  const hasUsage = usage.total_tokens != null || usage.prompt_tokens != null;
  const title =
    phase === "complete" ? "AI edit applied" : phase === "error" ? "AI edit failed" : "Planning edit";

  return (
    <div className="overlay" role="presentation" onMouseDown={isRunning ? undefined : onClose}>
      <section
        className="ai-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-edit-status-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ai-edit-modal-head">
          <div>
            <span className="settings-modal-kicker">OpenRouter</span>
            <h2 id="ai-edit-status-title">{title}</h2>
          </div>
          <button
            type="button"
            className="btn icon"
            onClick={onClose}
            disabled={isRunning}
            title="Close"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="ai-edit-modal-body">
          <div className="ai-edit-status-card">
            <div>
              <span>Model</span>
              <strong>{run?.routedModel || run?.model || "openai/gpt-5.4"}</strong>
            </div>
            <div>
              <span>Elapsed</span>
              <strong>{elapsed}</strong>
            </div>
            <div>
              <span>Transcript</span>
              <strong>
                {formatNumber(run?.itemCount)} items / {formatNumber(run?.clipCount)} clips
              </strong>
            </div>
            <div>
              <span>Candidates</span>
              <strong>{formatMetric(run?.candidateCount)}</strong>
            </div>
            <div>
              <span>Silence pass</span>
              <strong>
                {run?.removedSilenceCount == null
                  ? "-"
                  : `${formatNumber(run.removedSilenceCount)} cuts / ${formatNumber(
                      run.removedSilenceSeconds
                    )}s`}
              </strong>
            </div>
            <div>
              <span>Scenes</span>
              <strong>{run?.sceneCount == null ? "-" : formatNumber(run.sceneCount)}</strong>
            </div>
          </div>

          <ol className="ai-edit-steps">
            {STEPS.map((step) => {
              const stepStatus = statusForStep(step.id, phase, run?.failedPhase);
              return (
                <li key={step.id} className={`is-${stepStatus}`}>
                  <StepIcon status={stepStatus} />
                  <span>{step.label}</span>
                </li>
              );
            })}
          </ol>

          {hasUsage || run?.finishReason || run?.generationId ? (
            <div className="ai-edit-metrics">
              {hasUsage ? (
                <span>
                  Tokens: {formatNumber(usage.total_tokens)} total
                  {usage.prompt_tokens != null ? `, ${formatNumber(usage.prompt_tokens)} input` : ""}
                  {usage.completion_tokens != null
                    ? `, ${formatNumber(usage.completion_tokens)} output`
                    : ""}
                </span>
              ) : null}
              {run?.finishReason ? <span>Finish: {run.finishReason}</span> : null}
              {run?.generationId ? <span>Generation: {run.generationId}</span> : null}
            </div>
          ) : null}

          {run?.error ? (
            <div className="settings-modal-error" role="alert">
              {run.error}
            </div>
          ) : null}
        </div>

        <footer className="ai-edit-modal-footer">
          <span>
            {isRunning
              ? "Pass 1 is deterministic; OpenRouter handles take selection."
              : phase === "complete"
                ? "Timeline clips were replaced with the generated plan."
                : "No timeline changes were applied."}
          </span>
          <button className="btn primary" type="button" onClick={onClose} disabled={isRunning}>
            {isRunning ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
            <span>{isRunning ? "Running" : "Done"}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}
