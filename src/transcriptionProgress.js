import { useEffect, useMemo, useState } from "react";

const UNKNOWN_VIDEO_SECONDS = 60;
const MIN_ESTIMATE_MS = 18_000;
const BASE_PIPELINE_MS = 8_000;
const MS_PER_VIDEO_SECOND = 750;
const MAX_IN_FLIGHT_PROGRESS = 94;
const MODEL_FACTORS = [
  { match: "tiny", factor: 0.45 },
  { match: "small", factor: 0.7 },
  { match: "medium", factor: 1 },
  { match: "large-v3-turbo", factor: 1.15 },
  { match: "large", factor: 1.5 },
];

function modelFactor(model = "") {
  const normalized = String(model).toLowerCase();
  return MODEL_FACTORS.find(({ match }) => normalized.includes(match))?.factor || 1;
}

export function estimateTranscriptionMs(videoDurationSeconds, model) {
  const duration =
    Number.isFinite(videoDurationSeconds) && videoDurationSeconds > 0
      ? videoDurationSeconds
      : UNKNOWN_VIDEO_SECONDS;
  return Math.max(
    MIN_ESTIMATE_MS,
    BASE_PIPELINE_MS + duration * MS_PER_VIDEO_SECOND * modelFactor(model)
  );
}

export function estimateTranscriptionProgress({ status, startedAt, now, videoDurationSeconds, model }) {
  if (status !== "transcribing" || !startedAt) return 0;

  const elapsedMs = Math.max(0, now - startedAt);
  const estimateMs = estimateTranscriptionMs(videoDurationSeconds, model);
  const ratio = Math.min(1, elapsedMs / estimateMs);
  const eased = 1 - Math.pow(1 - ratio, 1.35);
  const progress = 3 + eased * (MAX_IN_FLIGHT_PROGRESS - 3);

  return Math.min(MAX_IN_FLIGHT_PROGRESS, Math.max(3, Math.round(progress)));
}

export function useTranscriptionProgress(status, videoDurationSeconds, model) {
  const [startedAt, setStartedAt] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status !== "transcribing") {
      setStartedAt(null);
      return undefined;
    }

    const start = Date.now();
    setStartedAt(start);
    setNow(start);

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 250);

    return () => window.clearInterval(timer);
  }, [status]);

  return useMemo(
    () =>
      estimateTranscriptionProgress({
        status,
        startedAt: startedAt || (status === "transcribing" ? now : null),
        now,
        videoDurationSeconds,
        model,
      }),
    [model, now, startedAt, status, videoDurationSeconds]
  );
}
