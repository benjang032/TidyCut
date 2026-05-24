export const PAUSE_THRESHOLD = 0.35;
export const SKIP_EPSILON = 0.02;

export function formatClock(seconds = 0) {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = Math.floor(total - m * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatPauseLabel(seconds = 0) {
  if (seconds >= 1) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds * 1000)}ms`;
}

function finitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function makeGap(id, start, end) {
  return {
    id,
    kind: "gap",
    text: "",
    start: Number(start),
    end: Number(end),
  };
}

export function buildItems(words = [], options = {}) {
  const sorted = [...words]
    .filter((w) => w && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end)))
    .sort((a, b) => Number(a.start) - Number(b.start));

  const sourceDuration = finitePositiveNumber(options.sourceDuration);
  const items = [];
  if (!sorted.length) {
    return sourceDuration >= PAUSE_THRESHOLD ? [makeGap("g_full", 0, sourceDuration)] : [];
  }

  const firstWordStart = Number(sorted[0]?.start);
  if (sourceDuration > 0 && Number.isFinite(firstWordStart) && firstWordStart >= PAUSE_THRESHOLD) {
    items.push(makeGap("g_leading", 0, Math.min(firstWordStart, sourceDuration)));
  }

  for (let i = 0; i < sorted.length; i += 1) {
    const w = sorted[i];
    const start = Number(w.start);
    const end = Number(w.end);
    items.push({
      id: w.id || `w_${String(i + 1).padStart(6, "0")}`,
      kind: "word",
      text: String(w.text || "").trim(),
      start,
      end,
    });

    const next = sorted[i + 1];
    if (!next) continue;
    const gap = Number(next.start) - end;
    if (gap >= PAUSE_THRESHOLD) {
      items.push(makeGap(`g_${String(i + 1).padStart(6, "0")}`, end, Number(next.start)));
    }
  }

  const lastWordEnd = Number(sorted.at(-1)?.end);
  if (sourceDuration > 0 && Number.isFinite(lastWordEnd)) {
    const tailStart = Math.max(0, Math.min(lastWordEnd, sourceDuration));
    if (sourceDuration - tailStart >= PAUSE_THRESHOLD) {
      items.push(makeGap("g_trailing", tailStart, sourceDuration));
    }
  }

  return items;
}

export function countWords(items = []) {
  return items.filter((it) => it.kind === "word").length;
}

export function rangeIdsBetween(items, aId, bId) {
  if (!aId || !bId) return [];
  const a = items.findIndex((i) => i.id === aId);
  const b = items.findIndex((i) => i.id === bId);
  if (a < 0 || b < 0) return [];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return items.slice(lo, hi + 1).map((i) => i.id);
}

export function computeTimeline(items, cut) {
  const segs = [];
  let cur = null;
  for (const it of items) {
    if (cut.has(it.id)) {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { source_start: it.start, source_end: it.end };
      segs.push(cur);
    } else {
      cur.source_end = it.end;
    }
  }
  return segs.map((s) => ({
    source_start: Number(s.source_start.toFixed(3)),
    source_end: Number(s.source_end.toFixed(3)),
  }));
}

export function nextKeptTime(timeline, t) {
  for (const seg of timeline) {
    if (t < seg.source_start - SKIP_EPSILON) return seg.source_start;
    if (t < seg.source_end - SKIP_EPSILON) return null;
  }
  return Number.POSITIVE_INFINITY;
}

export function getDurations(items, cut) {
  const total = items.reduce((sum, it) => sum + (it.end - it.start), 0);
  const cutTotal = items.reduce(
    (sum, it) => (cut.has(it.id) ? sum + (it.end - it.start) : sum),
    0
  );
  return { total, cut: cutTotal, kept: total - cutTotal };
}

export function getSelectionStats(items, cut, selection) {
  const byId = new Map(items.map((it) => [it.id, it]));
  let words = 0;
  let gaps = 0;
  let cutCount = 0;
  let activeCount = 0;

  for (const id of selection) {
    const it = byId.get(id);
    if (!it) continue;
    if (it.kind === "word") words += 1;
    if (it.kind === "gap") gaps += 1;
    if (cut.has(id)) cutCount += 1;
    else activeCount += 1;
  }

  return {
    size: selection.size,
    words,
    gaps,
    cutCount,
    activeCount,
  };
}

export function getPlainText(items, cut) {
  return items
    .filter((it) => it.kind === "word" && !cut.has(it.id))
    .map((it) => it.text)
    .join(" ");
}
