import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hydrateProjectDocument,
  projectDocumentSignature,
  serializeProjectDocument,
} from "../src/projectModel.js";

describe("project model", () => {
  it("serializes restorable clip state without transient upload handles", () => {
    const document = serializeProjectDocument({
      project: { id: "edit-a", name: "Launch edit", createdAt: 10, updatedAt: 20 },
      activeClipId: "clip-a",
      selectedModel: "test-model",
      audioProcessing: { denoise: true, normalize: false },
      clips: [
        {
          id: "clip-a",
          projectId: "media-a",
          videoUrl: "blob:http://localhost/not-restorable",
          fileName: "source.mov",
          duration: 12,
          status: "ready",
          _pending: { file: {} },
          items: [{ id: "w1", kind: "word", text: "hello", start: 0, end: 1 }],
        },
      ],
    });

    assert.equal(document.clips[0].videoUrl, "/api/projects/media-a/video");
    assert.equal(document.mediaSources[0].id, "clip-a");
    assert.equal(document.mediaSources[0].mediaSourceId, "clip-a");
    assert.equal(Object.hasOwn(document.clips[0], "cut"), false);
    assert.equal(document.clips[0].trimEnd, null);
    assert.equal("_pending" in document.clips[0], false);
  });

  it("hydrates saved clips with project video URLs", () => {
    const hydrated = hydrateProjectDocument({
      id: "edit-a",
      name: "Saved edit",
      selectedModel: "test-model",
      activeClipId: "clip-a",
      clips: [
        {
          id: "clip-a",
          projectId: "media-a",
          fileName: "source.mov",
          duration: 12,
          items: [{ id: "w1", kind: "word", text: "hello", start: 0, end: 1 }],
        },
      ],
    });

    assert.equal(hydrated.activeClipId, "clip-a");
    assert.equal(hydrated.clips[0].status, "ready");
    assert.equal(hydrated.clips[0].mediaSourceId, "clip-a");
    assert.equal(hydrated.mediaSources.length, 1);
    assert.equal(hydrated.clips[0].videoUrl, "/api/projects/media-a/video");
    assert.equal(Object.hasOwn(hydrated.clips[0], "cut"), false);
  });

  it("migrates legacy cut words into split source-range clips", () => {
    const hydrated = hydrateProjectDocument({
      id: "edit-a",
      activeClipId: "clip-a",
      clips: [
        {
          id: "clip-a",
          projectId: "media-a",
          fileName: "source.mov",
          duration: 5,
          trimStart: 0,
          trimEnd: null,
          items: [
            { id: "w1", kind: "word", text: "keep", start: 0, end: 1 },
            { id: "w2", kind: "word", text: "drop", start: 1, end: 2 },
            { id: "w3", kind: "word", text: "tail", start: 2, end: 3 },
          ],
          cut: ["w2"],
        },
      ],
    });

    assert.deepEqual(
      hydrated.clips.map((clip) => ({
        id: clip.id,
        trimStart: clip.trimStart,
        trimEnd: clip.trimEnd,
        hasCut: Object.hasOwn(clip, "cut"),
      })),
      [
        { id: "clip-a", trimStart: 0, trimEnd: 1, hasCut: false },
        { id: "clip-a_migrated_0_1", trimStart: 2, trimEnd: null, hasCut: false },
      ]
    );
  });

  it("recovers legacy untrimmed clips saved with a zero trim end", () => {
    const hydrated = hydrateProjectDocument({
      id: "edit-a",
      activeClipId: "clip-a",
      clips: [
        {
          id: "clip-a",
          projectId: "media-a",
          fileName: "source.mov",
          duration: 12,
          trimStart: 0,
          trimEnd: 0,
          items: [{ id: "w1", kind: "word", text: "hello", start: 3, end: 4 }],
        },
        {
          id: "clip-b",
          projectId: "media-a",
          fileName: "source.mov",
          duration: 12,
          trimStart: 3,
          trimEnd: 0,
          items: [{ id: "w2", kind: "word", text: "again", start: 5, end: 6 }],
        },
      ],
    });

    assert.equal(hydrated.clips[0].trimEnd, null);
    assert.equal(hydrated.clips[1].trimEnd, null);
  });

  it("marks unsaved upload clips as unrecoverable after reload", () => {
    const hydrated = hydrateProjectDocument({
      id: "edit-a",
      clips: [
        {
          id: "clip-upload",
          fileName: "upload.mov",
          status: "transcribing",
          items: [],
        },
      ],
    });

    assert.equal(hydrated.clips[0].status, "error");
    assert.match(hydrated.clips[0].error, /not saved before transcription finished/i);
  });

  it("hydrates persisted media sources separately from timeline copies", () => {
    const hydrated = hydrateProjectDocument({
      id: "edit-a",
      activeClipId: "copy-a",
      mediaSources: [
        {
          id: "source-a",
          mediaSourceId: "source-a",
          projectId: "media-a",
          fileName: "source.mov",
          duration: 12,
          trimStart: 4,
          trimEnd: 5,
          items: [{ id: "w1", kind: "word", text: "hello", start: 0, end: 1 }],
        },
      ],
      clips: [
        {
          id: "copy-a",
          mediaSourceId: "source-a",
          projectId: "media-a",
          fileName: "source.mov",
          duration: 12,
          trimStart: 4,
          trimEnd: 5,
          items: [{ id: "w1", kind: "word", text: "hello", start: 0, end: 1 }],
        },
      ],
    });

    assert.equal(hydrated.clips[0].id, "copy-a");
    assert.equal(hydrated.clips[0].mediaSourceId, "source-a");
    assert.equal(hydrated.mediaSources[0].id, "source-a");
    assert.equal(hydrated.mediaSources[0].trimStart, 0);
    assert.equal(hydrated.mediaSources[0].trimEnd, null);
    assert.equal(Object.hasOwn(hydrated.mediaSources[0], "cut"), false);
  });

  it("keeps project signatures stable across server timestamp updates", () => {
    const a = { id: "edit-a", name: "A", updatedAt: 10, clips: [] };
    const b = { id: "edit-a", name: "A", updatedAt: 20, clips: [] };
    assert.equal(projectDocumentSignature(a), projectDocumentSignature(b));
  });
});
