import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyPanel } from "./components/CopyPanel";
import { ExportModal } from "./components/ExportModal";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { SettingsModal } from "./components/SettingsModal";
import { Timeline } from "./components/Timeline";
import { Topbar } from "./components/Topbar";
import { TranscriptPane } from "./components/TranscriptPane";
import {
  AI_EDIT_URL,
  OPENROUTER_SETTINGS_URL,
  applyAiEditPlanToClips,
  buildAiEditRequestClips,
} from "./aiEditModel";
import { VideoPane } from "./components/VideoPane";
import {
  DEFAULT_MODEL,
  MODEL_OPTIONS,
  applyTranscriptToClip,
  buildClipFromTranscript,
  buildSourceReference,
  isObjectURL,
  makeClipId,
  makeReferencedClip,
  makeUploadClip,
  readVideoDurationFromUrl,
  runTranscriptionRequest,
} from "./clipModel";
import { countWords, SKIP_EPSILON } from "./editorModel";
import {
  buildSequencePlaybackEntries,
  buildSequenceRenderClips,
  buildSequenceTranscriptItems,
  deleteSequenceTranscriptSelection,
  extendSelectedClipEdges,
  getClipDurations,
  getClipTrimRange,
  getFirstReadyPlaybackEntry,
  getNextReadyPlaybackEntry,
  getSequenceDurations,
  getSequencePlainText,
  getSelectedClipEdgeExtensionState,
  isSequencePlaybackComplete,
  moveClipBefore,
  sequenceTimeToSourceTime,
  splitClip,
  sourceTimeToSequenceTime,
} from "./sequenceModel";
import { useTranscriptionProgress } from "./transcriptionProgress";
import { useTranscriptEditor } from "./useTranscriptEditor";
import {
  DEFAULT_PROJECT_NAME,
  EDIT_PROJECTS_URL,
  LAST_PROJECT_STORAGE_KEY,
  normalizeAudioProcessing,
  hydrateProjectDocument,
  projectDocumentSignature,
  serializeProjectDocument,
} from "./projectModel";

const RENDER_URL = "/api/render";
const REFERENCES_URL = "/api/references";
const AUDIO_PREVIEW_URL = "/api/audio-preview";
const UNDO_LIMIT = 50;
const DEFAULT_TRANSCRIPTION_MODEL_STORAGE_KEY = "local-editor:default-transcription-model";
const DEFAULT_EXPORT_FILE_NAME = "tidycut-export.mp4";

