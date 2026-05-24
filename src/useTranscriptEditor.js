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

  const loadWords = useCallback((words) => {
    const items = buildItems(words);
    if (!items.length) return { items, wordCount: 0 };
    dispatch({ type: "loadItems", items });
    return { items, wordCount: countWords(items) };
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
