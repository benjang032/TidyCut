import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateTranscriptionMs,
  estimateTranscriptionProgress,
} from "../src/transcriptionProgress.js";

describe("transcription progress", () => {
  it("uses a bounded estimate when video duration is missing", () => {
    assert.equal(estimateTranscriptionMs(0), 53_000);
    assert.equal(estimateTranscriptionMs(Number.NaN), 53_000);
  });

  it("adjusts estimates by selected model size", () => {
    const tiny = estimateTranscriptionMs(120, "mlx-community/whisper-tiny");
    const large = estimateTranscriptionMs(120, "mlx-community/whisper-large-v3-mlx");

    assert.ok(tiny < large);
  });

  it("keeps in-flight transcription below completion", () => {
    const startedAt = 1_000;
    const now = startedAt + estimateTranscriptionMs(120) * 2;

    assert.equal(
      estimateTranscriptionProgress({
        status: "transcribing",
        startedAt,
        now,
        videoDurationSeconds: 120,
        model: "mlx-community/whisper-large-v3-turbo",
      }),
      94
    );
  });

  it("resets outside the transcribing state", () => {
    assert.equal(
      estimateTranscriptionProgress({
        status: "done",
        startedAt: 1_000,
        now: 10_000,
        videoDurationSeconds: 20,
      }),
      0
    );
  });
});