function normalizeExportFileName(fileName, fallback = DEFAULT_EXPORT_FILE_NAME) {
  const cleanName = String(fileName || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  const nextName = cleanName || fallback;
  return /\.mp4$/i.test(nextName) ? nextName : `${nextName}.mp4`;
}

function buildDefaultExportFileName(sequenceClips = []) {
  const firstClip = sequenceClips[0];
  const sourceName = firstClip?.fileName || "sequence.mp4";
  const sourceStem = sourceName.replace(/\.[^.]+$/, "") || "sequence";
  const stem = sequenceClips.length > 1 ? "tidycut-sequence" : sourceStem;
  return normalizeExportFileName(`${stem}.edit.mp4`);
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function writeBlobToFileHandle(fileHandle, blob) {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
}

function readLastProjectId() {
  try {
    return window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastProjectId(projectId) {
  if (!projectId) return;
  try {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
  } catch {
    // localStorage can be unavailable in locked-down browser contexts.
  }
}

function readDefaultTranscriptionModel() {
  try {
    const model = window.localStorage.getItem(DEFAULT_TRANSCRIPTION_MODEL_STORAGE_KEY);
    return typeof model === "string" && model.trim() ? model.trim() : null;
  } catch {
    return null;
  }
}

function writeDefaultTranscriptionModel(model) {
  if (!model) return;
  try {
    window.localStorage.setItem(DEFAULT_TRANSCRIPTION_MODEL_STORAGE_KEY, model);
  } catch {
    // localStorage can be unavailable in locked-down browser contexts.
  }
}

function revokeObjectUrls(clips) {
  for (const clip of clips || []) {
    if (isObjectURL(clip?.videoUrl)) {
      URL.revokeObjectURL(clip.videoUrl);
    }
  }
}

function cloneClipForUndo(clip) {
  return {
    ...clip,
    source: clip?.source && typeof clip.source === "object" ? { ...clip.source } : clip?.source,
    items: Array.isArray(clip?.items) ? clip.items.map((item) => ({ ...item })) : [],
  };
}

function cloneClipsForUndo(clips) {
  return Array.isArray(clips) ? clips.map(cloneClipForUndo) : [];
}

function normalizeMediaSourceClip(clip) {
  if (!clip?.id) return null;
  const mediaSourceId = clip.mediaSourceId || clip.id;
  return {
    ...cloneClipForUndo(clip),
    id: mediaSourceId,
    mediaSourceId,
    trimStart: 0,
    trimEnd: null,
    aiEdit: undefined,
  };
}

function mediaSourceSignature(source) {
  return JSON.stringify({
    id: source?.id || null,
    mediaSourceId: source?.mediaSourceId || null,
    projectId: source?.projectId || null,
    videoPath: source?.videoPath || null,
    videoUrl: source?.videoUrl || null,
    fileName: source?.fileName || null,
    status: source?.status || null,
    error: source?.error || null,
    duration: source?.duration || 0,
    wordCount: source?.wordCount || 0,
    items: (source?.items || []).map((item) => [item.id, item.start, item.end, item.kind, item.text]),
  });
}

function sameMediaSources(a, b) {
  const left = Array.isArray(a) ? a.map(mediaSourceSignature) : [];
  const right = Array.isArray(b) ? b.map(mediaSourceSignature) : [];
  return JSON.stringify(left) === JSON.stringify(right);
}

function upsertMediaSource(sources, clip) {
  const source = normalizeMediaSourceClip(clip);
  if (!source) return sources;

  const next = Array.isArray(sources) ? [...sources] : [];
  const index = next.findIndex(
    (candidate) =>
      candidate.id === source.id ||
      (source.projectId && candidate.projectId === source.projectId) ||
      (source.videoPath && candidate.videoPath === source.videoPath)
  );
  if (index >= 0) {
    next[index] = source;
  } else {
    next.push(source);
  }
  return sameMediaSources(sources, next) ? sources : next;
}

function makeTimelineCopyFromSource(source, id) {
  const mediaSourceId = source.mediaSourceId || source.id;
  return {
    ...cloneClipForUndo(source),
    id,
    mediaSourceId,
    trimStart: 0,
    trimEnd: null,
    aiEdit: undefined,
  };
}

function collectObjectUrls(clips) {
  return new Set((clips || []).map((clip) => clip?.videoUrl).filter(isObjectURL));
}

function undoSnapshotSignature(snapshot) {
  return JSON.stringify({
    activeClipId: snapshot.activeClipId || null,
    clips: snapshot.clips.map((clip) => ({
      id: clip.id,
      trimStart: clip.trimStart ?? null,
      trimEnd: clip.trimEnd ?? null,
      items: clip.items.map((item) => [item.id, item.start, item.end, item.kind, item.text]),
    })),
  });
}

function sameClipEditState(a, b) {
  return (
    undoSnapshotSignature({ activeClipId: null, clips: a }) ===
    undoSnapshotSignature({ activeClipId: null, clips: b })
  );
}

function isUndoShortcut(event) {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "z"
  );
}

function upsertProjectSummary(summaries, summary) {
  if (!summary?.id) return summaries;
  const next = summaries.filter((project) => project.id !== summary.id);
  next.unshift(summary);
  next.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  return next;
}

export default function App() {
  const [clips, setClips] = useState([]);
  const [mediaSources, setMediaSources] = useState([]);
  const [activeClipId, setActiveClipId] = useState(null);
  const [videoTime, setVideoTime] = useState(0);
  const [sequenceTime, setSequenceTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyState, setCopyState] = useState("idle");
  const [selectedModel, setSelectedModel] = useState(
    () => readDefaultTranscriptionModel() || DEFAULT_MODEL
  );
  const [renderStatus, setRenderStatus] = useState("idle");
  const [renderError, setRenderError] = useState("");
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [aiEditStatus, setAiEditStatus] = useState("idle");
  const [aiEditError, setAiEditError] = useState("");
  const [aiEditNotice, setAiEditNotice] = useState("");
  const [aiEditModel, setAiEditModel] = useState("anthropic/claude-opus-4.6");
  const [openRouterSettings, setOpenRouterSettings] = useState({
    configured: false,
    model: "anthropic/claude-opus-4.6",
    keySource: "none",
  });
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsState, setSettingsState] = useState("idle");
  const [settingsError, setSettingsError] = useState("");
  const [audioProcessing, setAudioProcessing] = useState({
    denoise: false,
    normalize: false,
    loudnessTarget: -16,
    truePeak: -1.5,
    lra: 11,
  });
  const [audioPreview, setAudioPreview] = useState({
    status: "idle",
    progress: 0,
    message: "",
    error: "",
    url: "",
  });
  const [currentProject, setCurrentProject] = useState(null);
  const [projectSummaries, setProjectSummaries] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [projectSaveState, setProjectSaveState] = useState("loading");
  const [projectError, setProjectError] = useState("");

  const editor = useTranscriptEditor();

  const videoRef = useRef(null);
  const previewAudioRef = useRef(null);
  const fileInputRef = useRef(null);
  const projectNameInputRef = useRef(null);
  const draggingRef = useRef(false);
  const activeChipRef = useRef(null);
  const transcriptRef = useRef(null);
  const autoPlayNextRef = useRef(false);
  const transcribingRef = useRef(false);
  const selectedModelRef = useRef(selectedModel);
  const clipsRef = useRef(clips);
  const mediaSourcesRef = useRef(mediaSources);
  const currentProjectRef = useRef(currentProject);
  const projectBootstrappedRef = useRef(false);
  const lastSavedProjectSignatureRef = useRef("");
  const saveProjectTimerRef = useRef(null);
  const saveProjectControllerRef = useRef(null);
  const splitActionRef = useRef(null);
  const pendingMediaSeekRef = useRef(null);
  const scrubbingRef = useRef(false);
  const resumeAfterScrubRef = useRef(false);
  const undoStackRef = useRef([]);
  const retainedObjectUrlsRef = useRef(new Set());
  const runAiEditAfterKeySaveRef = useRef(false);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  useEffect(() => {
    mediaSourcesRef.current = mediaSources;
  }, [mediaSources]);

  useEffect(() => {
    currentProjectRef.current = currentProject;
  }, [currentProject]);

  const modelOptions = useMemo(() => {
    if (MODEL_OPTIONS.some((option) => option.value === selectedModel)) return MODEL_OPTIONS;
    return [
      {
        value: selectedModel,
        label: selectedModel,
        size: "custom",
        pro: "Environment override",
        con: "Not benchmarked here",
      },
      ...MODEL_OPTIONS,
    ];
  }, [selectedModel]);

  const {
    items,
    selection,
    activeId,
    durations,
    selectionStats,
    syncPreparedItems,
    resetEditor,
    selectSingle,
    extendSelection,
    toggleInSelection,
    clearSelection,
    setActiveId,
  } = editor;

  const transcribingClip = useMemo(
    () => clips.find((clip) => clip.status === "transcribing") || null,
    [clips]
  );
  const queuedCount = useMemo(
    () => clips.filter((clip) => clip.status === "queued").length,
    [clips]
  );
  const probingCount = useMemo(
    () => clips.filter((clip) => clip.status === "probing").length,
    [clips]
  );

  const baseTranscriptItems = useMemo(() => buildSequenceTranscriptItems(clips), [clips]);
  const sequenceClips = clips;
  const activeClip = useMemo(
    () => sequenceClips.find((clip) => clip.id === activeClipId) || null,
    [activeClipId, sequenceClips]
  );
  const activeDurations = useMemo(
    () => (activeClip?.status === "ready" ? getClipDurations(activeClip) : durations),
    [activeClip, durations]
  );
  const activeTrim = useMemo(
    () => (activeClip ? getClipTrimRange(activeClip) : { start: 0, end: 0 }),
    [activeClip]
  );
  const activeTranscriptItems = useMemo(
    () => items.filter((item) => item.clipId === activeClipId),
    [activeClipId, items]
  );
  const sequenceDurations = useMemo(() => getSequenceDurations(sequenceClips), [sequenceClips]);
  const sequenceSourceDuration = useMemo(
    () =>
      sequenceClips.reduce((total, clip) => {
        const range = getClipTrimRange(clip);
        return total + Math.max(0, range.end - range.start);
      }, 0),
    [sequenceClips]
  );
  const sequencePlainText = useMemo(
    () => getSequencePlainText(sequenceClips),
    [sequenceClips]
  );
  const renderClips = useMemo(
    () => buildSequenceRenderClips(sequenceClips),
    [sequenceClips]
  );
  const defaultExportFileName = useMemo(
    () => buildDefaultExportFileName(sequenceClips),
    [sequenceClips]
  );
  const canChooseExportDestination =
    typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
  const playbackEntries = useMemo(
    () => buildSequencePlaybackEntries(sequenceClips),
    [sequenceClips]
  );
  const nextReadyClip = useMemo(() => {
    const entry = getNextReadyPlaybackEntry(sequenceClips, activeClipId);
    return entry?.clip || null;
  }, [activeClipId, sequenceClips]);
  const clipEdgeExtensionState = useMemo(
    () => getSelectedClipEdgeExtensionState(sequenceClips, items, selection, 0.1),
    [items, selection, sequenceClips]
  );

  const isRendering = renderStatus === "rendering";
  const isAiEditing = aiEditStatus === "planning";
  const hasSequenceTranscript = items.length > 0;
  const hasActiveTranscript = activeTranscriptItems.length > 0;
  const hasReadyClips = clips.some((clip) => clip.status === "ready");
  const isAnyTranscribing = Boolean(transcribingClip) || queuedCount > 0 || probingCount > 0;

  const status = (() => {
    if (isRendering) return "rendering";
    if (isAiEditing) return "ai-editing";
    if (aiEditStatus === "error") return "error";
    if (
      activeClip?.status === "probing" ||
      activeClip?.status === "transcribing" ||
      activeClip?.status === "queued"
    ) {
      return "transcribing";
    }
    if (renderStatus === "error") return "error";
    if (activeClip?.status === "error") return "error";
    if (!clips.length) return "idle";
    return "done";
  })();

  const statusText = (() => {
    if (renderStatus === "rendering") {
      return clips.length > 1 ? "Rendering sequence…" : "Rendering…";
    }
    if (isAiEditing) return `Planning edit with ${aiEditModel}…`;
    if (aiEditStatus === "error") return "AI edit failed.";
    if (aiEditNotice) return aiEditNotice;
    if (renderStatus === "error") return "Render failed.";
    if (activeClip?.status === "error") return "Transcription failed.";
    if (activeClip?.status === "probing") return `Reading ${activeClip.fileName} length…`;
    if (activeClip?.status === "transcribing") return `Transcribing ${activeClip.fileName}…`;
    if (activeClip?.status === "queued") return `${activeClip.fileName} queued`;
    if (transcribingClip) return `Transcribing ${transcribingClip.fileName}…`;
    if (queuedCount > 0) return `${queuedCount} clip${queuedCount === 1 ? "" : "s"} queued`;
    if (probingCount > 0) {
      return `Reading ${probingCount} clip${probingCount === 1 ? "" : "s"} length…`;
    }
    if (hasSequenceTranscript) return `${countWords(items)} words in sequence.`;
    if (activeClip) return `${activeClip.wordCount || 0} words selected.`;
    return "Drop a video to begin.";
  })();

  const statusTone = (() => {
    if (status === "error") return "error";
    if (status === "rendering" || status === "transcribing" || status === "ai-editing") {
      return "busy";
    }
    if (hasReadyClips || isAnyTranscribing) return "ready";
    return "idle";
  })();

  const activeError = activeClip?.error || renderError || aiEditError || "";
  const activeVideoUrl = activeClip?.videoUrl || "";
  const activeStatus = activeClip?.status || "idle";
  const activeDuration = activeClip?.duration || 0;
  const needsAudioPreview = Boolean(audioProcessing.denoise || audioProcessing.normalize);
  const usePreviewAudio = needsAudioPreview && audioPreview.status === "ready" && Boolean(audioPreview.url);
  const nextVideoUrl =
    nextReadyClip && nextReadyClip.videoUrl !== activeVideoUrl ? nextReadyClip.videoUrl : "";

  const transcriptionProgress = useTranscriptionProgress(
    activeStatus === "transcribing" ? "transcribing" : "idle",
    activeDuration,
    selectedModel
  );

  const currentProjectDocument = useMemo(() => {
    if (!currentProject) return null;
    return serializeProjectDocument({
      project: currentProject,
      clips,
      mediaSources,
      activeClipId,
      selectedModel,
      audioProcessing,
    });
  }, [
    activeClipId,
    audioProcessing,
    clips,
    currentProject?.createdAt,
    currentProject?.id,
    currentProject?.name,
    mediaSources,
    selectedModel,
  ]);

  const pushUndoSnapshot = useCallback(() => {
    if (!projectBootstrappedRef.current) return;
    const snapshot = {
      clips: cloneClipsForUndo(sequenceClips),
      activeClipId,
    };
    const signature = undoSnapshotSignature(snapshot);
    const last = undoStackRef.current.at(-1);
    if (last?.signature === signature) return;
    undoStackRef.current.push({ ...snapshot, signature });
    if (undoStackRef.current.length > UNDO_LIMIT) {
      undoStackRef.current.shift();
    }
  }, [activeClipId, sequenceClips]);

  const resetProjectRuntimeState = useCallback(() => {
    videoRef.current?.pause();
    previewAudioRef.current?.pause();
    pendingMediaSeekRef.current = null;
    autoPlayNextRef.current = false;
    draggingRef.current = false;
    scrubbingRef.current = false;
    resumeAfterScrubRef.current = false;
    undoStackRef.current = [];
    for (const url of retainedObjectUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    retainedObjectUrlsRef.current.clear();
    setVideoTime(0);
    setSequenceTime(0);
    setIsPlaying(false);
    setCopyOpen(false);
    setCopyState("idle");
    setRenderStatus("idle");
    setRenderError("");
    setAudioPreview({ status: "idle", progress: 0, message: "", error: "", url: "" });
  }, []);

  const saveProjectDocument = useCallback(async (document, options = {}) => {
    if (!document?.id) return null;
    if (!options.silent) {
      setProjectSaveState("saving");
      setProjectError("");
    }

    const response = await fetch(`${EDIT_PROJECTS_URL}/${document.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(document),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Failed to save project.");

    const savedProject = payload.project || document;
    const savedSummary = payload.summary || savedProject;
    lastSavedProjectSignatureRef.current = projectDocumentSignature(document);
    setCurrentProject((project) =>
      project?.id === savedProject.id
        ? {
            ...project,
            name: savedProject.name || project.name,
            createdAt: savedProject.createdAt || project.createdAt,
            updatedAt: savedProject.updatedAt || project.updatedAt,
          }
        : project
    );
    setProjectSummaries((summaries) => upsertProjectSummary(summaries, savedSummary));
    setProjectSaveState("saved");
    setProjectError("");
    return savedProject;
  }, []);

  const saveCurrentProjectNow = useCallback(async () => {
    const document = currentProjectDocument;
    if (!document?.id) return null;
    const signature = projectDocumentSignature(document);
    if (signature === lastSavedProjectSignatureRef.current) return null;
    return saveProjectDocument(document, { silent: true });
  }, [currentProjectDocument, saveProjectDocument]);

  const refreshProjectSummaries = useCallback(async () => {
    const response = await fetch(EDIT_PROJECTS_URL);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Failed to load projects.");
    const summaries = Array.isArray(payload.projects) ? payload.projects : [];
    setProjectSummaries(summaries);
    return summaries;
  }, []);

  const loadEditProject = useCallback(
    async (projectId, options = {}) => {
      if (!projectId) return;
      try {
        if (options.skipSavePrevious !== true) {
          await saveCurrentProjectNow().catch(() => {});
        }
        setProjectSaveState("loading");
        setProjectError("");

        const response = await fetch(`${EDIT_PROJECTS_URL}/${projectId}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to open project.");

        const hydrated = hydrateProjectDocument(payload.project);
        revokeObjectUrls(clipsRef.current);
        revokeObjectUrls(mediaSourcesRef.current);
        resetProjectRuntimeState();
        setCurrentProject(hydrated.project);
        setClips(hydrated.clips);
        setMediaSources(hydrated.mediaSources || []);
        setActiveClipId(hydrated.activeClipId);
        setSelectedModel(
          readDefaultTranscriptionModel() || hydrated.selectedModel || selectedModelRef.current
        );
        setAudioProcessing(hydrated.audioProcessing);
        writeLastProjectId(hydrated.project.id);
        setProjectSummaries((summaries) =>
          upsertProjectSummary(summaries, payload.summary || hydrated.project)
        );
        lastSavedProjectSignatureRef.current = projectDocumentSignature(
          serializeProjectDocument({
            project: hydrated.project,
            clips: hydrated.clips,
            mediaSources: hydrated.mediaSources || [],
            activeClipId: hydrated.activeClipId,
            selectedModel:
              readDefaultTranscriptionModel() || hydrated.selectedModel || selectedModelRef.current,
            audioProcessing: hydrated.audioProcessing,
          })
        );
        projectBootstrappedRef.current = true;
        setProjectSaveState("saved");
        setProjectError("");
        if (options.closeBrowser !== false) setSidebarOpen(false);
      } catch (caught) {
        projectBootstrappedRef.current = true;
        setProjectSaveState("error");
        setProjectError(caught instanceof Error ? caught.message : String(caught));
        throw caught;
      }
    },
    [resetProjectRuntimeState, saveCurrentProjectNow]
  );

  const focusProjectName = useCallback(() => {
    requestAnimationFrame(() => {
      const input = projectNameInputRef.current;
      if (!input) return;
      input.focus();
      try {
        input.select();
      } catch {
        // Older browsers may reject select() on certain input types.
      }
    });
  }, []);

  const createNewEditProject = useCallback(
    async (options = {}) => {
      try {
        if (options.skipSavePrevious !== true) {
          await saveCurrentProjectNow().catch(() => {});
        }
        setProjectSaveState("loading");
        setProjectError("");

        const response = await fetch(EDIT_PROJECTS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: options.name || DEFAULT_PROJECT_NAME,
            selectedModel: selectedModelRef.current,
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to create project.");

        const hydrated = hydrateProjectDocument(payload.project);
        revokeObjectUrls(clipsRef.current);
        revokeObjectUrls(mediaSourcesRef.current);
        resetProjectRuntimeState();
        setCurrentProject(hydrated.project);
        setClips([]);
        setMediaSources([]);
        setActiveClipId(null);
        setAudioProcessing({
          denoise: false,
          normalize: false,
          loudnessTarget: -16,
          truePeak: -1.5,
          lra: 11,
        });
        writeLastProjectId(hydrated.project.id);
        setProjectSummaries((summaries) =>
          upsertProjectSummary(summaries, payload.summary || hydrated.project)
        );
        lastSavedProjectSignatureRef.current = projectDocumentSignature(
          serializeProjectDocument({
            project: hydrated.project,
            clips: [],
            mediaSources: [],
            activeClipId: null,
            selectedModel: selectedModelRef.current,
            audioProcessing: {
              denoise: false,
              normalize: false,
              loudnessTarget: -16,
              truePeak: -1.5,
              lra: 11,
            },
          })
        );
        projectBootstrappedRef.current = true;
        setProjectSaveState("saved");
        setProjectError("");
        if (options.closeBrowser !== false) setSidebarOpen(false);
        if (options.focusName !== false) focusProjectName();
      } catch (caught) {
        projectBootstrappedRef.current = true;
        setProjectSaveState("error");
        setProjectError(caught instanceof Error ? caught.message : String(caught));
        throw caught;
      }
    },
    [focusProjectName, resetProjectRuntimeState, saveCurrentProjectNow]
  );

  const deleteEditProject = useCallback(
    async (projectId) => {
      if (!projectId) return;
      const wasCurrent = currentProjectRef.current?.id === projectId;
      if (wasCurrent) {
        if (saveProjectTimerRef.current) {
          window.clearTimeout(saveProjectTimerRef.current);
          saveProjectTimerRef.current = null;
        }
        saveProjectControllerRef.current?.abort();
        saveProjectControllerRef.current = null;
      }
      const response = await fetch(`${EDIT_PROJECTS_URL}/${projectId}`, { method: "DELETE" });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const message = payload?.error || `Failed to delete project (${response.status}).`;
        setProjectError(message);
        throw new Error(message);
      }

      setProjectError("");
      let nextSummaries = [];
      setProjectSummaries((summaries) => {
        nextSummaries = summaries.filter((project) => project.id !== projectId);
        return nextSummaries;
      });

      if (wasCurrent) {
        const fallback = nextSummaries.find((project) => project.id !== projectId);
        lastSavedProjectSignatureRef.current = "";
        if (fallback?.id) {
          await loadEditProject(fallback.id, {
            closeBrowser: false,
            skipSavePrevious: true,
          });
        } else {
          await createNewEditProject({
            closeBrowser: false,
            focusName: false,
            skipSavePrevious: true,
          });
        }
      }
    },
    [createNewEditProject, loadEditProject]
  );

  const syncPreviewAudio = useCallback(
    (tolerance = 0.08) => {
      if (!usePreviewAudio) return;
      const video = videoRef.current;
      const audio = previewAudioRef.current;
      if (!video || !audio) return;

      const apply = () => {
        const target = video.currentTime || 0;
        if (Number.isFinite(target) && Math.abs((audio.currentTime || 0) - target) > tolerance) {
          audio.currentTime = Math.max(0, target);
        }
        audio.playbackRate = video.playbackRate || 1;
      };

      if (audio.readyState >= 1) {
        apply();
      } else {
        audio.addEventListener("loadedmetadata", apply, { once: true });
      }
    },
    [usePreviewAudio]
  );

  const playCurrentMedia = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }

    if (usePreviewAudio) {
      syncPreviewAudio(0);
      const audio = previewAudioRef.current;
      const audioPromise = audio?.play?.();
      if (audioPromise && typeof audioPromise.catch === "function") {
        audioPromise.catch(() => {});
      }
    }
  }, [syncPreviewAudio, usePreviewAudio]);

  const pauseCurrentMedia = useCallback(() => {
    videoRef.current?.pause();
    previewAudioRef.current?.pause();
  }, []);

  const undoLastEdit = useCallback(() => {
    const snapshot = undoStackRef.current.pop();
    if (!snapshot) return false;

    pauseCurrentMedia();
    pendingMediaSeekRef.current = null;
    draggingRef.current = false;
    clearSelection();
    setRenderStatus("idle");
    setRenderError("");

    setClips((current) => {
      const next = cloneClipsForUndo(snapshot.clips);
      const nextUrls = collectObjectUrls(next);
      for (const url of collectObjectUrls(current)) {
        if (!nextUrls.has(url)) {
          URL.revokeObjectURL(url);
          retainedObjectUrlsRef.current.delete(url);
        }
      }
      for (const url of nextUrls) {
        retainedObjectUrlsRef.current.delete(url);
      }
      return next;
    });
    setActiveClipId(snapshot.activeClipId || snapshot.clips[0]?.id || null);
    return true;
  }, [clearSelection, pauseCurrentMedia]);

  const setActiveTranscriptForSourceTime = useCallback(
    (clipId, sourceTime) => {
      if (!clipId) {
        setActiveId(null);
        return;
      }
      let found = null;
      for (const item of items) {
        if (item.clipId !== clipId) continue;
        if (sourceTime >= item.start - SKIP_EPSILON && sourceTime < item.end - SKIP_EPSILON) {
          found = item;
          break;
        }
        if (item.clipId === clipId && item.start > sourceTime) break;
      }
      setActiveId(found ? found.id : null);
    },
    [items, setActiveId]
  );

  const restartSequencePlayback = useCallback(() => {
    const entry = getFirstReadyPlaybackEntry(sequenceClips);
    if (!entry) return false;

    const targetClip = entry.clip;
    const sourceTime = entry.sourceStart;
    const sameMedia = targetClip?.videoUrl && targetClip.videoUrl === activeVideoUrl;
    const video = videoRef.current;

    setSequenceTime(entry.sequenceStart);
    setVideoTime(sourceTime);
    setActiveTranscriptForSourceTime(entry.clipId, sourceTime);

    if (activeClipId !== entry.clipId) {
      setActiveClipId(entry.clipId);
    }

    if (video && (activeClipId === entry.clipId || sameMedia)) {
      pendingMediaSeekRef.current = null;
      video.currentTime = sourceTime;
      syncPreviewAudio(0);
      playCurrentMedia();
      return true;
    }

    pendingMediaSeekRef.current = {
      clipId: entry.clipId,
      sourceTime,
      playAfter: true,
    };
    return true;
  }, [
    activeClipId,
    activeVideoUrl,
    playCurrentMedia,
    sequenceClips,
    setActiveTranscriptForSourceTime,
    syncPreviewAudio,
  ]);

  const playFromTimelineIntent = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (
      isSequencePlaybackComplete(sequenceClips, activeClipId, video.currentTime, sequenceTime) &&
      restartSequencePlayback()
    ) {
      return;
    }
    playCurrentMedia();
  }, [activeClipId, playCurrentMedia, restartSequencePlayback, sequenceClips, sequenceTime]);

  useEffect(() => {
    if (!needsAudioPreview) {
      setAudioPreview({ status: "idle", progress: 0, message: "", error: "", url: "" });
      return undefined;
    }
    if (!activeClip?.projectId) {
      setAudioPreview({
        status: "waiting",
        progress: 0,
        message: "Audio preview will start after this clip is in a project.",
        error: "",
        url: "",
      });
      return undefined;
    }

    let cancelled = false;
    let pollTimer = null;
    let jobId = null;
    const controller = new AbortController();

    const applyPayload = (payload) => {
      if (cancelled) return;
      setAudioPreview({
        status: payload.status || "processing",
        progress: Number(payload.progress) || 0,
        message: payload.message || "Preparing audio preview",
        error: payload.error || "",
        url: payload.url || "",
      });
    };

    const poll = async () => {
      if (!jobId || cancelled) return;
      try {
        const response = await fetch(`${AUDIO_PREVIEW_URL}/${jobId}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Audio preview failed.");
        applyPayload(payload);
        if (payload.status === "ready" || payload.status === "error" || payload.status === "canceled") {
          return;
        }
        pollTimer = window.setTimeout(poll, 900);
      } catch (caught) {
        if (cancelled) return;
        setAudioPreview({
          status: "error",
          progress: 0,
          message: "Audio preview failed",
          error: caught instanceof Error ? caught.message : String(caught),
          url: "",
        });
      }
    };

    setAudioPreview({
      status: "processing",
      progress: 0.03,
      message: "Preparing audio preview",
      error: "",
      url: "",
    });

    fetch(AUDIO_PREVIEW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: activeClip.projectId,
        audioProcessing,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Audio preview failed.");
        jobId = payload.jobId || null;
        applyPayload(payload);
        if (
          jobId &&
          payload.status !== "ready" &&
          payload.status !== "error" &&
          payload.status !== "canceled"
        ) {
          pollTimer = window.setTimeout(poll, 900);
        }
      })
      .catch((caught) => {
        if (cancelled || caught?.name === "AbortError") return;
        setAudioPreview({
          status: "error",
          progress: 0,
          message: "Audio preview failed",
          error: caught instanceof Error ? caught.message : String(caught),
          url: "",
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (pollTimer) window.clearTimeout(pollTimer);
      if (jobId) {
        fetch(`${AUDIO_PREVIEW_URL}/${jobId}`, { method: "DELETE" }).catch(() => {});
      }
    };
  }, [
    activeClip?.projectId,
    audioProcessing,
    needsAudioPreview,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = previewAudioRef.current;
    if (!audio) return;
    if (!usePreviewAudio) {
      audio.pause();
      if (video) video.muted = false;
      return;
    }
    if (video) {
      video.muted = true;
      syncPreviewAudio(0);
      if (!video.paused) {
        const promise = audio.play();
        if (promise && typeof promise.catch === "function") promise.catch(() => {});
      }
    }
  }, [audioPreview.url, syncPreviewAudio, usePreviewAudio]);

  useEffect(() => {
    const pending = pendingMediaSeekRef.current;
    const video = videoRef.current;
    if (!pending || pending.clipId !== activeClipId || !video || !activeVideoUrl) return undefined;

    const expectedSrc = new URL(activeVideoUrl, window.location.href).href;
    const applyPendingSeek = () => {
      if (pendingMediaSeekRef.current !== pending) return;
      if (video.currentSrc && video.currentSrc !== expectedSrc) return;
      video.currentTime = pending.sourceTime;
      setVideoTime(pending.sourceTime);
      setSequenceTime(sourceTimeToSequenceTime(sequenceClips, pending.clipId, pending.sourceTime));
      setActiveTranscriptForSourceTime(pending.clipId, pending.sourceTime);
      pendingMediaSeekRef.current = null;
      syncPreviewAudio(0);
      if (pending.playAfter) playCurrentMedia();
    };

    if (video.currentSrc === expectedSrc && video.readyState >= 1) {
      applyPendingSeek();
      return undefined;
    }

    video.addEventListener("loadedmetadata", applyPendingSeek);
    return () => video.removeEventListener("loadedmetadata", applyPendingSeek);
  }, [
    activeClipId,
    activeVideoUrl,
    playCurrentMedia,
    sequenceClips,
    setActiveTranscriptForSourceTime,
    syncPreviewAudio,
  ]);

  useEffect(() => {
    if (!activeClipId) {
      setSequenceTime(0);
      return;
    }
    setSequenceTime(sourceTimeToSequenceTime(sequenceClips, activeClipId, videoTime));
  }, [activeClipId, sequenceClips, videoTime]);

  useEffect(() => {
    if (!needsAudioPreview || !nextReadyClip?.projectId) return;
    fetch(AUDIO_PREVIEW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: nextReadyClip.projectId,
        audioProcessing,
      }),
    }).catch(() => {});
  }, [audioProcessing, needsAudioPreview, nextReadyClip?.projectId]);

  // Queue runner — picks the next queued clip and transcribes it.
  useEffect(() => {
    if (transcribingRef.current) return;
    const next = clips.find((clip) => clip.status === "queued");
    if (!next) return;

    transcribingRef.current = true;
    setMediaSources((curr) => upsertMediaSource(curr, { ...next, status: "transcribing" }));
    setClips((curr) =>
      curr.map((clip) => (clip.id === next.id ? { ...clip, status: "transcribing" } : clip))
    );

    (async () => {
      try {
        const payload = await runTranscriptionRequest(next._pending || {}, selectedModelRef.current);
        let updatedClip = null;
        setClips((curr) => {
          const idx = curr.findIndex((clip) => clip.id === next.id);
          if (idx < 0) return curr;
          const updated = applyTranscriptToClip(curr[idx], payload);
          updatedClip = updated;
          const result = [...curr];
          result[idx] = updated;
          return result;
        });
        if (updatedClip) {
          setMediaSources((curr) => upsertMediaSource(curr, updatedClip));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMediaSources((curr) =>
          upsertMediaSource(curr, { ...next, status: "error", error: message })
        );
        setClips((curr) =>
          curr.map((clip) =>
            clip.id === next.id ? { ...clip, status: "error", error: message } : clip
          )
        );
      } finally {
        transcribingRef.current = false;
      }
    })();
  }, [clips]);

  // Health probe — pick up the server's default model if available.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!cancelled && payload?.model && !readDefaultTranscriptionModel()) {
          setSelectedModel((current) => {
            if (current !== DEFAULT_MODEL || clipsRef.current.length > 0) return current;
            return payload.model;
          });
        }
        if (!cancelled && payload?.aiEdit?.model) {
          setAiEditModel(payload.aiEdit.model);
          setOpenRouterSettings({
            configured: Boolean(payload.aiEdit.available),
            model: payload.aiEdit.model,
            keySource: payload.aiEdit.keySource || "none",
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the last edit project on startup. If none exists, create a blank one.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setProjectSaveState("loading");
        const summaries = await refreshProjectSummaries();
        if (cancelled) return;

        const lastProjectId = readLastProjectId();
        const projectToLoad =
          summaries.find((project) => project.id === lastProjectId) || summaries[0] || null;

        if (projectToLoad?.id) {
          await loadEditProject(projectToLoad.id, { closeBrowser: false });
          return;
        }

        await createNewEditProject({ closeBrowser: false, focusName: false });
      } catch (caught) {
        if (cancelled) return;
        projectBootstrappedRef.current = true;
        setProjectSaveState("error");
        setProjectError(caught instanceof Error ? caught.message : String(caught));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (saveProjectTimerRef.current) window.clearTimeout(saveProjectTimerRef.current);
      revokeObjectUrls(clipsRef.current);
      revokeObjectUrls(mediaSourcesRef.current);
      for (const url of retainedObjectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      retainedObjectUrlsRef.current.clear();
    };
  }, []);

  // Debounced autosave for project sequence edits, model choice, audio settings, and project name.
  // Snappier debounce so transcription output is durable before users can close the tab.
  useEffect(() => {
    if (!projectBootstrappedRef.current || !currentProjectDocument?.id) return undefined;

    const signature = projectDocumentSignature(currentProjectDocument);
    if (signature === lastSavedProjectSignatureRef.current) return undefined;

    if (saveProjectTimerRef.current) window.clearTimeout(saveProjectTimerRef.current);
    setProjectSaveState("saving");
    setProjectError("");

    const controller = new AbortController();
    saveProjectControllerRef.current = controller;
    saveProjectTimerRef.current = window.setTimeout(() => {
      fetch(`${EDIT_PROJECTS_URL}/${currentProjectDocument.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentProjectDocument),
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Failed to save project.");
          lastSavedProjectSignatureRef.current = signature;
          const savedProject = payload.project || currentProjectDocument;
          const savedSummary = payload.summary || savedProject;
          setCurrentProject((project) =>
            project?.id === savedProject.id
              ? {
                  ...project,
                  name: savedProject.name || project.name,
                  createdAt: savedProject.createdAt || project.createdAt,
                  updatedAt: savedProject.updatedAt || project.updatedAt,
                }
              : project
          );
          setProjectSummaries((summaries) => upsertProjectSummary(summaries, savedSummary));
          setProjectSaveState("saved");
          setProjectError("");
        })
        .catch((caught) => {
          if (caught?.name === "AbortError") return;
          setProjectSaveState("error");
          setProjectError(caught instanceof Error ? caught.message : String(caught));
        });
    }, 300);

    return () => {
      controller.abort();
      if (saveProjectTimerRef.current) window.clearTimeout(saveProjectTimerRef.current);
    };
  }, [currentProjectDocument]);

  // Best-effort flush on tab close / hide so freshly transcribed work isn't lost
  // during the autosave debounce window.
  useEffect(() => {
    const flush = () => {
      const pendingDocument = currentProjectDocument;
      if (!pendingDocument?.id) return;
      const signature = projectDocumentSignature(pendingDocument);
      if (signature === lastSavedProjectSignatureRef.current) return;
      try {
        fetch(`${EDIT_PROJECTS_URL}/${pendingDocument.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pendingDocument),
          keepalive: true,
        });
        lastSavedProjectSignatureRef.current = signature;
      } catch {
        // Best-effort only — browser may have already torn the connection.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [currentProjectDocument]);

  // Sync the transcript editor with the full visible sequence.
  useEffect(() => {
    if (!baseTranscriptItems.length) {
      resetEditor();
      return;
    }
    syncPreparedItems(baseTranscriptItems);
  }, [baseTranscriptItems, resetEditor, syncPreparedItems]);

  // Track video play state + current time for the timeline playhead.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf;
    const tick = () => {
      if (scrubbingRef.current) return;
      const sourceTime = video.currentTime;
      setVideoTime(sourceTime);
      setSequenceTime(sourceTimeToSequenceTime(sequenceClips, activeClipId, sourceTime));
      syncPreviewAudio(0.12);
      raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setIsPlaying(true);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
      if (usePreviewAudio) {
        syncPreviewAudio(0);
        const audioPromise = previewAudioRef.current?.play?.();
        if (audioPromise && typeof audioPromise.catch === "function") {
          audioPromise.catch(() => {});
        }
      }
    };
    const onPause = () => {
      if (scrubbingRef.current) {
        cancelAnimationFrame(raf);
        previewAudioRef.current?.pause();
        return;
      }
      setIsPlaying(false);
      cancelAnimationFrame(raf);
      const sourceTime = video.currentTime;
      setVideoTime(sourceTime);
      setSequenceTime(sourceTimeToSequenceTime(sequenceClips, activeClipId, sourceTime));
      previewAudioRef.current?.pause();
    };
    const onSeek = () => {
      if (scrubbingRef.current) return;
      const sourceTime = video.currentTime;
      setVideoTime(sourceTime);
      setSequenceTime(sourceTimeToSequenceTime(sequenceClips, activeClipId, sourceTime));
      syncPreviewAudio(0);
    };
    const onRateChange = () => syncPreviewAudio(0.12);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onSeek);
    video.addEventListener("seeked", onSeek);
    video.addEventListener("timeupdate", onSeek);
    video.addEventListener("ratechange", onRateChange);
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeking", onSeek);
      video.removeEventListener("seeked", onSeek);
      video.removeEventListener("timeupdate", onSeek);
      video.removeEventListener("ratechange", onRateChange);
    };
  }, [activeClipId, sequenceClips, syncPreviewAudio, usePreviewAudio]);

  const advanceToNextClip = useCallback(() => {
    if (!activeClipId) return false;
    const currentIndex = playbackEntries.findIndex((entry) => entry.clipId === activeClipId);
    for (let i = currentIndex + 1; i < playbackEntries.length; i++) {
      const entry = playbackEntries[i];
      if (!entry.ready) continue;
      autoPlayNextRef.current = true;
      setActiveClipId(entry.clipId);
      setVideoTime(entry.sourceStart);
      setSequenceTime(entry.sequenceStart);
      return true;
    }
    return false;
  }, [activeClipId, playbackEntries]);

  // Playback bounds + auto-advance to next clip.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeTranscriptItems.length || activeClip?.status !== "ready") return;
    let raf;

    const onTime = () => {
      if (scrubbingRef.current) return;
      const t = video.currentTime;
      if (activeTrim.end > activeTrim.start && t < activeTrim.start - SKIP_EPSILON) {
        video.currentTime = activeTrim.start;
        setVideoTime(activeTrim.start);
        setSequenceTime(sourceTimeToSequenceTime(sequenceClips, activeClipId, activeTrim.start));
        syncPreviewAudio(0);
        return;
      }
      if (activeTrim.end > activeTrim.start && t >= activeTrim.end - SKIP_EPSILON) {
        if (!advanceToNextClip()) video.pause();
        return;
      }
      let found = null;
      for (const it of activeTranscriptItems) {
        if (t >= it.start - SKIP_EPSILON && t < it.end - SKIP_EPSILON) {
          found = it;
          break;
        }
        if (it.start > t) break;
      }

      const nextActiveId = found ? found.id : activeId;
      if (nextActiveId !== activeId) setActiveId(nextActiveId);
    };

    const onEnded = () => {
      if (!advanceToNextClip()) {
        setIsPlaying(false);
        previewAudioRef.current?.pause();
      }
    };
    const tick = () => {
      onTime();
      if (!video.paused) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };

    if (!video.paused) raf = requestAnimationFrame(tick);
    video.addEventListener("play", onPlay);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("ended", onEnded);
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("ended", onEnded);
    };
  }, [
    activeId,
    activeClipId,
    activeTrim,
    activeClip,
    activeTranscriptItems,
    advanceToNextClip,
    sequenceClips,
    setActiveId,
    syncPreviewAudio,
  ]);

  // Auto-play the newly-active clip when we just advanced.
  useEffect(() => {
    if (!autoPlayNextRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    const start = () => {
      const sourceTime = activeTrim.start || 0;
      video.currentTime = sourceTime;
      setVideoTime(sourceTime);
      setSequenceTime(sourceTimeToSequenceTime(sequenceClips, activeClipId, sourceTime));
      playCurrentMedia();
      autoPlayNextRef.current = false;
    };
    if (video.readyState >= 1) {
      start();
      return;
    }
    video.addEventListener("loadedmetadata", start, { once: true });
    return () => video.removeEventListener("loadedmetadata", start);
  }, [activeClipId, activeTrim.start, playCurrentMedia, sequenceClips]);

  useEffect(() => {
    if (!isPlaying) return;
    if (!activeChipRef.current) return;
    activeChipRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId, isPlaying]);

  const deleteSelected = useCallback(() => {
    if (!selection.size) return;
    const next = deleteSequenceTranscriptSelection(sequenceClips, items, selection, () =>
      makeClipId("delete")
    );
    if (next === sequenceClips || sameClipEditState(sequenceClips, next)) return;

    pushUndoSnapshot();
    clearSelection();
    pendingMediaSeekRef.current = null;
    setClips(next);

    if (!activeClipId || next.some((clip) => clip.id === activeClipId)) return;
    const deletedIndex = sequenceClips.findIndex((clip) => clip.id === activeClipId);
    setActiveClipId(next[Math.min(Math.max(deletedIndex, 0), next.length - 1)]?.id || null);
  }, [
    activeClipId,
    clearSelection,
    items,
    pushUndoSnapshot,
    selection,
    selection.size,
    sequenceClips,
  ]);

  const expandSelectionLeft = useCallback(() => {
    if (!selection.size || !clipEdgeExtensionState.canExtendLeft) return;
    const next = extendSelectedClipEdges(sequenceClips, items, selection, "left", 0.1);
    if (next === sequenceClips || sameClipEditState(sequenceClips, next)) return;
    pushUndoSnapshot();
    setClips(next);
  }, [clipEdgeExtensionState.canExtendLeft, items, pushUndoSnapshot, selection, sequenceClips]);

  const expandSelectionRight = useCallback(() => {
    if (!selection.size || !clipEdgeExtensionState.canExtendRight) return;
    const next = extendSelectedClipEdges(sequenceClips, items, selection, "right", 0.1);
    if (next === sequenceClips || sameClipEditState(sequenceClips, next)) return;
    pushUndoSnapshot();
    setClips(next);
  }, [clipEdgeExtensionState.canExtendRight, items, pushUndoSnapshot, selection, sequenceClips]);

  useEffect(() => {
    const onKey = (event) => {
      const target = event.target;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      if (isUndoShortcut(event)) {
        event.preventDefault();
        undoLastEdit();
        return;
      }

      if (event.key === "Escape") {
        if (copyOpen) setCopyOpen(false);
        else clearSelection();
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        if (!selection.size) return;
        event.preventDefault();
        deleteSelected();
        return;
      }

      if ((event.key === "s" || event.key === "S") && videoRef.current && activeClip?.status === "ready") {
        if (event.metaKey || event.ctrlKey) return; // leave system save shortcut alone
        event.preventDefault();
        splitActionRef.current?.();
        return;
      }

      if (event.key === " " && videoRef.current) {
        event.preventDefault();
        if (videoRef.current.paused) playFromTimelineIntent();
        else pauseCurrentMedia();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    selection,
    deleteSelected,
    clearSelection,
    copyOpen,
    activeClip,
    undoLastEdit,
    pauseCurrentMedia,
    playFromTimelineIntent,
  ]);

  useEffect(() => {
    const stop = () => {
      draggingRef.current = false;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const addClipsFromFiles = useCallback(
    (files) => {
      if (!files?.length) return;
      const newClips = files.map((file) => makeUploadClip(file));
      setMediaSources((curr) => newClips.reduce(upsertMediaSource, curr));
      setClips((curr) => [...curr, ...newClips]);
      setActiveClipId((prev) => prev || newClips[0].id);

      for (const clip of newClips) {
        readVideoDurationFromUrl(clip.videoUrl).then((duration) => {
          const withDuration = {
            ...clip,
            duration: clip.duration || duration,
            status: clip.status === "probing" ? "queued" : clip.status,
          };
          setMediaSources((curr) => upsertMediaSource(curr, withDuration));
          setClips((curr) =>
            curr.map((current) =>
              current.id === clip.id
                ? {
                    ...current,
                    duration: current.duration || duration,
                    status: current.status === "probing" ? "queued" : current.status,
                  }
                : current
            )
          );
        });
      }
    },
    []
  );

  const addReferencePath = useCallback(async (sourcePath) => {
    setRenderError("");
    const response = await fetch(REFERENCES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sourcePath }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Failed to reference media.");

    const reference = buildSourceReference({
      projectId: payload.projectId,
      projectDir: payload.projectDir,
      videoPath: payload.videoPath,
      source: payload.source,
    });
    const clip = makeReferencedClip(reference);
    setMediaSources((curr) => upsertMediaSource(curr, clip));
    setClips((curr) => [...curr, clip]);
    setActiveClipId((prev) => prev || clip.id);
  }, []);

  const retryClip = useCallback((clipId) => {
    const target = clipsRef.current.find((clip) => clip.id === clipId);
    if (target?.status === "error" && target._pending) {
      setMediaSources((curr) => upsertMediaSource(curr, { ...target, status: "queued", error: null }));
    }
    setClips((curr) =>
      curr.map((clip) =>
        clip.id === clipId && clip.status === "error" && clip._pending
          ? { ...clip, status: "queued", error: null }
          : clip
      )
    );
  }, []);

  const seekTo = useCallback(
    (item) => {
      if (!item?.clipId) return;
      const targetClip = sequenceClips.find((clip) => clip.id === item.clipId);
      const sameMedia = targetClip?.videoUrl && targetClip.videoUrl === activeVideoUrl;
      const video = videoRef.current;
      if (activeClipId !== item.clipId) setActiveClipId(item.clipId);
      const sourceTime = Math.max(0, item.start);
      setVideoTime(sourceTime);
      setSequenceTime(sourceTimeToSequenceTime(sequenceClips, item.clipId, sourceTime));
      setActiveId(item.id);
      if (video && (activeClipId === item.clipId || sameMedia)) {
        pendingMediaSeekRef.current = null;
        video.currentTime = sourceTime;
        syncPreviewAudio(0);
        return;
      }
      pendingMediaSeekRef.current = {
        clipId: item.clipId,
        sourceTime,
        playAfter: false,
      };
    },
    [activeClipId, activeVideoUrl, sequenceClips, setActiveId, syncPreviewAudio]
  );

  const onTokenPointerDown = useCallback(
    (event, item) => {
      if (event.button !== 0) return;
      event.preventDefault();

      if (event.shiftKey) {
        extendSelection(item.id);
      } else if (event.metaKey || event.ctrlKey) {
        toggleInSelection(item.id);
      } else {
        selectSingle(item.id);
        seekTo(item);
        draggingRef.current = true;
      }
    },
    [extendSelection, selectSingle, seekTo, toggleInSelection]
  );

  const onTokenPointerEnter = useCallback(
    (item) => {
      if (!draggingRef.current) return;
      extendSelection(item.id);
      seekTo(item);
    },
    [extendSelection, seekTo]
  );

  const togglePlayback = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) playFromTimelineIntent();
    else pauseCurrentMedia();
  }, [pauseCurrentMedia, playFromTimelineIntent]);

  const renderAndDownload = useCallback(async (requestedFileName) => {
    if (!renderClips.length || isRendering) return;
    const fileName = normalizeExportFileName(requestedFileName, defaultExportFileName);
    let fileHandle = null;

    if (typeof window.showSaveFilePicker === "function") {
      try {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [
            {
              description: "MP4 video",
              accept: { "video/mp4": [".mp4"] },
            },
          ],
        });
      } catch (caught) {
        if (caught?.name === "AbortError") return;
        setRenderStatus("error");
        setRenderError(caught instanceof Error ? caught.message : String(caught));
        return;
      }
    }

    setRenderStatus("rendering");
    setRenderError("");
    try {
      const response = await fetch(RENDER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clips: renderClips, audioProcessing }),
      });
      if (!response.ok) {
        let message = `Render failed (${response.status}).`;
        try {
          const payload = await response.json();
          if (payload?.error) message = payload.error;
        } catch {}
        throw new Error(message);
      }

      const blob = await response.blob();
      if (fileHandle) {
        await writeBlobToFileHandle(fileHandle, blob);
      } else {
        downloadBlob(blob, fileName);
      }
      setRenderStatus("idle");
      setExportModalOpen(false);
    } catch (caught) {
      setRenderStatus("error");
      setRenderError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [audioProcessing, defaultExportFileName, isRendering, renderClips]);

  const openExportModal = useCallback(() => {
    if (!renderClips.length || isRendering) return;
    setRenderError("");
    if (renderStatus === "error") setRenderStatus("idle");
    setExportModalOpen(true);
  }, [isRendering, renderClips.length, renderStatus]);

  const closeExportModal = useCallback(() => {
    if (isRendering) return;
    setExportModalOpen(false);
  }, [isRendering]);

  const runAiEdit = useCallback(async (options = {}) => {
    if (isAiEditing || isAnyTranscribing || !hasReadyClips) return;

    if (!options.skipKeyCheck && !openRouterSettings.configured) {
      runAiEditAfterKeySaveRef.current = true;
      setSettingsError("");
      setSettingsState("idle");
      setSettingsModalOpen(true);
      return;
    }

    const requestClips = buildAiEditRequestClips(sequenceClips);
    if (!requestClips.length) {
      setAiEditStatus("error");
      setAiEditError("AI edit needs a ready clip with word-level transcript timestamps.");
      return;
    }

    pauseCurrentMedia();
    setAiEditStatus("planning");
    setAiEditError("");
    setAiEditNotice("");
    setRenderStatus("idle");
    setRenderError("");

    try {
      const response = await fetch(AI_EDIT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "coherence_story_v1",
          instructions:
            "Make a conservative first-pass edit for coherence and storytelling. Treat each selected range as a complete video scene.",
          clips: requestClips,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (payload?.code === "OPENROUTER_API_KEY_MISSING") {
          runAiEditAfterKeySaveRef.current = true;
          setSettingsError("");
          setSettingsState("idle");
          setSettingsModalOpen(true);
          setAiEditStatus("idle");
          return;
        }
        throw new Error(payload.error || "AI edit failed.");
      }

      const result = applyAiEditPlanToClips(sequenceClips, payload.plan, () => makeClipId("ai"));
      if (!result.clips.length) {
        throw new Error("AI returned no usable scene ranges.");
      }

      pushUndoSnapshot();
      clearSelection();
      pendingMediaSeekRef.current = {
        clipId: result.clips[0].id,
        sourceTime: result.clips[0].trimStart || 0,
        playAfter: false,
      };
      setClips(result.clips);
      setActiveClipId(result.clips[0].id);
      setVideoTime(result.clips[0].trimStart || 0);
      setSequenceTime(0);
      setAiEditStatus("idle");
      setAiEditNotice(
        `AI edit applied: ${result.clips.length} scene${result.clips.length === 1 ? "" : "s"}.`
      );
    } catch (caught) {
      setAiEditStatus("error");
      setAiEditError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [
    clearSelection,
    openRouterSettings.configured,
    hasReadyClips,
    isAiEditing,
    isAnyTranscribing,
    pauseCurrentMedia,
    pushUndoSnapshot,
    sequenceClips,
  ]);

  const closeSettingsModal = useCallback(() => {
    if (settingsState === "saving") return;
    runAiEditAfterKeySaveRef.current = false;
    setSettingsModalOpen(false);
    setSettingsError("");
  }, [settingsState]);

  const toggleAudioProcessing = useCallback((key) => {
    setAudioProcessing((current) =>
      normalizeAudioProcessing({
        ...current,
        [key]: !Boolean(current?.[key]),
      })
    );
  }, []);

  const saveSettings = useCallback(
    async ({ selectedModel: nextModel, audioProcessing: nextAudioProcessing, apiKey }) => {
      const cleanedModel = String(nextModel || selectedModelRef.current || DEFAULT_MODEL).trim();
      const cleanedAudioProcessing =
        nextAudioProcessing === undefined
          ? normalizeAudioProcessing(audioProcessing)
          : normalizeAudioProcessing(nextAudioProcessing);
      const trimmedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";

      if (runAiEditAfterKeySaveRef.current && !openRouterSettings.configured && !trimmedApiKey) {
        setSettingsState("error");
        setSettingsError("Enter your OpenRouter API key to use AI edit.");
        return;
      }

      setSettingsState("saving");
      setSettingsError("");
      setSelectedModel(cleanedModel);
      selectedModelRef.current = cleanedModel;
      writeDefaultTranscriptionModel(cleanedModel);
      setAudioProcessing(cleanedAudioProcessing);

      try {
        let savedKey = false;
        if (trimmedApiKey) {
          const response = await fetch(OPENROUTER_SETTINGS_URL, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: trimmedApiKey }),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Failed to save OpenRouter key.");

          const nextSettings = {
            configured: Boolean(payload.configured),
            model: payload.model || aiEditModel,
            keySource: payload.keySource || "local",
          };
          setOpenRouterSettings(nextSettings);
          if (nextSettings.model) setAiEditModel(nextSettings.model);
          savedKey = true;
        }

        setSettingsState("idle");
        setSettingsModalOpen(false);
        setAiEditNotice(savedKey ? "Settings saved. OpenRouter key updated." : "Settings saved.");

        if (savedKey && runAiEditAfterKeySaveRef.current) {
          runAiEditAfterKeySaveRef.current = false;
          window.setTimeout(() => runAiEdit({ skipKeyCheck: true }), 0);
        } else {
          runAiEditAfterKeySaveRef.current = false;
        }
      } catch (caught) {
        setSettingsState("error");
        setSettingsError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [aiEditModel, audioProcessing, openRouterSettings.configured, runAiEdit]
  );

  const copyText = useCallback(async () => {
    if (!sequencePlainText) return;
    try {
      await navigator.clipboard.writeText(sequencePlainText);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 1800);
    }
  }, [sequencePlainText]);

  const selectClip = useCallback((clipId) => {
    const clip = sequenceClips.find((candidate) => candidate.id === clipId);
    const range = clip ? getClipTrimRange(clip) : { start: 0 };
    const sourceTime = range.start || 0;
    const sameMedia = clip?.videoUrl && clip.videoUrl === activeVideoUrl;
    const video = videoRef.current;
    setActiveClipId(clipId);
    setVideoTime(sourceTime);
    setSequenceTime(sourceTimeToSequenceTime(sequenceClips, clipId, sourceTime));
    setActiveTranscriptForSourceTime(clipId, sourceTime);
    if (video && (activeClipId === clipId || sameMedia)) {
      pendingMediaSeekRef.current = null;
      video.currentTime = sourceTime;
      syncPreviewAudio(0);
      return;
    }
    pendingMediaSeekRef.current = {
      clipId,
      sourceTime,
      playAfter: false,
    };
  }, [
    activeClipId,
    activeVideoUrl,
    sequenceClips,
    setActiveTranscriptForSourceTime,
    syncPreviewAudio,
  ]);

  const reorderClip = useCallback((srcId, targetId, side) => {
    const next = moveClipBefore(sequenceClips, srcId, targetId, side);
    if (next === sequenceClips || sameClipEditState(sequenceClips, next)) return;
    pushUndoSnapshot();
    setClips(next);
  }, [pushUndoSnapshot, sequenceClips]);

  const addClipCopy = useCallback(
    (sourceId, targetId = null, side = "after") => {
      const source = mediaSources.find((candidate) => candidate.id === sourceId);
      if (!source || source.status !== "ready") return;

      const copy = makeTimelineCopyFromSource(source, makeClipId("copy"));
      const next = [...sequenceClips];
      const targetIndex = targetId ? next.findIndex((clip) => clip.id === targetId) : -1;
      const insertIndex =
        targetIndex < 0 ? next.length : side === "before" ? targetIndex : targetIndex + 1;
      next.splice(insertIndex, 0, copy);

      pushUndoSnapshot();
      pendingMediaSeekRef.current = {
        clipId: copy.id,
        sourceTime: 0,
        playAfter: false,
      };
      setClips(next);
      setActiveClipId(copy.id);
      setVideoTime(0);
      setSequenceTime(sourceTimeToSequenceTime(next, copy.id, 0));
      setActiveTranscriptForSourceTime(copy.id, 0);
    },
    [mediaSources, pushUndoSnapshot, sequenceClips, setActiveTranscriptForSourceTime]
  );

  const removeClip = useCallback(
    (clipId) => {
      const target = sequenceClips.find((clip) => clip.id === clipId);
      if (!target) return;

      pushUndoSnapshot();
      if (isObjectURL(target.videoUrl)) {
        retainedObjectUrlsRef.current.add(target.videoUrl);
      }

      const remaining = sequenceClips.filter((clip) => clip.id !== clipId);
      setClips(remaining);
      if (activeClipId === clipId) {
        const idx = sequenceClips.findIndex((clip) => clip.id === clipId);
        setActiveClipId(remaining[Math.min(idx, remaining.length - 1)]?.id || null);
      }
    },
    [activeClipId, pushUndoSnapshot, sequenceClips]
  );

  const setClipTrim = useCallback((clipId, patch) => {
    const next = sequenceClips.map((clip) =>
      clip.id === clipId
        ? {
            ...clip,
            trimStart: patch.trimStart !== undefined ? patch.trimStart : clip.trimStart,
            trimEnd: patch.trimEnd !== undefined ? patch.trimEnd : clip.trimEnd,
          }
        : clip
    );
    if (sameClipEditState(sequenceClips, next)) return;
    pushUndoSnapshot();
    setClips(next);
  }, [pushUndoSnapshot, sequenceClips]);

  const splitActiveClipAtPlayhead = useCallback(() => {
    if (!activeClip || activeClip.status !== "ready") return;
    const video = videoRef.current;
    if (!video) return;
    const time = video.currentTime;
    const next = splitClip(sequenceClips, activeClip.id, time, () => makeClipId("split"));
    if (next === sequenceClips || sameClipEditState(sequenceClips, next)) return;
    pushUndoSnapshot();
    setClips(next);
  }, [activeClip, pushUndoSnapshot, sequenceClips]);

  useEffect(() => {
    splitActionRef.current = splitActiveClipAtPlayhead;
  }, [splitActiveClipAtPlayhead]);

  const seekToSequenceTime = useCallback(
    (targetSequenceTime, options = {}) => {
      const mapped = sequenceTimeToSourceTime(sequenceClips, targetSequenceTime);
      if (!mapped) return;

      const targetClip = mapped.entry.clip;
      const sourceTime = Math.max(0, mapped.sourceTime);
      const nextSequenceTime = sourceTimeToSequenceTime(sequenceClips, mapped.clipId, sourceTime);
      const sameMedia = targetClip?.videoUrl && targetClip.videoUrl === activeVideoUrl;
      const video = videoRef.current;

      setSequenceTime(nextSequenceTime);
      setVideoTime(sourceTime);
      setActiveTranscriptForSourceTime(mapped.clipId, sourceTime);

      if (activeClipId !== mapped.clipId) {
        setActiveClipId(mapped.clipId);
      }

      if (video && (activeClipId === mapped.clipId || sameMedia)) {
        pendingMediaSeekRef.current = null;
        video.currentTime = sourceTime;
        syncPreviewAudio(0);
        if (options.playAfter) playCurrentMedia();
        return;
      }

      pendingMediaSeekRef.current = {
        clipId: mapped.clipId,
        sourceTime,
        playAfter: Boolean(options.playAfter),
      };
    },
    [
      activeClipId,
      activeVideoUrl,
      playCurrentMedia,
      sequenceClips,
      setActiveTranscriptForSourceTime,
      syncPreviewAudio,
    ]
  );

  const beginSequenceScrub = useCallback(() => {
    resumeAfterScrubRef.current = Boolean(videoRef.current && !videoRef.current.paused);
    scrubbingRef.current = true;
    pauseCurrentMedia();
    setIsPlaying(false);
  }, [pauseCurrentMedia]);

  const endSequenceScrub = useCallback(() => {
    const shouldResume = resumeAfterScrubRef.current;
    resumeAfterScrubRef.current = false;
    scrubbingRef.current = false;
    if (!shouldResume) return;

    const pending = pendingMediaSeekRef.current;
    if (pending) {
      pending.playAfter = true;
      return;
    }
    playCurrentMedia();
  }, [playCurrentMedia]);

  const renameCurrentProject = useCallback((name) => {
    setCurrentProject((project) => (project ? { ...project, name } : project));
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      if (prev) return false;
      refreshProjectSummaries().catch((caught) => {
        setProjectSaveState("error");
        setProjectError(caught instanceof Error ? caught.message : String(caught));
      });
      return true;
    });
  }, [refreshProjectSummaries]);

  return (
    <main className="app">
      <Topbar
        fileInputRef={fileInputRef}
        projectNameInputRef={projectNameInputRef}
        status={status}
        projectName={currentProject?.name || DEFAULT_PROJECT_NAME}
        projectSaveState={projectSaveState}
        projectError={projectError}
        hasTranscript={hasReadyClips}
        isAiEditing={isAiEditing}
        canAiEdit={hasReadyClips && !isRendering && !isAiEditing && !isAnyTranscribing}
        canRender={renderClips.length > 0 && !isRendering && !isAiEditing}
        isBusy={isRendering || isAiEditing}
        audioProcessing={audioProcessing}
        audioProcessingDisabled={isAnyTranscribing}
        onProjectNameChange={renameCurrentProject}
        onToggleSidebar={toggleSidebar}
        onFilesSelected={addClipsFromFiles}
        onToggleAudioProcessing={toggleAudioProcessing}
        onOpenCopy={() => setCopyOpen(true)}
        onAutoEdit={() => runAiEdit()}
        onRenderAndDownload={openExportModal}
      />

      <section className="workspace">
        <VideoPane
          videoUrl={activeVideoUrl}
          videoRef={videoRef}
          nextVideoUrl={nextVideoUrl}
          audioRef={previewAudioRef}
          audioPreview={audioPreview}
          usePreviewAudio={usePreviewAudio}
          clipName={activeClip?.fileName || ""}
          projectMeta={
            activeClip
              ? {
                  projectId: activeClip.projectId,
                  projectDir: activeClip.projectDir,
                  videoPath: activeClip.videoPath,
                  model: activeClip.model,
                  source: activeClip.source,
                }
              : null
          }
          isPlaying={isPlaying}
          hasTranscript={hasActiveTranscript}
          sourceDuration={activeDuration}
          items={activeTranscriptItems}
          durations={activeDurations}
          error={activeError}
          mediaSources={mediaSources}
          onChooseVideo={openFilePicker}
          onReferencePath={addReferencePath}
          onAddClipCopy={addClipCopy}
          onTogglePlayback={togglePlayback}
        />

        <TranscriptPane
          hasTranscript={hasSequenceTranscript}
          status={status}
          statusText={statusText}
          transcriptRef={transcriptRef}
          items={items}
          selection={selection}
          activeId={activeId}
          activeChipRef={activeChipRef}
          selectionStats={selectionStats}
          transcriptionProgress={transcriptionProgress}
          onTokenPointerDown={onTokenPointerDown}
          onTokenPointerEnter={onTokenPointerEnter}
          onTranscriptPointerLeave={() => {
            draggingRef.current = false;
          }}
          onDelete={deleteSelected}
          canExtendLeft={clipEdgeExtensionState.canExtendLeft}
          canExtendRight={clipEdgeExtensionState.canExtendRight}
          onExpandLeft={expandSelectionLeft}
          onExpandRight={expandSelectionRight}
        />
      </section>

      <Timeline
        clips={sequenceClips}
        activeClipId={activeClipId}
        videoTime={videoTime}
        sequenceTime={sequenceTime}
        isPlaying={isPlaying}
        hasTranscript={hasReadyClips}
        durations={sequenceDurations}
        sourceDuration={sequenceSourceDuration}
        onChooseVideo={openFilePicker}
        onFilesSelected={addClipsFromFiles}
        onReferencePath={addReferencePath}
        onSelectClip={selectClip}
        onAddClipCopy={addClipCopy}
        onReorderClip={reorderClip}
        onRemoveClip={removeClip}
        onRetryClip={retryClip}
        onSetClipTrim={setClipTrim}
        onSplitActiveClip={splitActiveClipAtPlayhead}
        onSeekToSequenceTime={seekToSequenceTime}
        onScrubStart={beginSequenceScrub}
        onScrubEnd={endSequenceScrub}
      />

      {copyOpen ? (
        <CopyPanel
          text={sequencePlainText}
          state={copyState}
          onCopy={copyText}
          onClose={() => setCopyOpen(false)}
        />
      ) : null}

      <ExportModal
        open={exportModalOpen}
        state={renderStatus}
        error={renderError}
        defaultFileName={defaultExportFileName}
        canChooseDestination={canChooseExportDestination}
        onExport={renderAndDownload}
        onClose={closeExportModal}
      />

      <ProjectSidebar
        open={sidebarOpen}
        projects={projectSummaries}
        currentProjectId={currentProject?.id}
        loading={projectSaveState === "loading"}
        error={projectError}
        onClose={() => setSidebarOpen(false)}
        onOpenProject={loadEditProject}
        onNewProject={() => createNewEditProject()}
        onDeleteProject={deleteEditProject}
        onOpenSettings={() => {
          setSettingsError("");
          setSettingsState("idle");
          setSettingsModalOpen(true);
        }}
      />

      <SettingsModal
        open={settingsModalOpen}
        state={settingsState}
        error={settingsError}
        modelOptions={modelOptions}
        selectedModel={selectedModel}
        openRouterSettings={openRouterSettings}
        onSave={saveSettings}
        onClose={closeSettingsModal}
      />
    </main>
  );
}
