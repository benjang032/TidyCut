import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildItems,
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

  it("ranges include the token ids between two anchors", () => {
    const items = [
      { id: "w1", kind: "word" },
      { id: "g1", kind: "gap" },
      { id: "w2", kind: "word" },
    ];

    assert.deepEqual(rangeIdsBetween(items, "w2", "w1"), ["w1", "g1", "w2"]);
  });
});
