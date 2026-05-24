import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyPanel } from "./components/CopyPanel";
import { ProjectBrowser } from "./components/ProjectBrowser";
import { Timeline } from "./components/Timeline";
import { Topbar } from "./components/Topbar";
import { TranscriptPane } from "./components/TranscriptPane";
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
import { countWords, nextKeptTime, SKIP_EPSILON } from "./editorModel";
import {
  applySequenceTranscriptCut,
  buildSequencePlaybackEntries,
  buildSequenceRenderClips,
  buildSequenceTranscriptItems,
  getClipDurations,
  getClipTimeline,
  getClipTrimRange,
  getFirstReadyPlaybackEntry,
  getNextReadyPlaybackEntry,
  getSequenceDurations,
  getSequencePlainText,
  getSequenceTranscriptCut,
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
  hydrateProjectDocument,
  projectDocumentSignature,
  serializeProjectDocument,
} from "./projectModel";

const RENDER_URL = "/api/render";
const REFERENCES_URL = "/api/references";
const AUDIO_PREVIEW_URL = "/api/audio-preview";

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

function revokeObjectUrls(clips) {
  for (const clip of clips || []) {
    if (isObjectURL(clip?.videoUrl)) {
      URL.revokeObjectURL(clip.videoUrl);
    }
  }
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
  const [activeClipId, setActiveClipId] = useState(null);
  const [videoTime, setVideoTime] = useState(0);
  const [sequenceTime, setSequenceTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyState, setCopyState] = useState("idle");
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [renderStatus, setRenderStatus] = useState("idle");
  const [renderError, setRenderError] = useState("");
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
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(false);
  const [projectSaveState, setProjectSaveState] = useState("loading");
  const [projectError, setProjectError] = useState("");

  const editor = useTranscriptEditor();

  const videoRef = useRef(null);
  const previewAudioRef = useRef(null);
  const fileInputRef = useRef(null);
  const draggingRef = useRef(false);
  const activeChipRef = useRef(null);
  const transcriptRef = useRef(null);
  const autoPlayNextRef = useRef(false);
  const transcribingRef = useRef(false);
  const selectedModelRef = useRef(selectedModel);
  const clipsRef = useRef(clips);
  const currentProjectRef = useRef(currentProject);
  const projectBootstrappedRef = useRef(false);
  const lastSavedProjectSignatureRef = useRef("");
  const saveProjectTimerRef = useRef(null);
  const splitActionRef = useRef(null);
  const pendingMediaSeekRef = useRef(null);
  const scrubbingRef = useRef(false);
  const resumeAfterScrubRef = useRef(false);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

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
    cut,
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
    cutSelected,
    restoreSelected,
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
  const baseTranscriptCut = useMemo(
    () => getSequenceTranscriptCut(clips, baseTranscriptItems),
    [baseTranscriptItems, clips]
  );
  const sequenceClips = useMemo(
    () => applySequenceTranscriptCut(clips, items, cut),
    [clips, cut, items]
  );
  const activeClip = useMemo(
    () => sequenceClips.find((clip) => clip.id === activeClipId) || null,
    [activeClipId, sequenceClips]
  );
  const activeTimeline = useMemo(
    () => (activeClip?.status === "ready" ? getClipTimeline(activeClip) : []),
    [activeClip]
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
  const playbackEntries = useMemo(
    () => buildSequencePlaybackEntries(sequenceClips),
    [sequenceClips]
  );
  const nextReadyClip = useMemo(() => {
    const entry = getNextReadyPlaybackEntry(sequenceClips, activeClipId);
    return entry?.clip || null;
  }, [activeClipId, sequenceClips]);

  const isRendering = renderStatus === "rendering";
  const hasSequenceTranscript = items.length > 0;
  const hasActiveTranscript = activeTranscriptItems.length > 0;
  const hasReadyClips = clips.some((clip) => clip.status === "ready");
  const isAnyTranscribing = Boolean(transcribingClip) || queuedCount > 0 || probingCount > 0;

  const status = (() => {
    if (isRendering) return "rendering";
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
    if (status === "rendering" || status === "transcribing") return "busy";
    if (hasReadyClips || isAnyTranscribing) return "ready";
    return "idle";
  })();

  const activeError = activeClip?.error || renderError || "";
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
    selectedModel,
  ]);

  const resetProjectRuntimeState = useCallback(() => {
    videoRef.current?.pause();
    previewAudioRef.current?.pause();
    pendingMediaSeekRef.current = null;
    autoPlayNextRef.current = false;
    draggingRef.current = false;
    scrubbingRef.current = false;
    resumeAfterScrubRef.current = false;
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
        await saveCurrentProjectNow().catch(() => {});
        setProjectSaveState("loading");
        setProjectError("");

        const response = await fetch(`${EDIT_PROJECTS_URL}/${projectId}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to open project.");

        const hydrated = hydrateProjectDocument(payload.project);
        revokeObjectUrls(clipsRef.current);
        resetProjectRuntimeState();
        setCurrentProject(hydrated.project);
        setClips(hydrated.clips);
        setActiveClipId(hydrated.activeClipId);
        setSelectedModel(hydrated.selectedModel || selectedModelRef.current);
        setAudioProcessing(hydrated.audioProcessing);
        writeLastProjectId(hydrated.project.id);
        setProjectSummaries((summaries) =>
          upsertProjectSummary(summaries, payload.summary || hydrated.project)
        );
        lastSavedProjectSignatureRef.current = projectDocumentSignature(
          serializeProjectDocument({
            project: hydrated.project,
            clips: hydrated.clips,
            activeClipId: hydrated.activeClipId,
            selectedModel: hydrated.selectedModel || selectedModelRef.current,
            audioProcessing: hydrated.audioProcessing,
          })
        );
        projectBootstrappedRef.current = true;
        setProjectSaveState("saved");
        setProjectError("");
        if (options.closeBrowser !== false) setProjectBrowserOpen(false);
      } catch (caught) {
        projectBootstrappedRef.current = true;
        setProjectSaveState("error");
        setProjectError(caught instanceof Error ? caught.message : String(caught));
        throw caught;
      }
    },
    [resetProjectRuntimeState, saveCurrentProjectNow]
  );

  const createNewEditProject = useCallback(
    async (options = {}) => {
      try {
        await saveCurrentProjectNow().catch(() => {});
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
        resetProjectRuntimeState();
        setCurrentProject(hydrated.project);
        setClips([]);
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
        if (options.closeBrowser !== false) setProjectBrowserOpen(false);
      } catch (caught) {
        projectBootstrappedRef.current = true;
        setProjectSaveState("error");
        setProjectError(caught instanceof Error ? caught.message : String(caught));
        throw caught;
      }
    },
    [resetProjectRuntimeState, saveCurrentProjectNow]
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

  const setActiveTranscriptForSourceTime = useCallback(
    (clipId, sourceTime) => {
      if (!clipId) {
        setActiveId(null);
        return;
      }
      let found = null;
      for (const item of items) {
        if (item.clipId !== clipId) continue;
        if (cut.has(item.id)) continue;
        if (sourceTime >= item.start - SKIP_EPSILON && sourceTime < item.end - SKIP_EPSILON) {
          found = item;
          break;
        }
        if (item.clipId === clipId && item.start > sourceTime) break;
      }
      setActiveId(found ? found.id : null);
    },
    [cut, items, setActiveId]
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
    setClips((curr) =>
      curr.map((clip) => (clip.id === next.id ? { ...clip, status: "transcribing" } : clip))
    );

    (async () => {
      try {
        const payload = await runTranscriptionRequest(next._pending || {}, selectedModelRef.current);
        setClips((curr) => {
          const idx = curr.findIndex((clip) => clip.id === next.id);
          if (idx < 0) return curr;
          const updated = applyTranscriptToClip(curr[idx], payload);
          const result = [...curr];
          result[idx] = updated;
          return result;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
        if (!cancelled && payload?.model) {
          setSelectedModel((current) => {
            if (current !== DEFAULT_MODEL || clipsRef.current.length > 0) return current;
            return payload.model;
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

        await createNewEditProject({ closeBrowser: false });
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
    };
  }, []);

  // Debounced autosave for project sequence edits, model choice, audio settings, and project name.
  useEffect(() => {
    if (!projectBootstrappedRef.current || !currentProjectDocument?.id) return undefined;

    const signature = projectDocumentSignature(currentProjectDocument);
    if (signature === lastSavedProjectSignatureRef.current) return undefined;

    if (saveProjectTimerRef.current) window.clearTimeout(saveProjectTimerRef.current);
    setProjectSaveState("saving");
    setProjectError("");

    const controller = new AbortController();
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
    }, 700);

    return () => {
      controller.abort();
      if (saveProjectTimerRef.current) window.clearTimeout(saveProjectTimerRef.current);
    };
  }, [currentProjectDocument]);

  // Sync the transcript editor with the full visible sequence.
  useEffect(() => {
    if (!baseTranscriptItems.length) {
      resetEditor();
      return;
    }
    syncPreparedItems(baseTranscriptItems, baseTranscriptCut);
  }, [baseTranscriptCut, baseTranscriptItems, resetEditor, syncPreparedItems]);

  // Push sequence transcript cut edits back into their owning clips.
  useEffect(() => {
    if (!items.length) return;
    setClips((current) => applySequenceTranscriptCut(current, items, cut));
  }, [cut, items]);

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

  // Playback skip-over-cuts + auto-advance to next clip.
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
      if (!video.paused && activeTimeline.length) {
        const target = nextKeptTime(activeTimeline, t);
        if (target === Number.POSITIVE_INFINITY) {
          if (!advanceToNextClip()) video.pause();
          return;
        }
        if (target !== null) {
          video.currentTime = target;
          setVideoTime(target);
          setSequenceTime(sourceTimeToSequenceTime(sequenceClips, activeClipId, target));
          syncPreviewAudio(0);
          return;
        }
      }

      let found = null;
      for (const it of activeTranscriptItems) {
        if (cut.has(it.id)) continue;
        if (t >= it.start - SKIP_EPSILON && t < it.end - SKIP_EPSILON) {
          found = it;
          break;
        }
        if (it.start > t) break;
      }

      const nextActiveId = found ? found.id : activeId && cut.has(activeId) ? null : activeId;
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
    activeTimeline,
    activeTrim,
    activeClip,
    activeTranscriptItems,
    advanceToNextClip,
    cut,
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

      if (event.key === "Escape") {
        if (copyOpen) setCopyOpen(false);
        else clearSelection();
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        if (!selection.size) return;
        event.preventDefault();
        if (selectionStats.activeCount > 0) cutSelected();
        else restoreSelected();
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
    selectionStats,
    cutSelected,
    restoreSelected,
    clearSelection,
    copyOpen,
    activeClip,
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
      setClips((curr) => [...curr, ...newClips]);
      setActiveClipId((prev) => prev || newClips[0].id);

      for (const clip of newClips) {
        readVideoDurationFromUrl(clip.videoUrl).then((duration) => {
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
    setClips((curr) => [...curr, clip]);
    setActiveClipId((prev) => prev || clip.id);
  }, []);

  const retryClip = useCallback((clipId) => {
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

  const renderAndDownload = useCallback(async () => {
    if (!renderClips.length || isRendering) return;
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
      const url = URL.createObjectURL(blob);
      const firstClip = sequenceClips[0];
      const sourceName = firstClip?.fileName || "sequence.mp4";
      const stem =
        sequenceClips.length > 1 ? "local-editor-sequence" : sourceName.replace(/\.[^.]+$/, "");
      const a = document.createElement("a");
      a.href = url;
      a.download = `${stem}.edit.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setRenderStatus("idle");
    } catch (caught) {
      setRenderStatus("error");
      setRenderError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [audioProcessing, isRendering, renderClips, sequenceClips]);

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
    setClips((current) => moveClipBefore(current, srcId, targetId, side));
  }, []);

  const removeClip = useCallback(
    (clipId) => {
      setClips((current) => {
        const target = current.find((clip) => clip.id === clipId);
        if (target && isObjectURL(target.videoUrl)) {
          URL.revokeObjectURL(target.videoUrl);
        }
        return current.filter((clip) => clip.id !== clipId);
      });
      setActiveClipId((prev) => {
        if (prev !== clipId) return prev;
        const remaining = clips.filter((clip) => clip.id !== clipId);
        const idx = clips.findIndex((clip) => clip.id === clipId);
        return remaining[Math.min(idx, remaining.length - 1)]?.id || null;
      });
    },
    [clips]
  );

  const setClipTrim = useCallback((clipId, patch) => {
    setClips((curr) =>
      applySequenceTranscriptCut(curr, items, cut).map((clip) =>
        clip.id === clipId
          ? {
              ...clip,
              trimStart: patch.trimStart !== undefined ? patch.trimStart : clip.trimStart,
              trimEnd: patch.trimEnd !== undefined ? patch.trimEnd : clip.trimEnd,
            }
          : clip
      )
    );
  }, [cut, items]);

  const splitActiveClipAtPlayhead = useCallback(() => {
    if (!activeClip || activeClip.status !== "ready") return;
    const video = videoRef.current;
    if (!video) return;
    const time = video.currentTime;
    setClips((curr) => {
      const flushed = applySequenceTranscriptCut(curr, items, cut);
      return splitClip(flushed, activeClip.id, time, () => makeClipId("split"));
    });
  }, [activeClip, cut, items]);

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

  const openProjectBrowser = useCallback(() => {
    setProjectBrowserOpen(true);
    refreshProjectSummaries().catch((caught) => {
      setProjectSaveState("error");
      setProjectError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [refreshProjectSummaries]);

  return (
    <main className="app">
      <Topbar
        fileInputRef={fileInputRef}
        status={status}
        statusText={statusText}
        statusTone={statusTone}
        projectName={currentProject?.name || DEFAULT_PROJECT_NAME}
        projectSaveState={projectSaveState}
        projectError={projectError}
        hasTranscript={hasReadyClips}
        durations={sequenceDurations}
        sourceDuration={sequenceSourceDuration}
        isBusy={isRendering}
        canRender={renderClips.length > 0 && !isRendering}
        modelOptions={modelOptions}
        selectedModel={selectedModel}
        audioProcessing={audioProcessing}
        onProjectNameChange={renameCurrentProject}
        onNewProject={() => createNewEditProject().catch(() => {})}
        onOpenProjectBrowser={openProjectBrowser}
        onFilesSelected={addClipsFromFiles}
        onChooseVideo={openFilePicker}
        onModelChange={setSelectedModel}
        onAudioProcessingChange={setAudioProcessing}
        onOpenCopy={() => setCopyOpen(true)}
        onRenderAndDownload={renderAndDownload}
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
          cut={cut}
          durations={activeDurations}
          error={activeError}
          onChooseVideo={openFilePicker}
          onTogglePlayback={togglePlayback}
        />

        <TranscriptPane
          hasTranscript={hasSequenceTranscript}
          status={status}
          statusText={statusText}
          transcriptRef={transcriptRef}
          items={items}
          cut={cut}
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
          onCut={cutSelected}
          onRestore={restoreSelected}
          onClear={clearSelection}
        />
      </section>

      <Timeline
        clips={sequenceClips}
        activeClipId={activeClipId}
        videoTime={videoTime}
        sequenceTime={sequenceTime}
        isPlaying={isPlaying}
        onChooseVideo={openFilePicker}
        onFilesSelected={addClipsFromFiles}
        onReferencePath={addReferencePath}
        onSelectClip={selectClip}
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

      <ProjectBrowser
        open={projectBrowserOpen}
        projects={projectSummaries}
        currentProjectId={currentProject?.id}
        loading={projectSaveState === "loading"}
        error={projectError}
        onClose={() => setProjectBrowserOpen(false)}
        onOpenProject={loadEditProject}
        onNewProject={() => createNewEditProject()}
        onRefresh={() => refreshProjectSummaries().catch(() => {})}
      />
    </main>
  );
}
