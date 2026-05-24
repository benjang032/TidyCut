import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyPanel } from "./components/CopyPanel";
import { Topbar } from "./components/Topbar";
import { TranscriptPane } from "./components/TranscriptPane";
import { VideoPane } from "./components/VideoPane";
import { nextKeptTime, SKIP_EPSILON } from "./editorModel";
import { useTranscriptionProgress } from "./transcriptionProgress";
import { useTranscriptEditor } from "./useTranscriptEditor";

const TRANSCRIBE_URL = "/api/transcribe";
const RENDER_URL = "/api/render";
const DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo";
const MODEL_OPTIONS = [
  {
    value: "mlx-community/whisper-large-v3-turbo",
    label: "Whisper large v3 turbo",
    size: "1.50 GB",
    pro: "Best default accuracy/speed",
    con: "Large first download",
  },
  {
    value: "mlx-community/whisper-large-v3-mlx",
    label: "Whisper large v3",
    size: "2.87 GB",
    pro: "Highest accuracy option",
    con: "Heaviest and slower",
  },
  {
    value: "mlx-community/whisper-medium-mlx-fp32",
    label: "Whisper medium",
    size: "2.84 GB",
    pro: "Solid accuracy",
    con: "Not much smaller than large",
  },
  {
    value: "mlx-community/whisper-small-mlx-fp32",
    label: "Whisper small",
    size: "0.90 GB",
    pro: "Faster and lighter",
    con: "Worse with noise/accents",
  },
  {
    value: "mlx-community/whisper-tiny",
    label: "Whisper tiny",
    size: "0.07 GB",
    pro: "Fast smoke tests",
    con: "Weak transcription accuracy",
  },
];

