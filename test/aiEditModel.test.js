import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAiEditPlanToClips,
  buildAiEditRequestClips,
  normalizeAiEditPlan,
} from "../src/aiEditModel.js";

function readyClip(overrides = {}) {
  return {
    id: "clip-a",
    projectId: "project-a",
    fileName: "source.mov",
    status: "ready",
    duration: 20,
    trimStart: 0,
    trimEnd: null,
    items: [
      { id: "w1", kind: "word", text: "First", start: 1, end: 1.4 },
      { id: "g1", kind: "gap", text: "", start: 1.4, end: 2.1 },
      { id: "w2", kind: "word", text: "take", start: 2.1, end: 2.5 },
      { id: "w3", kind: "word", text: "Second", start: 6, end: 6.4 },
      { id: "w4", kind: "word", text: "take", start: 6.5, end: 7 },
    ],
    cut: new Set(),
    ...overrides,
  };
}

describe("AI edit model", () => {
  it("builds a transcript/timestamp request from visible uncut items", () => {
    const requestClips = buildAiEditRequestClips([
      readyClip({
        trimStart: 1,
        trimEnd: 7,
        cut: new Set(["w2"]),
      }),
    ]);

    assert.equal(requestClips.length, 1);
    assert.equal(requestClips[0].clip_id, "clip-a");
    assert.equal(requestClips[0].trim_start, 1);
    assert.equal(requestClips[0].trim_end, 7);
    assert.deepEqual(
      requestClips[0].transcript_items.map((item) => item.id),
      ["w1", "g1", "w3", "w4"]
    );
    assert.match(requestClips[0].transcript_items[1].text, /\[pause 700ms\]/);
  });

  it("normalizes returned ranges to source clip bounds", () => {
    const source = readyClip({ trimStart: 1, trimEnd: 8 });
    const plan = normalizeAiEditPlan(
      {
        timeline: [
          {
            edit_id: "edit_1",
            source_clip_id: "clip-a",
            source_start: 0,
            source_end: 9,
            text: "First take Second take",
            scene_type: "complete_take",
            can_stand_alone: true,
            reason: "Best take",
            confidence: 0.9,
          },
        ],
      },
      [source]
    );

    assert.equal(plan.timeline.length, 1);
    assert.equal(plan.timeline[0].sourceStart, 1);
    assert.equal(plan.timeline[0].sourceEnd, 8);
  });

  it("applies a scene timeline as cloned whole-scene clips", () => {
    const source = readyClip({ cut: new Set(["g1"]) });
    const result = applyAiEditPlanToClips(
      [source],
      {
        timeline: [
          {
            edit_id: "edit_intro",
            source_clip_id: "clip-a",
            source_start: 1,
            source_end: 2.6,
            text: "First take",
            scene_type: "intro",
            can_stand_alone: true,
            reason: "Clean opener",
            confidence: 0.84,
          },
          {
            edit_id: "edit_main",
            source_clip_id: "clip-a",
            source_start: 6,
            source_end: 7,
            text: "Second take",
            scene_type: "main_point",
            can_stand_alone: true,
            reason: "Best repeated take",
            confidence: 0.91,
          },
        ],
      },
      (_clip, _entry, index) => `ai-${index + 1}`
    );

    assert.deepEqual(
      result.clips.map((clip) => [clip.id, clip.trimStart, clip.trimEnd]),
      [
        ["ai-1", 1, 2.6],
        ["ai-2", 6, 7],
      ]
    );
    assert.ok(result.clips[0].cut instanceof Set);
    assert.ok(result.clips[0].cut.has("g1"));
    assert.equal(result.clips[1].aiEdit.reason, "Best repeated take");
  });
});
