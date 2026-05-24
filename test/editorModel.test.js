import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildItems,
  computeTimeline,
  getPlainText,
  getSelectionStats,
  nextKeptTime,
  rangeIdsBetween,
} from "../src/editorModel.js";

describe("editor model", () => {
  it("sorts words and inserts selectable gap items for pauses", () => {
    const items = buildItems([
      { id: "w2", text: "world", start: 1.5, end: 2 },
      { id: "w1", text: "hello", start: 0, end: 0.5 },
      { id: "bad", text: "ignored", start: "x", end: 3 },
    ]);

    assert.deepEqual(
      items.map(({ id, kind, text, start, end }) => ({ id, kind, text, start, end })),
      [
        { id: "w1", kind: "word", text: "hello", start: 0, end: 0.5 },
        { id: "g_000001", kind: "gap", text: "", start: 0.5, end: 1.5 },
        { id: "w2", kind: "word", text: "world", start: 1.5, end: 2 },
      ]
    );
  });

  it("adds selectable leading and trailing gaps when source duration is known", () => {
    const items = buildItems(
      [
        { id: "w1", text: "hello", start: 7.42, end: 7.9 },
        { id: "w2", text: "world", start: 8.1, end: 8.4 },
      ],
      { sourceDuration: 15.3 }
    );

    assert.deepEqual(
      items.map(({ id, kind, text, start, end }) => ({ id, kind, text, start, end })),
      [
        { id: "g_leading", kind: "gap", text: "", start: 0, end: 7.42 },
        { id: "w1", kind: "word", text: "hello", start: 7.42, end: 7.9 },
        { id: "w2", kind: "word", text: "world", start: 8.1, end: 8.4 },
        { id: "g_trailing", kind: "gap", text: "", start: 8.4, end: 15.3 },
      ]
    );
  });

  it("creates a full-length selectable gap when no words are recognized", () => {
    assert.deepEqual(buildItems([], { sourceDuration: 3 }), [
      { id: "g_full", kind: "gap", text: "", start: 0, end: 3 },
    ]);
  });

  it("computes render segments from cut token ids", () => {
    const items = [
      { id: "w1", kind: "word", start: 0, end: 1 },
      { id: "g1", kind: "gap", start: 1, end: 2 },
      { id: "w2", kind: "word", start: 2, end: 3 },
      { id: "w3", kind: "word", start: 3, end: 4 },
    ];

    assert.deepEqual(computeTimeline(items, new Set(["g1", "w3"])), [
      { source_start: 0, source_end: 1 },
      { source_start: 2, source_end: 3 },
    ]);
  });

  it("keeps selection statistics token-aware", () => {
    const items = [
      { id: "w1", kind: "word", start: 0, end: 1 },
      { id: "g1", kind: "gap", start: 1, end: 2 },
      { id: "w2", kind: "word", start: 2, end: 3 },
    ];

    assert.deepEqual(getSelectionStats(items, new Set(["g1"]), new Set(["w1", "g1"])), {
      size: 2,
      words: 1,
      gaps: 1,
      cutCount: 1,
      activeCount: 1,
    });
  });

  it("ranges include the token ids between two anchors", () => {
    const items = [
      { id: "w1", kind: "word" },
      { id: "g1", kind: "gap" },
      { id: "w2", kind: "word" },
    ];

    assert.deepEqual(rangeIdsBetween(items, "w2", "w1"), ["w1", "g1", "w2"]);
  });

  it("builds kept text and playback skip targets from the same cut model", () => {
    const items = [
      { id: "w1", kind: "word", text: "keep", start: 0, end: 1 },
      { id: "w2", kind: "word", text: "drop", start: 1, end: 2 },
      { id: "w3", kind: "word", text: "tail", start: 3, end: 4 },
    ];
    const cut = new Set(["w2"]);
    const timeline = computeTimeline(items, cut);

    assert.equal(getPlainText(items, cut), "keep tail");
    assert.equal(nextKeptTime(timeline, 0.5), null);
    assert.equal(nextKeptTime(timeline, 1.5), 3);
    assert.equal(nextKeptTime(timeline, 4), Number.POSITIVE_INFINITY);
  });
});