export default function App() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState("idle");
  const [statusText, setStatusText] = useState("Drop a video to begin.");
  const [error, setError] = useState("");
  const [projectMeta, setProjectMeta] = useState(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyState, setCopyState] = useState("idle");
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);

  const editor = useTranscriptEditor();

  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const draggingRef = useRef(false);
  const activeChipRef = useRef(null);
  const transcriptRef = useRef(null);

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
  } = editor;
  const transcriptionProgress = useTranscriptionProgress(status, videoDuration, selectedModel);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!cancelled && payload?.model) setSelectedModel(payload.model);
      })
      .catch(() => {
        // The static build can still run before the API is reachable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !items.length) return;

    const onTime = () => {
      const t = video.currentTime;

      if (!video.paused && timeline.length) {
        const target = nextKeptTime(timeline, t);
        if (target === Number.POSITIVE_INFINITY) {
          video.pause();
        } else if (target !== null) {
          video.currentTime = target;
          return;
        }
      }

      let found = null;
      for (const it of items) {
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

    video.addEventListener("timeupdate", onTime);
    return () => video.removeEventListener("timeupdate", onTime);
  }, [items, cut, timeline, activeId, setActiveId]);

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

      if (event.key === " " && videoRef.current) {
        event.preventDefault();
        if (videoRef.current.paused) videoRef.current.play();
        else videoRef.current.pause();
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

  const chooseVideo = useCallback(
    (file) => {
      if (!file) return;
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      setVideoFile(file);
      setVideoUrl(URL.createObjectURL(file));
      setVideoDuration(0);
      resetEditor();
      setProjectMeta(null);
      setError("");
      setStatus("ready");
      setStatusText("Ready to transcribe.");
    },
    [resetEditor, videoUrl]
  );

  const openProject = useCallback(
    async (summary) => {
      const projectId = summary?.projectId;
      if (!projectId) return;
      setStatus("transcribing");
      setStatusText("Loading project…");
      setError("");
      try {
        const response = await fetch(`/api/projects/${projectId}/transcript`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to load project.");

        const transcript = payload.transcript || {};
        const words = Array.isArray(transcript.words) ? transcript.words : [];
        const loaded = loadWords(words);
        if (!loaded.items.length) {
          throw new Error("Saved project has no word-level timestamps.");
        }

        if (videoUrl) URL.revokeObjectURL(videoUrl);
        setVideoFile(null);
        setVideoUrl(`/api/projects/${projectId}/video`);
        setVideoDuration(transcript?.source?.duration || 0);
        setProjectMeta({
          projectId,
          projectDir: payload.projectDir,
          videoPath: null,
          model: null,
          source: transcript.source,
        });
        setStatus("done");
        setStatusText(`${loaded.wordCount} words loaded.`);
      } catch (caught) {
        setStatus("error");
        setStatusText("Failed to load project.");
        setError(caught instanceof Error ? caught.message : String(caught));
        throw caught;
      }
    },
    [loadWords, videoUrl]
  );

  const transcribe = useCallback(async () => {
    if (!videoFile) return;
    setStatus("transcribing");
    setStatusText("Transcribing locally...");
    setError("");

    const formData = new FormData();
    formData.append("video", videoFile);
    formData.append("model", selectedModel);

    try {
      const response = await fetch(TRANSCRIBE_URL, {
        method: "POST",
        body: formData,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Transcription failed.");

      const transcript = payload.transcript || {};
      const words = Array.isArray(transcript.words) ? transcript.words : [];
      const loaded = loadWords(words);

      if (!loaded.items.length) {
        throw new Error("No word-level timestamps were returned. Try a larger Whisper model.");
      }

      setProjectMeta({
        projectId: payload.projectId,
        projectDir: payload.projectDir,
        videoPath: payload.videoPath,
        model: payload.model,
        source: transcript.source,
      });
      setStatus("done");
      setStatusText(`${loaded.wordCount} words loaded.`);
    } catch (caught) {
      setStatus("error");
      setStatusText("Transcription failed.");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadWords, selectedModel, videoFile]);

  const seekTo = useCallback(
    (item) => {
      if (!videoRef.current) return;
      videoRef.current.currentTime = item.start;
      setActiveId(item.id);
    },
    [setActiveId]
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
    },
    [extendSelection]
  );

  const togglePlayback = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

  const renderAndDownload = useCallback(async () => {
    if (!items.length || !projectMeta?.projectId || !timeline.length) return;
    setStatus("rendering");
    setStatusText("Rendering...");
    setError("");
    try {
      const response = await fetch(RENDER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: projectMeta.projectId, timeline }),
      });
      if (!response.ok) {
        let message = `Render failed (${response.status}).`;
        try {
          const payload = await response.json();
          if (payload?.error) message = payload.error;
        } catch {
          // Keep the status-code fallback when the error response is not JSON.
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const sourceName = projectMeta?.source?.file_name || videoFile?.name || "video.mp4";
      const stem = sourceName.replace(/\.[^.]+$/, "");
      const a = document.createElement("a");
      a.href = url;
      a.download = `${stem}.edit.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus("done");
      setStatusText("Render complete.");
    } catch (caught) {
      setStatus("error");
      setStatusText("Render failed.");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [items.length, projectMeta, timeline, videoFile]);

  const copyText = useCallback(async () => {
    if (!plainText) return;
    try {
      await navigator.clipboard.writeText(plainText);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 1800);
    }
  }, [plainText]);

  const hasTranscript = items.length > 0;
  const isBusy = status === "transcribing" || status === "rendering";
  const canRender = hasTranscript && timeline.length > 0 && !isBusy;
  const statusTone =
    status === "error" ? "error" : isBusy ? "busy" : hasTranscript ? "ready" : "idle";

  return (
    <main className="app">
      <Topbar
        fileInputRef={fileInputRef}
        videoFile={videoFile}
        status={status}
        statusText={statusText}
        statusTone={statusTone}
        hasTranscript={hasTranscript}
        durations={durations}
        isBusy={isBusy}
        canRender={canRender}
        modelOptions={modelOptions}
        selectedModel={selectedModel}
        onFileSelected={chooseVideo}
        onChooseVideo={openFilePicker}
        onModelChange={setSelectedModel}
        onTranscribe={transcribe}
        onOpenCopy={() => setCopyOpen(true)}
        onRenderAndDownload={renderAndDownload}
        onOpenProject={openProject}
      />

      <section className="workspace">
        <VideoPane
          videoUrl={videoUrl}
          videoRef={videoRef}
          videoFile={videoFile}
          projectMeta={projectMeta}
          isPlaying={isPlaying}
          hasTranscript={hasTranscript}
          items={items}
          cut={cut}
          durations={durations}
          error={error}
          onChooseVideo={openFilePicker}
          onTogglePlayback={togglePlayback}
          onVideoMetadata={setVideoDuration}
        />

        <TranscriptPane
          hasTranscript={hasTranscript}
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

      {copyOpen ? (
        <CopyPanel
          text={plainText}
          state={copyState}
          onCopy={copyText}
          onClose={() => setCopyOpen(false)}
        />
      ) : null}
    </main>
  );
}
