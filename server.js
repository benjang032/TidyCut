import cors from "cors";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import express from "express";
import fs from "node:fs/promises";
import multer from "multer";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectsRoot = process.env.LOCAL_EDITOR_PROJECTS || path.join(__dirname, "projects");
const editProjectsRoot = path.join(projectsRoot, "_edit-projects");
const localSettingsRoot = path.join(projectsRoot, "_settings");
const openRouterSettingsPath = path.join(localSettingsRoot, "openrouter.json");
const modelCache = process.env.LOCAL_EDITOR_MODEL_CACHE || path.join(__dirname, "models", "hf");
const defaultModel = process.env.LOCAL_EDITOR_MODEL || "mlx-community/whisper-large-v3-turbo";
const python = process.env.LOCAL_EDITOR_PYTHON || path.join(__dirname, ".venv", "bin", "python");
const vadEnabled = process.env.LOCAL_EDITOR_VAD !== "0";
const openRouterApiUrl =
  process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1/chat/completions";
let openRouterApiKey = process.env.OPENROUTER_API_KEY || "";
let openRouterApiKeySource = openRouterApiKey ? "environment" : "none";
const openRouterEditModel =
  process.env.OPENROUTER_EDIT_MODEL || "anthropic/claude-opus-4.6";
const openRouterEditMaxTokens = Math.max(
  1024,
  Number(process.env.OPENROUTER_EDIT_MAX_TOKENS) || 6000
);
const aiEditMaxTranscriptItems = Math.max(
  1000,
  Number(process.env.LOCAL_EDITOR_AI_EDIT_MAX_ITEMS) || 12000
);
const uploadsRoot = path.join(__dirname, "uploads");
const serveStatic = process.env.LOCAL_EDITOR_SERVE_STATIC === "1";
const distRoot = path.join(__dirname, "dist");
const videoFilePattern = /\.(avi|m4v|mkv|mov|mp4|webm)$/i;
const timelineAssetDirName = "timeline-assets";
const timelineAssetVersion = 2;
const timelineThumbIntervalSeconds = 3;
const timelineThumbWidth = 160;
const timelineThumbHeight = 90;
const waveformPeakCount = 1600;
const waveformSampleRate = 4000;
const audioPreviewDirName = "audio-previews";
const audioPreviewFilePattern = /^preview-[a-f0-9]{16}\.m4a$/;
const audioPreviewJobs = new Map();
const audioPreviewJobKeys = new Map();
const audioPreviewJobRetentionMs = 10 * 60 * 1000;
const denoiseRuntimeDir = path.join(__dirname, "models", "denoise", "deepfilternet");
const denoiseBinaryPath = path.join(
  denoiseRuntimeDir,
  "bin",
  process.platform === "win32" ? "deep-filter.exe" : "deep-filter"
);
const denoiseModelPath = path.join(denoiseRuntimeDir, "models", "DeepFilterNet3_onnx.tar.gz");
let denoiseSetupPromise = null;
const defaultAudioProcessing = {
  denoise: false,
  normalize: false,
  loudnessTarget: -16,
  truePeak: -1.5,
  lra: 11,
};

await fs.mkdir(uploadsRoot, { recursive: true });
await fs.mkdir(projectsRoot, { recursive: true });
await fs.mkdir(editProjectsRoot, { recursive: true });
await fs.mkdir(modelCache, { recursive: true });
if (!openRouterApiKey) {
  const savedOpenRouterApiKey = await readSavedOpenRouterApiKey();
  if (savedOpenRouterApiKey) {
    openRouterApiKey = savedOpenRouterApiKey;
    openRouterApiKeySource = "local";
  }
}

const app = express();
const upload = multer({
  dest: uploadsRoot,
  limits: {
    fileSize: 8 * 1024 * 1024 * 1024,
  },
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", async (_request, response) => {
  response.json({
    ok: true,
    projectsRoot,
    modelCache,
    denoiseRuntimeDir,
    model: defaultModel,
    vad: vadEnabled,
    aiEdit: {
      available: Boolean(openRouterApiKey),
      model: openRouterEditModel,
      keySource: openRouterApiKeySource,
    },
  });
});

