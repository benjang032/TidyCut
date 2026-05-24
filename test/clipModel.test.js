import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyTranscriptToClip, buildClipFromTranscript, makeReferencedClip } from "../src/clipModel.js";

describe("clip model", () => {
  it("keeps known source duration when applying a transcript without one", () => {
    const clip = {
      id: "clip-source",
      fileName: "source.mov",
      duration: 42,
      videoUrl: "/api/projects/project-a/video",
      status: "transcribing",
    };

    const updated = applyTranscriptToClip(clip, {
      projectId: "project-a",
      projectDir: "/tmp/project-a",
      videoPath: "/tmp/project-a/input.mov",
      model: "test-model",
      transcript: {
        source: { file_name: "source.mov" },
        words: [{ id: "w1", text: "hello", start: 0, end: 1 }],
      },
    });

    assert.equal(updated.status, "ready");
    assert.equal(updated.duration, 42);
    assert.equal(updated.source.duration, 42);
  });

  it("uses reference duration before transcription", () => {
    const clip = makeReferencedClip({
      projectId: "project-a",
      projectDir: "/tmp/project-a",
      videoPath: "/tmp/project-a/input.mov",
      videoUrl: "/api/projects/project-a/video",
      fileName: "source.mov",
      source: { file_name: "source.mov", duration: 12.5 },
    });

    assert.equal(clip.duration, 12.5);
    assert.equal(clip.status, "queued");
  });

  it("creates selectable boundary gaps from transcript source duration", () => {
    const clip = buildClipFromTranscript({
      projectId: "project",
      projectDir: "/tmp/project",
      videoPath: "/tmp/source.mov",
      model: "test-model",
      transcript: {
        source: { file_name: "source.mov", duration: 15.3 },
        words: [
          { id: "w1", text: "Hi", start: 7.42, end: 7.9 },
          { id: "w2", text: "there", start: 8.1, end: 8.4 },
        ],
      },
    });

    assert.deepEqual(
      clip.items.map(({ id, kind, start, end }) => ({ id, kind, start, end })),
      [
        { id: "g_leading", kind: "gap", start: 0, end: 7.42 },
        { id: "w1", kind: "word", start: 7.42, end: 7.9 },
        { id: "w2", kind: "word", start: 8.1, end: 8.4 },
        { id: "g_trailing", kind: "gap", start: 8.4, end: 15.3 },
      ]
    );
  });

  it("keeps a duration-only transcript as a selectable gap", () => {
    const updated = applyTranscriptToClip(
      {
        id: "clip-silent",
        fileName: "silent.mov",
        duration: 3,
        videoUrl: "/api/projects/project-a/video",
        status: "transcribing",
      },
      {
        projectId: "project-a",
        projectDir: "/tmp/project-a",
        videoPath: "/tmp/project-a/input.mov",
        model: "test-model",
        transcript: {
          source: { file_name: "silent.mov", duration: 3 },
          words: [],
        },
      }
    );

    assert.equal(updated.status, "ready");
    assert.equal(updated.wordCount, 0);
    assert.deepEqual(
      updated.items.map(({ id, kind, start, end }) => ({ id, kind, start, end })),
      [{ id: "g_full", kind: "gap", start: 0, end: 3 }]
    );
  });
});
