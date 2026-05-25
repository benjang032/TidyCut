import { useCallback, useMemo, useReducer } from "react";
import { buildItems, countWords, rangeIdsBetween } from "./editorModel";

function emptyState() {
  return {
    items: [],
    selection: new Set(),
    anchorId: null,
    activeId: null,
  };
}

const initialState = emptyState();

function replaceSelection(ids, anchorId) {
  return {
    selection: new Set(ids),
    anchorId,
  };
}

function sameItems(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id) return false;
    if (a[i].start !== b[i].start || a[i].end !== b[i].end) return false;
    if (a[i].clipId !== b[i].clipId || a[i].sourceId !== b[i].sourceId) return false;
  }
  return true;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function syncPreparedState(state, items) {
  const nextItems = Array.isArray(items) ? items : [];
  const validIds = new Set(nextItems.map((item) => item.id));
  const selection = new Set([...state.selection].filter((id) => validIds.has(id)));
  const anchorId = state.anchorId && validIds.has(state.anchorId) ? state.anchorId : null;
  const activeId =
    state.activeId && validIds.has(state.activeId) ? state.activeId : nextItems[0]?.id || null;

  if (
    sameItems(state.items, nextItems) &&
    sameSet(state.selection, selection) &&
    state.anchorId === anchorId &&
    state.activeId === activeId
  ) {
    return state;
  }

  return {
    items: nextItems,
    selection,
    anchorId,
    activeId,
  };
}

function getVisibleDurations(items) {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.end - item.start), 0);
  return { total, cut: 0, kept: total };
}

function getVisibleSelectionStats(items, selection) {
  const selected = selection instanceof Set ? selection : new Set(selection || []);
  let words = 0;
  let gaps = 0;
  for (const item of items) {
    if (!selected.has(item.id)) continue;
    if (item.kind === "gap") gaps += 1;
    else words += 1;
  }
  return {
    size: selected.size,
    words,
    gaps,
  };
}

function getVisiblePlainText(items) {
  return items
    .filter((item) => item.kind === "word")
    .map((item) => item.text)
    .join(" ");
}

function editorReducer(state, action) {
  switch (action.type) {
    case "reset":
      return emptyState();

    case "loadItems":
      return {
        ...emptyState(),
        items: action.items,
        activeId: action.items[0]?.id || null,
      };

    case "loadPreparedItems":
      return {
        ...emptyState(),
        items: action.items,
        activeId: action.items[0]?.id || null,
      };

    case "syncPreparedItems":
      return syncPreparedState(state, action.items);

    case "selectSingle":
      return {
        ...state,
        ...replaceSelection([action.id], action.id),
      };

    case "extendSelection": {
      if (!state.anchorId) {
        return {
          ...state,
          ...replaceSelection([action.id], action.id),
        };
      }
      return {
        ...state,
        ...replaceSelection(rangeIdsBetween(state.items, state.anchorId, action.id), state.anchorId),
      };
    }

    case "toggleSelection": {
      const selection = new Set(state.selection);
      if (selection.has(action.id)) selection.delete(action.id);
      else selection.add(action.id);
      return {
        ...state,
        selection,
        anchorId: action.id,
      };
    }

    case "clearSelection":
      return {
        ...state,
        selection: new Set(),
        anchorId: null,
      };

    case "setActive":
      return {
        ...state,
        activeId: action.id,
      };

    default:
      return state;
  }
}

export function useTranscriptEditor() {
  const [state, dispatch] = useReducer(editorReducer, initialState);

  const loadWords = useCallback((words, options) => {
    const items = buildItems(words, options);
    if (!items.length) return { items, wordCount: 0 };
    dispatch({ type: "loadItems", items });
    return { items, wordCount: countWords(items) };
  }, []);

  const loadPreparedItems = useCallback((items) => {
    const preparedItems = Array.isArray(items) ? items : [];
    dispatch({ type: "loadPreparedItems", items: preparedItems });
    return { items: preparedItems, wordCount: countWords(preparedItems) };
  }, []);

  const syncPreparedItems = useCallback((items) => {
    const preparedItems = Array.isArray(items) ? items : [];
    dispatch({ type: "syncPreparedItems", items: preparedItems });
    return { items: preparedItems, wordCount: countWords(preparedItems) };
  }, []);

  const resetEditor = useCallback(() => {
    dispatch({ type: "reset" });
  }, []);

  const selectSingle = useCallback((id) => {
    dispatch({ type: "selectSingle", id });
  }, []);

  const extendSelection = useCallback((id) => {
    dispatch({ type: "extendSelection", id });
  }, []);

  const toggleInSelection = useCallback((id) => {
    dispatch({ type: "toggleSelection", id });
  }, []);

  const clearSelection = useCallback(() => {
    dispatch({ type: "clearSelection" });
  }, []);

  const setActiveId = useCallback((id) => {
    dispatch({ type: "setActive", id });
  }, []);

  const durations = useMemo(() => getVisibleDurations(state.items), [state.items]);
  const selectionStats = useMemo(
    () => getVisibleSelectionStats(state.items, state.selection),
    [state.items, state.selection]
  );
  const plainText = useMemo(() => getVisiblePlainText(state.items), [state.items]);

  return {
    ...state,
    durations,
    selectionStats,
    plainText,
    loadWords,
    loadPreparedItems,
    syncPreparedItems,
    resetEditor,
    selectSingle,
    extendSelection,
    toggleInSelection,
    clearSelection,
    setActiveId,
  };
}
