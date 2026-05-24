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
          cut: new Set(["w1"]),
        },
      ],
    });

    assert.equal(document.clips[0].videoUrl, "/api/projects/media-a/video");
    assert.deepEqual(document.clips[0].cut, ["w1"]);
    assert.equal(document.clips[0].trimEnd, null);
    assert.equal("_pending" in document.clips[0], false);
  });

  it("hydrates saved clips with Sets and project video URLs", () => {
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
          cut: ["w1"],
        },
      ],
    });

    assert.equal(hydrated.activeClipId, "clip-a");
    assert.equal(hydrated.clips[0].status, "ready");
    assert.equal(hydrated.clips[0].videoUrl, "/api/projects/media-a/video");
    assert.equal(hydrated.clips[0].cut instanceof Set, true);
    assert.equal(hydrated.clips[0].cut.has("w1"), true);
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
          cut: [],
        },
        {
          id: "clip-b",
          projectId: "media-a",
          fileName: "source.mov",
          duration: 12,
          trimStart: 3,
          trimEnd: 0,
          items: [{ id: "w2", kind: "word", text: "again", start: 5, end: 6 }],
          cut: [],
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
          cut: [],
        },
      ],
    });

    assert.equal(hydrated.clips[0].status, "error");
    assert.match(hydrated.clips[0].error, /not saved before transcription finished/i);
  });

  it("keeps project signatures stable across server timestamp updates", () => {
    const a = { id: "edit-a", name: "A", updatedAt: 10, clips: [] };
    const b = { id: "edit-a", name: "A", updatedAt: 20, clips: [] };
    assert.equal(projectDocumentSignature(a), projectDocumentSignature(b));
  });
});