app.post("/api/transcribe", upload.single("video"), async (request, response) => {
  const uploaded = request.file;
  if (!uploaded) {
    response.status(400).json({ error: "No video file uploaded." });
    return;
  }

  const originalName = uploaded.originalname || "input.mp4";
  const ext = path.extname(originalName) || ".mp4";
  const projectId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const projectDir = path.join(projectsRoot, projectId);
  const videoPath = path.join(projectDir, `input${ext}`);
  const model = String(request.body?.model || defaultModel);

  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(modelCache, { recursive: true });
    await fs.rename(uploaded.path, videoPath);
    const duration = await probeSourceDuration(videoPath).catch(() => null);
    await writeProjectMetadata(projectDir, {
      version: 1,
      projectId,
      source: {
        mode: "managed",
        path: videoPath,
        file_name: originalName,
        ...(duration ? { duration } : {}),
      },
    });

    const transcript = await runTranscription({
      videoPath,
      projectDir,
      model,
    });

    response.json({
      projectId,
      projectDir,
      videoPath,
      model,
      transcript,
    });
  } catch (error) {
    await fs.rm(uploaded.path, { force: true }).catch(() => {});
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/references", async (request, response) => {
  let sourcePath;
  try {
    sourcePath = await normalizeVideoSourcePath(request.body?.path);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const projectId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const projectDir = path.join(projectsRoot, projectId);
  const source = {
    mode: "reference",
    path: sourcePath,
    file_name: path.basename(sourcePath),
  };

  try {
    const duration = await probeSourceDuration(sourcePath);
    source.duration = duration;
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectMetadata(projectDir, {
      version: 1,
      projectId,
      source,
    });
    response.json({
      projectId,
      projectDir,
      videoPath: sourcePath,
      source,
      duration,
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/edit-projects", async (_request, response) => {
  try {
    const entries = await fs.readdir(editProjectsRoot, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = resolveEditProjectDir(entry.name);
      if (!projectDir) continue;
      try {
        const project = await readEditProject(projectDir);
        projects.push(summarizeEditProject(project));
      } catch {
        // Ignore malformed or partial edit projects.
      }
    }
    projects.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    response.json({ projects });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/edit-projects", async (request, response) => {
  const id = makeEditProjectId();
  const projectDir = resolveEditProjectDir(id);
  if (!projectDir) {
    response.status(500).json({ error: "Failed to allocate project id." });
    return;
  }

  try {
    await fs.mkdir(projectDir, { recursive: true });
    const project = cleanEditProjectDocument({
      ...(request.body || {}),
      id,
      clips: [],
    });
    await writeEditProject(projectDir, project);
    response.json({
      project,
      summary: summarizeEditProject(project),
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/edit-projects/:editProjectId", async (request, response) => {
  const projectDir = resolveEditProjectDir(request.params.editProjectId);
  if (!projectDir) {
    response.status(400).json({ error: "Invalid edit project id." });
    return;
  }

  try {
    const project = await readEditProject(projectDir);
    response.json({
      project,
      summary: summarizeEditProject(project),
    });
  } catch {
    response.status(404).json({ error: "Edit project not found." });
  }
});

app.put("/api/edit-projects/:editProjectId", async (request, response) => {
  const projectDir = resolveEditProjectDir(request.params.editProjectId);
  if (!projectDir) {
    response.status(400).json({ error: "Invalid edit project id." });
    return;
  }

  try {
    await fs.mkdir(projectDir, { recursive: true });
    let existing = null;
    try {
      existing = await readEditProject(projectDir);
    } catch {
      // New project document.
    }
    const project = cleanEditProjectDocument({
      ...(request.body || {}),
      id: request.params.editProjectId,
      createdAt: existing?.createdAt || request.body?.createdAt,
    });
    await writeEditProject(projectDir, project);
    response.json({
      project,
      summary: summarizeEditProject(project),
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.delete("/api/edit-projects/:editProjectId", async (request, response) => {
  const projectDir = resolveEditProjectDir(request.params.editProjectId);
  if (!projectDir) {
    response.status(400).json({ error: "Invalid edit project id." });
    return;
  }

  try {
    await fs.rm(projectDir, { recursive: true, force: true });
    response.json({ id: request.params.editProjectId, deleted: true });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/projects/:projectId/transcribe", async (request, response) => {
  const projectDir = resolveProjectDir(request.params.projectId);
  if (!projectDir) {
    response.status(400).json({ error: "Invalid projectId." });
    return;
  }

  const model = String(request.body?.model || defaultModel);
  let source;
  try {
    source = await resolveSourceVideo(projectDir);
  } catch (error) {
    response.status(404).json({
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    await fs.mkdir(modelCache, { recursive: true });
    const transcript = await runTranscription({
      videoPath: source.path,
      projectDir,
      model,
    });
    response.json({
      projectId: request.params.projectId,
      projectDir,
      videoPath: source.path,
      model,
      transcript,
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/projects", async (_request, response) => {
  try {
    const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
        .map(async (entry) => {
          const projectId = entry.name;
          const projectDir = path.join(projectsRoot, projectId);
          const summary = {
            projectId,
            createdAt: null,
            fileName: null,
            duration: null,
            model: null,
            sourceMode: null,
            sourcePath: null,
            hasSource: false,
            hasTranscript: false,
            hasRender: false,
          };
          try {
            const stat = await fs.stat(projectDir);
            summary.createdAt = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs;
          } catch {
            // skip on stat failure
          }
          try {
            const metadata = await readProjectMetadata(projectDir);
            if (metadata?.source?.path) {
              summary.hasSource = true;
              summary.sourceMode = metadata.source.mode || "reference";
              summary.sourcePath = metadata.source.path;
              summary.fileName = chooseDisplayFileName(
                summary.fileName,
                metadata.source.file_name || path.basename(metadata.source.path)
              );
              summary.duration = Number(metadata.source.duration) || summary.duration;
            }
          } catch {
            // old projects may not have project metadata
          }
          try {
            const transcriptRaw = await fs.readFile(
              path.join(projectDir, "transcript.json"),
              "utf8"
            );
            const transcript = JSON.parse(transcriptRaw);
            summary.hasTranscript = true;
            summary.hasSource = true;
            summary.fileName = chooseDisplayFileName(summary.fileName, transcript?.source?.file_name);
            summary.sourcePath = transcript?.source?.path || summary.sourcePath;
            summary.duration = Number(transcript?.source?.duration) || summary.duration;
            summary.wordCount = Array.isArray(transcript?.words)
              ? transcript.words.length
              : null;
          } catch {
            // no transcript yet
          }
          try {
            await fs.access(path.join(projectDir, "output.mp4"));
            summary.hasRender = true;
          } catch {
            // no render yet
          }
          return summary;
        })
    );
    projects.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    response.json({ projects });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

function makeEditProjectId() {
  return `edit-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function resolveEditProjectDir(editProjectId) {
  if (
    !editProjectId ||
    typeof editProjectId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(editProjectId)
  ) {
    return null;
  }
  const projectDir = path.join(editProjectsRoot, editProjectId);
  const rootResolved = path.resolve(editProjectsRoot);
  if (!path.resolve(projectDir).startsWith(rootResolved + path.sep)) return null;
  return projectDir;
}

function cleanText(value, fallback = null, maxLength = 240) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  return text.slice(0, maxLength);
}

function finiteNumberOrNull(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteNumber(value, fallback = 0) {
  const number = finiteNumberOrNull(value);
  return number == null ? fallback : number;
}

function cleanJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function cleanEditProjectItem(item, index) {
  const start = finiteNumber(item?.start);
  const end = finiteNumber(item?.end, start);
  const kind = item?.kind === "gap" ? "gap" : "word";
  return {
    id: cleanText(item?.id, `item_${index}`, 160),
    kind,
    text: kind === "word" ? cleanText(item?.text, "", 1000) || "" : "",
    start,
    end: Math.max(start, end),
  };
}

function cleanEditProjectCut(cut, validItemIds) {
  const values = Array.isArray(cut) ? cut : [];
  const result = [];
  for (const value of values) {
    const id = cleanText(value, null, 160);
    if (id && validItemIds.has(id) && !result.includes(id)) result.push(id);
  }
  return result;
}

function cleanEditProjectTrimEnd(value, trimStart, duration) {
  const trimEnd = finiteNumberOrNull(value);
  if (trimEnd == null) return null;
  if (trimEnd === 0 && duration > trimStart) return null;
  return trimEnd;
}

function cleanEditProjectClip(clip, index) {
  const items = Array.isArray(clip?.items)
    ? clip.items.slice(0, 50000).map((item, itemIndex) => cleanEditProjectItem(item, itemIndex))
    : [];
  const itemIds = new Set(items.map((item) => item.id));
  const cut = cleanEditProjectCut(clip?.cut, itemIds);
  const projectId = cleanText(clip?.projectId, null, 160);
  const duration = Math.max(0, finiteNumber(clip?.duration));
  const trimStart = Math.max(0, finiteNumber(clip?.trimStart));
  const status = ["ready", "queued", "transcribing", "probing", "error"].includes(clip?.status)
    ? clip.status
    : items.length
      ? "ready"
      : "queued";

  return {
    id: cleanText(clip?.id, `clip_${index}`, 160),
    mediaSourceId: cleanText(clip?.mediaSourceId, null, 160),
    projectId,
    projectDir: cleanText(clip?.projectDir, null, 2000),
    videoPath: cleanText(clip?.videoPath, null, 2000),
    videoUrl: projectId ? `/api/projects/${projectId}/video` : null,
    model: cleanText(clip?.model, null, 260),
    source: cleanJsonObject(clip?.source),
    fileName: cleanText(clip?.fileName, "Untitled clip", 260),
    sourceMode: cleanText(clip?.sourceMode || clip?.source?.mode, "managed", 80),
    duration,
    wordCount: finiteNumberOrNull(clip?.wordCount),
    items,
    cut,
    trimStart,
    trimEnd: cleanEditProjectTrimEnd(clip?.trimEnd, trimStart, duration),
    status,
    error: cleanText(clip?.error, null, 2000),
  };
}

function cleanEditProjectDocument(raw, options = {}) {
  const now = Date.now();
  const touch = options.touch !== false;
  const id = cleanText(raw?.id, makeEditProjectId(), 160);
  const clips = Array.isArray(raw?.clips)
    ? raw.clips.slice(0, 500).map((clip, index) => cleanEditProjectClip(clip, index))
    : [];
  const mediaSources = Array.isArray(raw?.mediaSources)
    ? raw.mediaSources.slice(0, 500).map((clip, index) => cleanEditProjectClip(clip, index))
    : [];
  const activeClipId = cleanText(raw?.activeClipId, null, 160);

  return {
    version: 1,
    id,
    name: cleanText(raw?.name, "Untitled project", 120),
    createdAt: finiteNumber(raw?.createdAt, now),
    updatedAt: touch ? now : finiteNumber(raw?.updatedAt, now),
    activeClipId: clips.some((clip) => clip.id === activeClipId) ? activeClipId : clips[0]?.id || null,
    selectedModel: cleanText(raw?.selectedModel, defaultModel, 260),
    audioProcessing: cleanAudioProcessing(raw?.audioProcessing),
    mediaSources,
    clips,
  };
}

async function readEditProject(projectDir) {
  const raw = await fs.readFile(path.join(projectDir, "edit-project.json"), "utf8");
  return cleanEditProjectDocument(JSON.parse(raw), { touch: false });
}

async function writeEditProject(projectDir, project) {
  await fs.writeFile(
    path.join(projectDir, "edit-project.json"),
    JSON.stringify(project, null, 2),
    "utf8"
  );
}

function editClipVisibleDuration(clip) {
  const duration = Math.max(0, finiteNumber(clip?.duration));
  const start = Math.max(0, finiteNumber(clip?.trimStart));
  const endRaw = finiteNumberOrNull(clip?.trimEnd);
  const end = endRaw == null ? duration : Math.max(0, endRaw);
  if (duration > 0) return Math.max(0, Math.min(duration, end) - Math.min(duration, start));
  return Math.max(0, end - start);
}

function summarizeEditProject(project) {
  const clips = Array.isArray(project?.clips) ? project.clips : [];
  const mediaSources = Array.isArray(project?.mediaSources) ? project.mediaSources : [];
  const fileNames = [
    ...new Set([...mediaSources, ...clips].map((clip) => clip.fileName).filter(Boolean)),
  ].slice(0, 4);
  const wordCount = clips.reduce((total, clip) => {
    const cut = new Set(Array.isArray(clip.cut) ? clip.cut : []);
    return (
      total +
      (clip.items || []).filter((item) => item.kind === "word" && !cut.has(item.id)).length
    );
  }, 0);

  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    clipCount: clips.length,
    readyClipCount: clips.filter((clip) => clip.status === "ready").length,
    duration: clips.reduce((total, clip) => total + editClipVisibleDuration(clip), 0),
    wordCount,
    fileNames,
  };
}

function resolveProjectDir(projectId) {
  if (!projectId || typeof projectId !== "string" || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
    return null;
  }
  const projectDir = path.join(projectsRoot, projectId);
  const rootResolved = path.resolve(projectsRoot);
  if (!path.resolve(projectDir).startsWith(rootResolved + path.sep)) return null;
  return projectDir;
}

function isInternalInputName(fileName) {
  return /^input\.[A-Za-z0-9]+$/i.test(path.basename(String(fileName || "")));
}

function chooseDisplayFileName(currentName, candidateName) {
  const candidate = String(candidateName || "").trim();
  if (!candidate) return currentName || null;
  if (!currentName || isInternalInputName(currentName)) return candidate;
  return isInternalInputName(candidate) ? currentName : candidate;
}

function expandHome(rawPath) {
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith("~/")) return path.join(os.homedir(), rawPath.slice(2));
  return rawPath;
}

async function normalizeVideoSourcePath(rawPath) {
  const trimmedPath = String(rawPath || "").trim();
  if (!trimmedPath) throw new Error("Enter a local video path.");
  const expandedPath = expandHome(trimmedPath);
  if (!path.isAbsolute(expandedPath)) throw new Error("Use an absolute local video path.");
  const sourcePath = path.resolve(expandedPath);
  if (!videoFilePattern.test(sourcePath)) {
    throw new Error("Referenced file must be a video file.");
  }

  let stat;
  try {
    stat = await fs.stat(sourcePath);
  } catch {
    throw new Error("Video file not found.");
  }
  if (!stat.isFile()) throw new Error("Referenced path is not a file.");
  return sourcePath;
}

async function readProjectMetadata(projectDir) {
  const raw = await fs.readFile(path.join(projectDir, "project.json"), "utf8");
  return JSON.parse(raw);
}

async function writeProjectMetadata(projectDir, metadata) {
  await fs.writeFile(
    path.join(projectDir, "project.json"),
    JSON.stringify(metadata, null, 2),
    "utf8"
  );
}

async function findInputFile(projectDir) {
  const entries = await fs.readdir(projectDir);
  return entries.find((entry) => /^input\.[A-Za-z0-9]+$/.test(entry)) || null;
}

async function resolveSourceVideo(projectDir) {
  try {
    const metadata = await readProjectMetadata(projectDir);
    const sourcePath = metadata?.source?.path;
    if (sourcePath) {
      await fs.access(sourcePath);
      return {
        path: sourcePath,
        fileName: metadata.source.file_name || path.basename(sourcePath),
        mode: metadata.source.mode || "reference",
        duration: Number(metadata.source.duration) || 0,
      };
    }
  } catch {
    // Fall through for older projects.
  }

  const inputFile = await findInputFile(projectDir);
  if (inputFile) {
    return {
      path: path.join(projectDir, inputFile),
      fileName: inputFile,
      mode: "managed",
    };
  }

  try {
    const raw = await fs.readFile(path.join(projectDir, "transcript.json"), "utf8");
    const transcript = JSON.parse(raw);
    const sourcePath = transcript?.source?.path;
    if (sourcePath) {
      await fs.access(sourcePath);
      return {
        path: sourcePath,
        fileName: transcript.source.file_name || path.basename(sourcePath),
        mode: "reference",
        duration: Number(transcript.source.duration) || 0,
      };
    }
  } catch {
    // no source fallback
  }

  throw new Error("Source video missing from project.");
}

function cleanTimeline(timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    throw new Error("Timeline is empty — nothing to render.");
  }
  return timeline.map((seg) => {
    const a = Number(seg?.source_start);
    const b = Number(seg?.source_end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
      throw new Error("Timeline contains invalid segments.");
    }
    return { source_start: a, source_end: b };
  });
}

async function readSavedOpenRouterApiKey() {
  try {
    const raw = await fs.readFile(openRouterSettingsPath, "utf8");
    const settings = JSON.parse(raw);
    return typeof settings?.apiKey === "string" ? settings.apiKey.trim() : "";
  } catch {
    return "";
  }
}

function cleanOpenRouterApiKey(value) {
  const apiKey = typeof value === "string" ? value.trim() : "";
  if (!apiKey) {
    throw httpError(400, "Enter your OpenRouter API key.", "OPENROUTER_API_KEY_REQUIRED");
  }
  if (apiKey.length < 20 || !apiKey.startsWith("sk-or-")) {
    throw httpError(
      400,
      "That does not look like an OpenRouter API key.",
      "OPENROUTER_API_KEY_INVALID"
    );
  }
  return apiKey;
}

async function saveOpenRouterSettings(apiKey) {
  await fs.mkdir(localSettingsRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    openRouterSettingsPath,
    JSON.stringify(
      {
        apiKey,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    { encoding: "utf8", mode: 0o600 }
  );
  await fs.chmod(openRouterSettingsPath, 0o600).catch(() => {});
}

function publicOpenRouterSettings() {
  return {
    configured: Boolean(openRouterApiKey),
    model: openRouterEditModel,
    keySource: openRouterApiKeySource,
  };
}

app.get("/api/settings/openrouter", async (_request, response) => {
  response.json(publicOpenRouterSettings());
});

app.put("/api/settings/openrouter", async (request, response) => {
  try {
    const apiKey = cleanOpenRouterApiKey(request.body?.apiKey);
    await saveOpenRouterSettings(apiKey);
    openRouterApiKey = apiKey;
    openRouterApiKeySource = "local";
    response.json(publicOpenRouterSettings());
  } catch (error) {
    response.status(error.status || 500).json({
      error: error instanceof Error ? error.message : String(error),
      code: error.code || null,
    });
  }
});

const aiEditPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "editing_mode", "summary", "timeline", "removed", "warnings"],
  properties: {
    version: {
      type: "string",
      enum: ["tidycut_ai_edit_v1"],
    },
    editing_mode: {
      type: "string",
      description: "Short name for the requested editing mode.",
    },
    summary: {
      type: "string",
      description: "One or two sentences explaining the edit strategy.",
    },
    timeline: {
      type: "array",
      description: "Final edited sequence. Each entry is one continuous video scene.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "edit_id",
          "source_clip_id",
          "source_start",
          "source_end",
          "text",
          "scene_type",
          "can_stand_alone",
          "reason",
          "confidence",
        ],
        properties: {
          edit_id: { type: "string" },
          source_clip_id: { type: "string" },
          source_start: { type: "number" },
          source_end: { type: "number" },
          text: {
            type: "string",
            description: "Approximate spoken text in the selected continuous scene.",
          },
          scene_type: {
            type: "string",
            enum: ["complete_take", "intro", "main_point", "transition", "outro", "context"],
          },
          can_stand_alone: {
            type: "boolean",
            description: "True only when the selected range works as a continuous video take.",
          },
          reason: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
    removed: {
      type: "array",
      description: "Source ranges intentionally left out of the final edit.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source_clip_id", "source_start", "source_end", "reason"],
        properties: {
          source_clip_id: { type: "string" },
          source_start: { type: "number" },
          source_end: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
    warnings: {
      type: "array",
      description: "Anything a human editor should review before rendering.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source_clip_id", "source_start", "source_end", "severity", "message"],
        properties: {
          source_clip_id: { type: "string" },
          source_start: { type: "number" },
          source_end: { type: "number" },
          severity: { type: "string", enum: ["info", "review", "risk"] },
          message: { type: "string" },
        },
      },
    },
  },
};

const aiEditSystemPrompt = [
  "You are a senior talking-head video editor.",
  "You receive transcript items with timestamps from raw footage of someone trying to record a coherent video.",
  "The speaker may pause, restart, repeat the same idea, correct themselves, or do multiple takes.",
  "Infer coherent takes/scenes directly from the transcript and timing data.",
  "Treat every selected range as a continuous video scene, not as editable prose.",
  "Do not assemble a better sentence by combining individual words, clauses, or half-sentences from different takes.",
  "A selected scene is valid only if the spoken content and visual performance can plausibly work as one continuous clip.",
  "Prefer complete takes and clean sentence or paragraph boundaries over transcript-perfect micro-edits.",
  "Keep the original order unless there is a strong coherence or storytelling reason to reorder whole scenes.",
  "If a choice is uncertain, keep the more coherent complete scene and add a warning.",
  "There is no B-roll, so avoid cuts that require visual coverage.",
  "Use source_clip_id values exactly as provided.",
].join("\n");

function roundSeconds(value) {
  return Number(Number(value).toFixed(3));
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(Math.max(number, min), max);
}

function cleanAiTranscriptItem(item, index, range) {
  const start = clampNumber(item?.start, range.start, range.end);
  const end = clampNumber(item?.end, range.start, range.end);
  if (start == null || end == null || end <= start) return null;
  const kind = item?.kind === "gap" ? "gap" : "word";
  const duration = roundSeconds(end - start);
  return {
    id: cleanText(item?.id, `${kind}_${index}`, 120),
    kind,
    start: roundSeconds(start),
    end: roundSeconds(end),
    duration,
    text:
      kind === "gap"
        ? cleanText(item?.text, `[pause ${duration.toFixed(1)}s]`, 80)
        : cleanText(item?.text, "", 300) || "",
  };
}

function cleanAiEditRequestClip(clip, index) {
  const duration = Math.max(0, finiteNumber(clip?.duration));
  const trimStart = Math.max(0, finiteNumber(clip?.trim_start ?? clip?.trimStart));
  const trimEndRaw = finiteNumberOrNull(clip?.trim_end ?? clip?.trimEnd);
  const fallbackEnd = duration > 0 ? duration : Math.max(trimStart, finiteNumber(clip?.end));
  const trimEnd = trimEndRaw == null ? fallbackEnd : Math.max(0, trimEndRaw);
  const range = {
    start: roundSeconds(Math.min(trimStart, trimEnd)),
    end: roundSeconds(Math.max(trimStart, trimEnd)),
  };
  if (range.end <= range.start) {
    throw httpError(400, "AI edit clips must have a positive visible duration.");
  }

  const rawItems = Array.isArray(clip?.transcript_items)
    ? clip.transcript_items
    : Array.isArray(clip?.items)
      ? clip.items
      : [];
  const transcriptItems = rawItems
    .map((item, itemIndex) => cleanAiTranscriptItem(item, itemIndex, range))
    .filter(Boolean);

  if (!transcriptItems.some((item) => item.kind === "word")) {
    throw httpError(400, "AI edit needs word-level transcript items.");
  }

  return {
    clip_id: cleanText(clip?.clip_id ?? clip?.id, `clip_${index + 1}`, 160),
    label: cleanText(clip?.label ?? clip?.fileName, `Clip ${index + 1}`, 240),
    duration: roundSeconds(duration || range.end),
    visible_start: range.start,
    visible_end: range.end,
    transcript_items: transcriptItems,
  };
}

function cleanAiEditRequest(body) {
  const rawClips = Array.isArray(body?.clips) ? body.clips : [];
  if (!rawClips.length) throw httpError(400, "AI edit needs at least one transcribed clip.");

  const clips = rawClips.slice(0, 50).map(cleanAiEditRequestClip);
  const itemCount = clips.reduce((total, clip) => total + clip.transcript_items.length, 0);
  if (itemCount > aiEditMaxTranscriptItems) {
    throw httpError(
      413,
      `AI edit transcript is too large (${itemCount} items). Limit is ${aiEditMaxTranscriptItems}.`
    );
  }

  return {
    mode: cleanText(body?.mode, "coherence_story_v1", 80),
    instructions: cleanText(body?.instructions, "", 2000) || "",
    clips,
    itemCount,
  };
}

function buildAiEditUserPrompt(request) {
  return JSON.stringify(
    {
      task:
        "Create a first-pass coherence/storytelling edit plan. Remove failed attempts, repeated weaker takes, long dead air, and redundant material. Preserve whole usable video scenes.",
      editing_rules: [
        "You may decide the take/scene boundaries yourself.",
        "Every timeline item must be one continuous source range from one source clip.",
        "Do not splice individual words or partial clauses across different takes.",
        "Only cut inside a sentence when the selected range still feels like a complete video scene.",
        "Prefer a slightly longer coherent take over a jumpy transcript-perfect edit.",
        "Use warnings for uncertain repeated takes, factual differences, or rough boundaries.",
      ],
      mode: request.mode,
      user_instructions: request.instructions,
      clips: request.clips,
    },
    null,
    2
  );
}

function extractOpenRouterJson(payload) {
  const output = payload?.output;
  if (output && typeof output === "object" && !Array.isArray(output)) return output;

  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const content = choice?.message?.content;
  if (content && typeof content === "object" && !Array.isArray(content)) return content;

  const text = (Array.isArray(content) ? content : [{ type: "text", text: content }])
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("")
    .trim();
  if (!text) throw new Error("OpenRouter returned no structured edit plan.");
  return JSON.parse(text);
}

async function callOpenRouterAiEdit(request) {
  if (!openRouterApiKey) {
    throw httpError(
      400,
      "Enter your OpenRouter API key to use AI edit.",
      "OPENROUTER_API_KEY_MISSING"
    );
  }

  const response = await fetch(openRouterApiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${openRouterApiKey}`,
      "X-Title": "TidyCut",
    },
    body: JSON.stringify({
      model: openRouterEditModel,
      max_tokens: openRouterEditMaxTokens,
      provider: {
        require_parameters: true,
      },
      messages: [
        {
          role: "system",
          content: aiEditSystemPrompt,
        },
        {
          role: "user",
          content: buildAiEditUserPrompt(request),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "tidycut_ai_edit_plan",
          strict: true,
          schema: aiEditPlanSchema,
        },
      },
    }),
  });

  let payload = null;
  const raw = await response.text();
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail =
      payload?.error?.message || payload?.error || raw || `OpenRouter returned ${response.status}.`;
    throw httpError(response.status >= 500 ? 502 : response.status, String(detail));
  }

  const plan = extractOpenRouterJson(payload);
  return {
    plan,
    usage: payload?.usage || null,
  };
}

function aiClipRangeMap(clips) {
  return new Map(
    clips.map((clip) => [
      clip.clip_id,
      {
        start: Number(clip.visible_start),
        end: Number(clip.visible_end),
      },
    ])
  );
}

function sanitizeAiRange(raw, clipRanges) {
  const clipId = cleanText(raw?.source_clip_id, null, 160);
  const bounds = clipId ? clipRanges.get(clipId) : null;
  if (!bounds) return null;
  const start = clampNumber(raw?.source_start, bounds.start, bounds.end);
  const end = clampNumber(raw?.source_end, bounds.start, bounds.end);
  if (start == null || end == null || end <= start) return null;
  return {
    source_clip_id: clipId,
    source_start: roundSeconds(start),
    source_end: roundSeconds(end),
  };
}

function sanitizeAiTimelineEntry(raw, index, clipRanges) {
  const range = sanitizeAiRange(raw, clipRanges);
  if (!range) return null;
  if (range.source_end - range.source_start < 0.25) return null;
  return {
    edit_id: cleanText(raw?.edit_id, `edit_${String(index + 1).padStart(3, "0")}`, 120),
    ...range,
    text: cleanText(raw?.text, "", 2000) || "",
    scene_type: [
      "complete_take",
      "intro",
      "main_point",
      "transition",
      "outro",
      "context",
    ].includes(raw?.scene_type)
      ? raw.scene_type
      : "complete_take",
    can_stand_alone: Boolean(raw?.can_stand_alone),
    reason: cleanText(raw?.reason, "Selected by AI edit.", 1000) || "Selected by AI edit.",
    confidence: Math.min(1, Math.max(0, finiteNumber(raw?.confidence, 0))),
  };
}

function sanitizeAiRemovedEntry(raw, clipRanges) {
  const range = sanitizeAiRange(raw, clipRanges);
  if (!range) return null;
  return {
    ...range,
    reason: cleanText(raw?.reason, "Removed by AI edit.", 1000) || "Removed by AI edit.",
  };
}

function sanitizeAiWarning(raw, clipRanges) {
  const range = sanitizeAiRange(raw, clipRanges);
  if (!range) return null;
  const severity = ["info", "review", "risk"].includes(raw?.severity) ? raw.severity : "review";
  return {
    ...range,
    severity,
    message: cleanText(raw?.message, "Review this boundary.", 1000) || "Review this boundary.",
  };
}

function sanitizeAiEditPlan(rawPlan, request) {
  const clipRanges = aiClipRangeMap(request.clips);
  const timeline = (Array.isArray(rawPlan?.timeline) ? rawPlan.timeline : [])
    .map((entry, index) => sanitizeAiTimelineEntry(entry, index, clipRanges))
    .filter(Boolean);
  if (!timeline.length) {
    throw httpError(502, "AI returned an empty edit timeline.");
  }

  const warnings = (Array.isArray(rawPlan?.warnings) ? rawPlan.warnings : [])
    .map((entry) => sanitizeAiWarning(entry, clipRanges))
    .filter(Boolean);
  for (const entry of timeline) {
    if (!entry.can_stand_alone) {
      warnings.push({
        source_clip_id: entry.source_clip_id,
        source_start: entry.source_start,
        source_end: entry.source_end,
        severity: "review",
        message: "AI selected this scene but marked it as not fully standalone.",
      });
    }
  }

  return {
    version: "tidycut_ai_edit_v1",
    model: openRouterEditModel,
    editing_mode: cleanText(rawPlan?.editing_mode, request.mode, 120) || request.mode,
    summary: cleanText(rawPlan?.summary, "AI generated a first-pass edit.", 2000),
    timeline,
    removed: (Array.isArray(rawPlan?.removed) ? rawPlan.removed : [])
      .map((entry) => sanitizeAiRemovedEntry(entry, clipRanges))
      .filter(Boolean),
    warnings,
  };
}

app.post("/api/ai/edit-plan", async (request, response) => {
  let editRequest;
  try {
    editRequest = cleanAiEditRequest(request.body || {});
    const { plan: rawPlan, usage } = await callOpenRouterAiEdit(editRequest);
    const plan = sanitizeAiEditPlan(rawPlan, editRequest);
    response.json({
      model: openRouterEditModel,
      itemCount: editRequest.itemCount,
      usage,
      plan,
    });
  } catch (error) {
    response.status(error.status || 500).json({
      error: error instanceof Error ? error.message : String(error),
      code: error.code || null,
    });
  }
});

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || stdout || error.message}`.trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function probeSourceDuration(sourcePath) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      sourcePath,
    ],
    { maxBuffer: 1024 * 1024 }
  );
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not read video duration.");
  }
  return duration;
}

function timelineAssetUrl(projectId, fileName, cacheKey) {
  return `/api/projects/${projectId}/timeline-assets/${fileName}?v=${cacheKey}`;
}

async function readCachedTimelineAssets(assetDir, source, sourceStat) {
  try {
    const raw = await fs.readFile(path.join(assetDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(raw);
    const valid =
      manifest?.version === timelineAssetVersion &&
      manifest?.source?.path === source.path &&
      manifest?.source?.size === sourceStat.size &&
      manifest?.source?.mtimeMs === sourceStat.mtimeMs &&
      manifest?.thumbnail?.intervalSeconds === timelineThumbIntervalSeconds &&
      manifest?.thumbnail?.width === timelineThumbWidth &&
      manifest?.thumbnail?.height === timelineThumbHeight &&
      Array.isArray(manifest?.thumbnails) &&
      Array.isArray(manifest?.waveform?.peaks);
    if (!valid) return null;

    await Promise.all(
      manifest.thumbnails.map((thumbnail) => fs.access(path.join(assetDir, thumbnail.file)))
    );
    return manifest;
  } catch {
    return null;
  }
}

async function buildWaveformPeaks(sourcePath) {
  try {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        sourcePath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(waveformSampleRate),
        "-f",
        "s16le",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 1024 * 1024 * 150 }
    );
    const sampleCount = Math.floor(stdout.length / 2);
    if (sampleCount <= 0) return [];

    const peaks = [];
    const samplesPerPeak = Math.max(1, Math.ceil(sampleCount / waveformPeakCount));
    for (let peakIndex = 0; peakIndex < waveformPeakCount; peakIndex += 1) {
      const start = peakIndex * samplesPerPeak;
      if (start >= sampleCount) break;
      const end = Math.min(sampleCount, start + samplesPerPeak);
      let peak = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        const sample = Math.abs(stdout.readInt16LE(sampleIndex * 2));
        if (sample > peak) peak = sample;
      }
      peaks.push(Number(Math.min(1, peak / 32768).toFixed(3)));
    }
    return peaks;
  } catch {
    return [];
  }
}

async function generateTimelineAssets(projectDir, source) {
  const sourceStat = await fs.stat(source.path);
  const assetDir = path.join(projectDir, timelineAssetDirName);
  await fs.mkdir(assetDir, { recursive: true });

  const cached = await readCachedTimelineAssets(assetDir, source, sourceStat);
  if (cached) return cached;

  await fs.rm(assetDir, { recursive: true, force: true });
  await fs.mkdir(assetDir, { recursive: true });

  const duration = await probeSourceDuration(source.path);
  const cacheKey = `${Math.round(sourceStat.mtimeMs)}-${sourceStat.size}`;
  const lastFrameTime = Math.max(0, duration - 0.05);

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      source.path,
      "-an",
      "-vf",
      `fps=1/${timelineThumbIntervalSeconds},scale=${timelineThumbWidth}:${timelineThumbHeight}:force_original_aspect_ratio=decrease,pad=${timelineThumbWidth}:${timelineThumbHeight}:(ow-iw)/2:(oh-ih)/2,format=yuvj420p`,
      "-q:v",
      "5",
      "-start_number",
      "0",
      path.join(assetDir, "thumb-%05d.jpg"),
    ],
    { maxBuffer: 1024 * 1024 * 5 }
  );

  let thumbnailFiles = (await fs.readdir(assetDir))
    .filter((file) => /^thumb-\d{5,}\.jpg$/.test(file))
    .sort();

  if (thumbnailFiles.length === 0) {
    const file = "thumb-00000.jpg";
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-ss",
        "0",
        "-i",
        source.path,
        "-frames:v",
        "1",
        "-vf",
        `scale=${timelineThumbWidth}:${timelineThumbHeight}:force_original_aspect_ratio=decrease,pad=${timelineThumbWidth}:${timelineThumbHeight}:(ow-iw)/2:(oh-ih)/2,format=yuvj420p`,
        "-q:v",
        "5",
        path.join(assetDir, file),
      ],
      { maxBuffer: 1024 * 1024 * 5 }
    );
    thumbnailFiles = [file];
  }

  const thumbnails = thumbnailFiles.map((file, index) => ({
    file,
    time: Number(Math.min(lastFrameTime, index * timelineThumbIntervalSeconds).toFixed(3)),
  }));

  const waveformPeaks = await buildWaveformPeaks(source.path);

  const manifest = {
    version: timelineAssetVersion,
    source: {
      path: source.path,
      size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs,
    },
    cacheKey,
    duration,
    thumbnail: {
      intervalSeconds: timelineThumbIntervalSeconds,
      width: timelineThumbWidth,
      height: timelineThumbHeight,
    },
    thumbnails,
    waveform: {
      peaks: waveformPeaks,
      sampleRate: waveformSampleRate,
    },
  };
  await fs.writeFile(path.join(assetDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

app.get("/api/projects/:projectId/transcript", async (request, response) => {
  const projectDir = resolveProjectDir(request.params.projectId);
  if (!projectDir) {
    response.status(400).json({ error: "Invalid projectId." });
    return;
  }
  try {
    const raw = await fs.readFile(path.join(projectDir, "transcript.json"), "utf8");
    const transcript = JSON.parse(raw);
    const source = await resolveSourceVideo(projectDir).catch(() => null);
    const hydratedTranscript = source
      ? {
          ...transcript,
          source: {
            ...(transcript.source || {}),
            mode: source.mode,
            path: source.path,
            file_name: source.fileName,
            ...(source.duration || transcript?.source?.duration
              ? { duration: source.duration || transcript.source.duration }
              : {}),
          },
        }
      : transcript;
    response.json({
      projectId: request.params.projectId,
      projectDir,
      transcript: hydratedTranscript,
    });
  } catch {
    response.status(404).json({ error: "Transcript not found for this project." });
  }
});

app.get("/api/projects/:projectId/source", async (request, response) => {
  const projectDir = resolveProjectDir(request.params.projectId);
  if (!projectDir) {
    response.status(400).json({ error: "Invalid projectId." });
    return;
  }
  try {
    const source = await resolveSourceVideo(projectDir);
    const duration = source.duration || (await probeSourceDuration(source.path).catch(() => null));
    response.json({
      projectId: request.params.projectId,
      projectDir,
      videoPath: source.path,
      source: {
        mode: source.mode,
        path: source.path,
        file_name: source.fileName,
        ...(duration ? { duration } : {}),
      },
    });
  } catch (error) {
    response.status(404).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/projects/:projectId/video", async (request, response) => {
  const projectDir = resolveProjectDir(request.params.projectId);
  if (!projectDir) {
    response.status(400).json({ error: "Invalid projectId." });
    return;
  }
  let source;
  try {
    source = await resolveSourceVideo(projectDir);
  } catch {
    response.status(404).json({ error: "Project not found." });
    return;
  }
  response.sendFile(source.path);
});

app.get("/api/projects/:projectId/audio-previews/:fileName", async (request, response) => {
  const projectDir = resolveProjectDir(request.params.projectId);
  const fileName = String(request.params.fileName || "");
  if (!projectDir || !audioPreviewFilePattern.test(fileName)) {
    response.status(400).json({ error: "Invalid audio preview." });
    return;
  }
  response.type("audio/mp4");
  response.sendFile(path.join(projectDir, audioPreviewDirName, fileName));
});

app.get("/api/projects/:projectId/timeline-assets", async (request, response) => {
  const projectDir = resolveProjectDir(request.params.projectId);
  if (!projectDir) {
    response.status(400).json({ error: "Invalid projectId." });
    return;
  }

  let source;
  try {
    source = await resolveSourceVideo(projectDir);
  } catch {
    response.status(404).json({ error: "Project not found." });
    return;
  }

  try {
    const manifest = await generateTimelineAssets(projectDir, source);
    const cacheKey = manifest.cacheKey || Date.now();
    response.json({
      duration: manifest.duration,
      thumbnails: manifest.thumbnails.map((thumbnail) => ({
        time: thumbnail.time,
        url: timelineAssetUrl(request.params.projectId, thumbnail.file, cacheKey),
      })),
      waveform: {
        peaks: manifest.waveform.peaks,
        sampleRate: manifest.waveform.sampleRate || waveformSampleRate,
      },
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/projects/:projectId/timeline-assets/:fileName", async (request, response) => {
  const projectDir = resolveProjectDir(request.params.projectId);
  const fileName = String(request.params.fileName || "");
  if (!projectDir || !/^thumb-\d{5,}\.jpg$/.test(fileName)) {
    response.status(400).json({ error: "Invalid timeline asset." });
    return;
  }
  response.sendFile(path.join(projectDir, timelineAssetDirName, fileName));
});

app.post("/api/audio-preview", async (request, response) => {
  const projectId = String(request.body?.projectId || "");
  const projectDir = resolveProjectDir(projectId);
  const audioProcessing = cleanAudioProcessing(request.body?.audioProcessing);
  if (!projectDir) {
    response.status(400).json({ error: "Invalid projectId." });
    return;
  }
  if (!audioProcessing.denoise && !audioProcessing.normalize) {
    response.json({
      status: "idle",
      progress: 0,
      message: "Audio preview disabled.",
    });
    return;
  }

  try {
    const source = await resolveSourceVideo(projectDir);
    const sourceStat = await fs.stat(source.path);
    const cacheKey = audioPreviewCacheKey(source, sourceStat, audioProcessing);
    const fileName = `preview-${cacheKey}.m4a`;
    const outputPath = path.join(projectDir, audioPreviewDirName, fileName);
    const url = audioPreviewUrl(projectId, fileName, cacheKey);

    try {
      await fs.access(outputPath);
      response.json({
        status: "ready",
        progress: 1,
        message: "Audio preview ready.",
        url,
      });
      return;
    } catch {
      // Build below.
    }

    const jobKey = `${projectId}:${cacheKey}`;
    const existingJobId = audioPreviewJobKeys.get(jobKey);
    const existingJob = existingJobId ? audioPreviewJobs.get(existingJobId) : null;
    if (existingJob && existingJob.status !== "error" && existingJob.status !== "canceled") {
      response.json(serializeAudioPreviewJob(existingJob));
      return;
    }

    const job = {
      id: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      key: jobKey,
      projectId,
      sourcePath: source.path,
      outputPath,
      url,
      audioProcessing,
      status: "processing",
      progress: 0.05,
      message: "Preparing audio preview",
      error: "",
      stderr: "",
      stdoutBuffer: "",
      child: null,
    };
    audioPreviewJobs.set(job.id, job);
    audioPreviewJobKeys.set(job.key, job.id);
    startAudioPreviewJob(job);
    response.json(serializeAudioPreviewJob(job));
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/audio-preview/:jobId", (request, response) => {
  const job = audioPreviewJobs.get(String(request.params.jobId || ""));
  if (!job) {
    response.status(404).json({ error: "Audio preview job not found." });
    return;
  }
  response.json(serializeAudioPreviewJob(job));
});

app.delete("/api/audio-preview/:jobId", (request, response) => {
  const job = audioPreviewJobs.get(String(request.params.jobId || ""));
  if (!job) {
    response.json({ ok: true });
    return;
  }
  cancelAudioPreviewJob(job);
  response.json(serializeAudioPreviewJob(job));
});

function httpError(status, message, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function renderRequestClips(body) {
  if (Array.isArray(body.clips)) return body.clips;
  if (body.projectId || body.timeline) {
    return [{ projectId: body.projectId, timeline: body.timeline }];
  }
  return [];
}

async function buildRenderClip(clip) {
  const projectId = String(clip?.projectId || "");
  const projectDir = resolveProjectDir(projectId);
  if (!projectDir) throw httpError(400, "Invalid projectId in sequence.");

  let source;
  try {
    source = await resolveSourceVideo(projectDir);
  } catch {
    throw httpError(404, "Project directory not found.");
  }

  let timeline;
  try {
    timeline = cleanTimeline(clip.timeline);
  } catch (error) {
    throw httpError(
      400,
      error instanceof Error ? error.message : "Timeline contains invalid segments."
    );
  }

  return {
    clip_id: String(clip?.clipId || ""),
    project_id: projectId,
    label: String(clip?.label || source.fileName),
    source_video: source.path,
    timeline,
  };
}

app.post("/api/render", async (request, response) => {
  const body = request.body || {};
  const requestClips = renderRequestClips(body);
  const audioProcessing = cleanAudioProcessing(body.audioProcessing);
  let outputPath;
  let downloadName;

  try {
    if (!requestClips.length) {
      throw httpError(400, "Sequence is empty — nothing to render.");
    }

    const cleanClips = await Promise.all(requestClips.map(buildRenderClip));
    const renderDir = path.join(
      projectsRoot,
      "_renders",
      `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    );
    await fs.mkdir(renderDir, { recursive: true });

    const planPath = path.join(renderDir, "edit-plan.json");
    outputPath = path.join(renderDir, "output.mp4");
    downloadName =
      cleanClips.length > 1
        ? "tidycut-sequence.edit.mp4"
        : `${path.parse(cleanClips[0].label).name}.edit.mp4`;

    await fs.writeFile(planPath, JSON.stringify({ version: 2, clips: cleanClips }, null, 2));
    if (audioProcessing.denoise) {
      await ensureDenoiseReady();
    }
    await runRender({ planPath, outputPath, audioProcessing });
  } catch (error) {
    response.status(error.status || 500).json({
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  response.download(outputPath, downloadName, (err) => {
    if (err && !response.headersSent) {
      response.status(500).json({ error: err.message });
    }
  });
});

function cleanAudioProcessing(rawOptions) {
  const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {};
  const numberOrDefault = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    denoise: Boolean(options.denoise),
    normalize: Boolean(options.normalize),
    loudnessTarget: numberOrDefault(
      options.loudnessTarget,
      defaultAudioProcessing.loudnessTarget
    ),
    truePeak: numberOrDefault(options.truePeak, defaultAudioProcessing.truePeak),
    lra: numberOrDefault(options.lra, defaultAudioProcessing.lra),
  };
}

function audioPreviewCacheKey(source, sourceStat, audioProcessing) {
  const payload = JSON.stringify({
    version: 1,
    sourcePath: source.path,
    sourceSize: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs,
    denoise: audioProcessing.denoise,
    normalize: audioProcessing.normalize,
    loudnessTarget: audioProcessing.loudnessTarget,
    truePeak: audioProcessing.truePeak,
    lra: audioProcessing.lra,
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function audioPreviewUrl(projectId, fileName, cacheKey) {
  return `/api/projects/${projectId}/audio-previews/${fileName}?v=${cacheKey}`;
}

function serializeAudioPreviewJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error || "",
    url: job.status === "ready" ? job.url : null,
  };
}

function scheduleAudioPreviewJobCleanup(job) {
  const timer = setTimeout(() => {
    if (audioPreviewJobs.get(job.id) === job) {
      audioPreviewJobs.delete(job.id);
    }
    if (audioPreviewJobKeys.get(job.key) === job.id && job.status !== "ready") {
      audioPreviewJobKeys.delete(job.key);
    }
  }, audioPreviewJobRetentionMs);
  timer.unref?.();
}

function updateAudioPreviewProgress(job, event) {
  const progress = Number(event?.progress);
  if (Number.isFinite(progress)) {
    job.progress = Math.max(job.progress || 0, Math.min(1, Math.max(0, progress)));
  }
  if (typeof event?.message === "string" && event.message.trim()) {
    job.message = event.message.trim();
  }
}

function consumeProgressStdout(buffer, chunk, onEvent) {
  const lines = `${buffer}${chunk}`.split(/\r?\n/);
  const nextBuffer = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      onEvent(JSON.parse(trimmed));
    } catch {
      // Ignore non-progress output.
    }
  }
  return nextBuffer;
}

function consumeAudioPreviewStdout(job, chunk) {
  job.stdoutBuffer = consumeProgressStdout(job.stdoutBuffer, chunk, (event) =>
    updateAudioPreviewProgress(job, event)
  );
}

function failAudioPreviewJob(job, error, message = "Audio preview failed") {
  if (job.status === "canceled") return;
  job.child = null;
  job.status = "error";
  job.error = error instanceof Error ? error.message : String(error);
  job.message = message;
  audioPreviewJobKeys.delete(job.key);
  fs.rm(job.outputPath, { force: true }).catch(() => {});
  scheduleAudioPreviewJobCleanup(job);
}

function setupProgressForPreview(event) {
  const progress = Number(event?.progress);
  return {
    ...event,
    progress: Number.isFinite(progress) ? 0.05 + progress * 0.3 : undefined,
  };
}

function runDenoiseSetup(job = null) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "scripts", "prepare_deepfilternet.py");
    const args = [
      script,
      "--runtime-dir",
      denoiseRuntimeDir,
    ];
    let stdoutBuffer = "";
    let stderr = "";
    const child = spawn(python, args, {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer = consumeProgressStdout(stdoutBuffer, chunk, (event) => {
        if (job) updateAudioPreviewProgress(job, setupProgressForPreview(event));
      });
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12000);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error((stderr || `Denoise setup exited with ${signal || `code ${code}`}.`).trim()));
    });
  });
}

async function ensureDenoiseReady(job = null) {
  if (denoiseSetupPromise) {
    if (job) {
      updateAudioPreviewProgress(job, {
        progress: Math.max(job.progress || 0, 0.08),
        message: "Waiting for denoise model setup",
      });
    }
    await denoiseSetupPromise;
    return;
  }
  denoiseSetupPromise = runDenoiseSetup(job).finally(() => {
    denoiseSetupPromise = null;
  });
  await denoiseSetupPromise;
}

async function runAudioPreviewJob(job) {
  try {
    if (job.audioProcessing.denoise) {
      await ensureDenoiseReady(job);
      if (job.status === "canceled") return;
    }
    spawnAudioPreviewProcess(job);
  } catch (error) {
    failAudioPreviewJob(job, error, "Denoise setup failed");
  }
}

function startAudioPreviewJob(job) {
  runAudioPreviewJob(job);
}

function spawnAudioPreviewProcess(job) {
  const script = path.join(__dirname, "scripts", "process_audio_preview.py");
  const args = [
    script,
    "--source-video",
    job.sourcePath,
    "--output",
    job.outputPath,
    "--loudness-target",
    String(job.audioProcessing.loudnessTarget),
    "--true-peak",
    String(job.audioProcessing.truePeak),
    "--lra",
    String(job.audioProcessing.lra),
  ];
  if (job.audioProcessing.denoise) {
    args.push(
      "--denoise-audio",
      "--denoise-binary",
      denoiseBinaryPath,
      "--denoise-model",
      denoiseModelPath
    );
  }
  if (job.audioProcessing.normalize) args.push("--normalize-audio");

  const child = spawn(python, args, {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.child = child;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => consumeAudioPreviewStdout(job, chunk));
  child.stderr.on("data", (chunk) => {
    job.stderr = `${job.stderr}${chunk}`.slice(-12000);
  });
  child.on("error", (error) => {
    failAudioPreviewJob(job, error);
  });
  child.on("exit", async (code, signal) => {
    job.child = null;
    if (job.status === "canceled") return;

    if (code === 0) {
      try {
        await fs.access(job.outputPath);
        job.status = "ready";
        job.progress = 1;
        job.message = "Audio preview ready";
        job.error = "";
        scheduleAudioPreviewJobCleanup(job);
      } catch {
        failAudioPreviewJob(job, "Audio preview finished without writing an output file.");
      }
    } else {
      failAudioPreviewJob(
        job,
        (job.stderr || `Audio preview exited with ${signal || `code ${code}`}.`).trim()
      );
    }
  });
}

function cancelAudioPreviewJob(job) {
  if (job.status === "ready" || job.status === "error" || job.status === "canceled") return;
  job.status = "canceled";
  job.progress = 0;
  job.message = "Audio preview canceled";
  job.error = "";
  audioPreviewJobKeys.delete(job.key);
  fs.rm(job.outputPath, { force: true }).catch(() => {});
  if (job.child) {
    const child = job.child;
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (job.child === child) child.kill("SIGKILL");
    }, 2000);
    killTimer.unref?.();
  }
  scheduleAudioPreviewJobCleanup(job);
}

function runRender({ planPath, outputPath, audioProcessing = defaultAudioProcessing }) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "scripts", "render_edit_plan.py");
    const args = [script, "--edit-plan", planPath, "--output", outputPath];
    if (audioProcessing.denoise) {
      args.push(
        "--denoise-audio",
        "--denoise-binary",
        denoiseBinaryPath,
        "--denoise-model",
        denoiseModelPath
      );
    }
    if (audioProcessing.normalize) args.push("--normalize-audio");
    args.push(
      "--loudness-target",
      String(audioProcessing.loudnessTarget),
      "--true-peak",
      String(audioProcessing.truePeak),
      "--lra",
      String(audioProcessing.lra)
    );
    execFile(
      python,
      args,
      {
        cwd: __dirname,
        maxBuffer: 1024 * 1024 * 50,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${stderr || stdout || error.message}`.trim()));
          return;
        }
        resolve();
      }
    );
  });
}

if (serveStatic) {
  app.use(express.static(distRoot));
  app.get(/^(?!\/api).*/, async (_request, response) => {
    response.sendFile(path.join(distRoot, "index.html"));
  });
}

function runTranscription({ videoPath, projectDir, model }) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "scripts", "transcribe_local.py");
    const args = [
      script,
      videoPath,
      "--project-dir",
      projectDir,
      "--cache-dir",
      modelCache,
      "--model",
      model,
    ];
    if (!vadEnabled) {
      args.push("--no-vad");
    }

    execFile(
      python,
      args,
      {
        cwd: __dirname,
        env: {
          ...process.env,
          HF_HOME: modelCache,
          HF_HUB_CACHE: path.join(modelCache, "hub"),
        },
        maxBuffer: 1024 * 1024 * 20,
      },
      async (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${stderr || stdout || error.message}`.trim()));
          return;
        }

        const transcriptPath = stdout.trim().split(/\r?\n/).at(-1);
        if (!transcriptPath) {
          reject(new Error("Transcription finished without returning a transcript path."));
          return;
        }

        try {
          const text = await fs.readFile(transcriptPath, "utf8");
          resolve(JSON.parse(text));
        } catch (readError) {
          reject(readError);
        }
      }
    );
  });
}

const port = Number(process.env.LOCAL_EDITOR_PORT || process.env.LOCAL_EDITOR_BACKEND_PORT || (serveStatic ? 5173 : 8787));
app.listen(port, () => {
  console.log(`TidyCut listening on http://localhost:${port}`);
});
