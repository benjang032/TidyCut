import { useCallback, useMemo, useReducer } from "react";
import {
  buildItems,
  computeTimeline,
  countWords,
  getDurations,
  getPlainText,
  getSelectionStats,
  rangeIdsBetween,
} from "./editorModel";

function emptyState() {
  return {
    items: [],
    cut: new Set(),
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

function syncPreparedState(state, items, cut) {
  const nextItems = Array.isArray(items) ? items : [];
  const nextCut = new Set(cut || []);
  const validIds = new Set(nextItems.map((item) => item.id));
  const selection = new Set([...state.selection].filter((id) => validIds.has(id)));
  const anchorId = state.anchorId && validIds.has(state.anchorId) ? state.anchorId : null;
  const activeId =
    state.activeId && validIds.has(state.activeId) ? state.activeId : nextItems[0]?.id || null;

  if (
    sameItems(state.items, nextItems) &&
    sameSet(state.cut, nextCut) &&
    sameSet(state.selection, selection) &&
    state.anchorId === anchorId &&
    state.activeId === activeId
  ) {
    return state;
  }

  return {
    items: nextItems,
    cut: nextCut,
    selection,
    anchorId,
    activeId,
  };
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
        cut: new Set(action.cut || []),
        activeId: action.items[0]?.id || null,
      };

    case "syncPreparedItems":
      return syncPreparedState(state, action.items, action.cut);

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

    case "cutSelection": {
      if (!state.selection.size) return state;
      const cut = new Set(state.cut);
      for (const id of state.selection) cut.add(id);
      return {
        ...state,
        cut,
        selection: new Set(),
        anchorId: null,
      };
    }

    case "restoreSelection": {
      if (!state.selection.size) return state;
      const cut = new Set(state.cut);
      for (const id of state.selection) cut.delete(id);
      return {
        ...state,
        cut,
      };
    }

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

  const loadPreparedItems = useCallback((items, cut = new Set()) => {
    const preparedItems = Array.isArray(items) ? items : [];
    dispatch({ type: "loadPreparedItems", items: preparedItems, cut });
    return { items: preparedItems, wordCount: countWords(preparedItems) };
  }, []);

  const syncPreparedItems = useCallback((items, cut = new Set()) => {
    const preparedItems = Array.isArray(items) ? items : [];
    dispatch({ type: "syncPreparedItems", items: preparedItems, cut });
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

  const cutSelected = useCallback(() => {
    dispatch({ type: "cutSelection" });
  }, []);

  const restoreSelected = useCallback(() => {
    dispatch({ type: "restoreSelection" });
  }, []);

  const setActiveId = useCallback((id) => {
    dispatch({ type: "setActive", id });
  }, []);

  const timeline = useMemo(() => computeTimeline(state.items, state.cut), [state.items, state.cut]);
  const durations = useMemo(() => getDurations(state.items, state.cut), [state.items, state.cut]);
  const selectionStats = useMemo(
    () => getSelectionStats(state.items, state.cut, state.selection),
    [state.items, state.cut, state.selection]
  );
  const plainText = useMemo(() => getPlainText(state.items, state.cut), [state.items, state.cut]);

  return {
    ...state,
    timeline,
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
    cutSelected,
    restoreSelected,
    setActiveId,
  };
}
