import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySequenceTranscriptCut,
  buildSequenceRenderClips,
  buildSequencePlaybackEntries,
  getClipTimeline,
  buildSequenceTranscriptItems,
  getFirstReadyPlaybackEntry,
  getNextReadyPlaybackEntry,
  getSequenceDurations,
  getSequencePlainText,
  getSequenceTranscriptCut,
  isSequencePlaybackComplete,
  moveClipBefore,
  sequenceTimeToSourceTime,
  sourceTimeToSequenceTime,
  splitClip,
} from "../src/sequenceModel.js";

describe("sequence model", () => {
  const clipA = {
    id: "clip-a",
    projectId: "project-a",
    fileName: "a.mov",
    items: [
      { id: "a1", kind: "word", text: "first", start: 0, end: 1 },
      { id: "a2", kind: "word", text: "drop", start: 1, end: 2 },
    ],
    cut: new Set(["a2"]),
  };
  const clipB = {
    id: "clip-b",
    projectId: "project-b",
    fileName: "b.mov",
    items: [{ id: "b1", kind: "word", text: "second", start: 4, end: 5 }],
    cut: new Set(),
  };

  it("builds a multi-project render plan from clip state", () => {
    assert.deepEqual(buildSequenceRenderClips([clipA, clipB]), [
      {
        clipId: "clip-a",
        projectId: "project-a",
        label: "a.mov",
        timeline: [{ source_start: 0, source_end: 1 }],
      },
      {
        clipId: "clip-b",
        projectId: "project-b",
        label: "b.mov",
        timeline: [{ source_start: 4, source_end: 5 }],
      },
    ]);
  });

  it("sums durations and exported text across the sequence", () => {
    assert.deepEqual(getSequenceDurations([clipA, clipB]), {
      total: 3,
      cut: 1,
      kept: 2,
    });
    assert.equal(getSequencePlainText([clipA, clipB]), "first\n\nsecond");
  });

  it("moves clips before a target without mutating the original array", () => {
    const moved = moveClipBefore([clipA, clipB], "clip-b", "clip-a");
    assert.deepEqual(
      moved.map((clip) => clip.id),
      ["clip-b", "clip-a"]
    );
    assert.deepEqual(
      [clipA, clipB].map((clip) => clip.id),
      ["clip-a", "clip-b"]
    );
  });

  it("clips render segments and duration stats to exact trim boundaries", () => {
    const clip = {
      id: "clip-trimmed",
      projectId: "project-trimmed",
      fileName: "trimmed.mov",
      duration: 2,
      trimStart: 0.5,
      trimEnd: 1.5,
      items: [{ id: "w1", kind: "word", text: "hello", start: 0, end: 2 }],
      cut: new Set(),
    };

    assert.deepEqual(buildSequenceRenderClips([clip]), [
      {
        clipId: "clip-trimmed",
        projectId: "project-trimmed",
        label: "trimmed.mov",
        timeline: [{ source_start: 0.5, source_end: 1.5 }],
      },
    ]);
    assert.deepEqual(getSequenceDurations([clip]), {
      total: 1,
      cut: 0,
      kept: 1,
    });
  });

  it("keeps source media before the first transcript item when duration is known", () => {
    const clip = {
      id: "clip-late-speech",
      projectId: "project-late-speech",
      fileName: "late-speech.mov",
      duration: 15.3,
      trimStart: 0,
      trimEnd: null,
      items: [
        { id: "w1", kind: "word", text: "hi", start: 7.42, end: 7.9 },
        { id: "w2", kind: "word", text: "there", start: 8.1, end: 8.4 },
      ],
      cut: new Set(),
      status: "ready",
    };

    assert.deepEqual(getClipTimeline(clip), [{ source_start: 0, source_end: 15.3 }]);
    assert.deepEqual(buildSequenceRenderClips([clip])[0].timeline, [
      { source_start: 0, source_end: 15.3 },
    ]);
    assert.deepEqual(getSequenceDurations([clip]), {
      total: 15.3,
      cut: 0,
      kept: 15.3,
    });
  });

  it("cuts transcript items without dropping untranscribed source media", () => {
    const clip = {
      id: "clip-cut-late-word",
      projectId: "project-cut-late-word",
      fileName: "cut-late-word.mov",
      duration: 15.3,
      trimStart: 0,
      trimEnd: null,
      items: [
        { id: "w1", kind: "word", text: "hi", start: 7.42, end: 7.9 },
        { id: "w2", kind: "word", text: "there", start: 8.1, end: 8.4 },
      ],
      cut: new Set(["w1"]),
      status: "ready",
    };

    assert.deepEqual(getClipTimeline(clip), [
      { source_start: 0, source_end: 7.42 },
      { source_start: 7.9, source_end: 15.3 },
    ]);
    const durations = getSequenceDurations([clip]);
    assert.equal(durations.total, 15.3);
    assert.equal(Number(durations.cut.toFixed(2)), 0.48);
    assert.equal(Number(durations.kept.toFixed(2)), 14.82);
  });

  it("builds a visible sequence transcript across trimmed clips", () => {
    const items = buildSequenceTranscriptItems([
      {
        ...clipA,
        trimStart: 0.5,
        trimEnd: 2,
        duration: 2,
        status: "ready",
      },
      {
        ...clipB,
        duration: 6,
        trimStart: 4,
        trimEnd: 5,
        status: "ready",
      },
    ]);

    assert.deepEqual(
      items.map(({ id, sourceId, clipId, start, end, sequenceStart, sequenceEnd }) => ({
        id,
        sourceId,
        clipId,
        start,
        end,
        sequenceStart,
        sequenceEnd,
      })),
      [
        {
          id: "clip-a::a1",
          sourceId: "a1",
          clipId: "clip-a",
          start: 0.5,
          end: 1,
          sequenceStart: 0,
          sequenceEnd: 0.5,
        },
        {
          id: "clip-a::a2",
          sourceId: "a2",
          clipId: "clip-a",
          start: 1,
          end: 2,
          sequenceStart: 0.5,
          sequenceEnd: 1.5,
        },
        {
          id: "clip-b::b1",
          sourceId: "b1",
          clipId: "clip-b",
          start: 4,
          end: 5,
          sequenceStart: 1.5,
          sequenceEnd: 2.5,
        },
      ]
    );
  });

  it("maps sequence transcript cuts back to owning clips without losing hidden cuts", () => {
    const clips = [
      {
        ...clipA,
        trimStart: 0,
        trimEnd: 1,
        duration: 2,
        cut: new Set(["a2"]),
        status: "ready",
      },
      { ...clipB, duration: 5, status: "ready" },
    ];
    const items = buildSequenceTranscriptItems(clips);
    const cut = getSequenceTranscriptCut(clips, items);
    assert.deepEqual([...cut], []);

    const next = applySequenceTranscriptCut(clips, items, new Set(["clip-a::a1", "clip-b::b1"]));
    assert.deepEqual([...next[0].cut].sort(), ["a1", "a2"]);
    assert.deepEqual([...next[1].cut], ["b1"]);
  });

  it("splits clips into non-overlapping render ranges", () => {
    const [left, right] = splitClip(
      [
        {
          id: "clip-split",
          projectId: "project-split",
          fileName: "split.mov",
          duration: 2,
          trimStart: 0,
          trimEnd: 2,
          items: [{ id: "w1", kind: "word", text: "hello", start: 0, end: 2 }],
          cut: new Set(),
          status: "ready",
        },
      ],
      "clip-split",
      1,
      () => "clip-split-right"
    );

    assert.deepEqual(buildSequenceRenderClips([left, right]), [
      {
        clipId: "clip-split",
        projectId: "project-split",
        label: "split.mov",
        timeline: [{ source_start: 0, source_end: 1 }],
      },
      {
        clipId: "clip-split-right",
        projectId: "project-split",
        label: "split.mov",
        timeline: [{ source_start: 1, source_end: 2 }],
      },
    ]);
  });

  it("maps source times to stable sequence times across split clips", () => {
    const [left, right] = splitClip(
      [
        {
          id: "clip-split-map",
          projectId: "project-split-map",
          fileName: "split-map.mov",
          duration: 6,
          trimStart: 1,
          trimEnd: 5,
          items: [
            { id: "w1", kind: "word", text: "left", start: 1, end: 3 },
            { id: "w2", kind: "word", text: "right", start: 3, end: 5 },
          ],
          cut: new Set(),
          status: "ready",
        },
      ],
      "clip-split-map",
      3,
      () => "clip-split-map-right"
    );

    assert.deepEqual(
      buildSequencePlaybackEntries([left, right]).map(
        ({ clipId, sourceStart, sourceEnd, sequenceStart, sequenceEnd }) => ({
          clipId,
          sourceStart,
          sourceEnd,
          sequenceStart,
          sequenceEnd,
        })
      ),
      [
        {
          clipId: "clip-split-map",
          sourceStart: 1,
          sourceEnd: 3,
          sequenceStart: 0,
          sequenceEnd: 2,
        },
        {
          clipId: "clip-split-map-right",
          sourceStart: 3,
          sourceEnd: 5,
          sequenceStart: 2,
          sequenceEnd: 4,
        },
      ]
    );
    assert.equal(sourceTimeToSequenceTime([left, right], "clip-split-map-right", 3.5), 2.5);
    assert.equal(sequenceTimeToSourceTime([left, right], 2).clipId, "clip-split-map-right");
    assert.deepEqual(sequenceTimeToSourceTime([left, right], 2.5), {
      clipId: "clip-split-map-right",
      sourceTime: 3.5,
      entry: buildSequencePlaybackEntries([left, right])[1],
    });
    assert.equal(getFirstReadyPlaybackEntry([left, right])?.clipId, "clip-split-map");
    assert.equal(getNextReadyPlaybackEntry([left, right], "clip-split-map")?.clipId, "clip-split-map-right");
    assert.equal(isSequencePlaybackComplete([left, right], "clip-split-map-right", 5, 4), true);
    assert.equal(isSequencePlaybackComplete([left, right], "clip-split-map-right", 4.5, 3.5), false);
  });

  it("splits clips whose trim end is still unset", () => {
    const result = splitClip(
      [
        {
          id: "clip-unspecified-end",
          projectId: "project-unspecified-end",
          fileName: "full.mov",
          duration: 4,
          trimStart: 0,
          trimEnd: null,
          items: [
            { id: "w1", kind: "word", text: "one", start: 0, end: 1 },
            { id: "w2", kind: "word", text: "two", start: 2, end: 3 },
          ],
          cut: new Set(),
          status: "ready",
        },
      ],
      "clip-unspecified-end",
      2,
      () => "clip-unspecified-end-right"
    );

    assert.deepEqual(
      result.map(({ id, trimStart, trimEnd }) => ({ id, trimStart, trimEnd })),
      [
        { id: "clip-unspecified-end", trimStart: 0, trimEnd: 2 },
        { id: "clip-unspecified-end-right", trimStart: 2, trimEnd: null },
      ]
    );
  });

  it("does not duplicate a transcript token across a split boundary", () => {
    const [left, right] = splitClip(
      [
        {
          id: "clip-boundary",
          projectId: "project-boundary",
          fileName: "boundary.mov",
          duration: 4,
          trimStart: 0,
          trimEnd: null,
          items: [{ id: "w1", kind: "word", text: "center", start: 1, end: 3 }],
          cut: new Set(),
          status: "ready",
        },
      ],
      "clip-boundary",
      2,
      () => "clip-boundary-right"
    );

    assert.deepEqual(
      buildSequenceTranscriptItems([left, right]).map((item) => ({
        id: item.id,
        start: item.start,
        end: item.end,
      })),
      [{ id: "clip-boundary-right::w1", start: 2, end: 3 }]
    );
  });
});
