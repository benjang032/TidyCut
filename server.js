import cors from "cors";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import express from "express";
import fs from "node:fs/promises";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectsRoot = process.env.LOCAL_EDITOR_PROJECTS || path.join(__dirname, "projects");
const modelCache = process.env.LOCAL_EDITOR_MODEL_CACHE || path.join(__dirname, "models", "hf");
const defaultModel = process.env.LOCAL_EDITOR_MODEL || "mlx-community/whisper-large-v3-turbo";
const python = process.env.LOCAL_EDITOR_PYTHON || path.join(__dirname, ".venv", "bin", "python");
const vadEnabled = process.env.LOCAL_EDITOR_VAD !== "0";
const uploadsRoot = path.join(__dirname, "uploads");
const serveStatic = process.env.LOCAL_EDITOR_SERVE_STATIC === "1";
const distRoot = path.join(__dirname, "dist");

await fs.mkdir(uploadsRoot, { recursive: true });
await fs.mkdir(projectsRoot, { recursive: true });
await fs.mkdir(modelCache, { recursive: true });

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
    model: defaultModel,
    vad: vadEnabled,
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

app.get("/api/projects", async (_request, response) => {
  try {
    const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const projectId = entry.name;
          const projectDir = path.join(projectsRoot, projectId);
          const summary = {
            projectId,
            createdAt: null,
            fileName: null,
            duration: null,
            model: null,
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
            const transcriptRaw = await fs.readFile(
              path.join(projectDir, "transcript.json"),
              "utf8"
            );
            const transcript = JSON.parse(transcriptRaw);
            summary.hasTranscript = true;
            summary.fileName = transcript?.source?.file_name || null;
            summary.duration = transcript?.source?.duration || null;
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

function resolveProjectDir(projectId) {
  if (!projectId || typeof projectId !== "string" || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
    return null;
  }
  const projectDir = path.join(projectsRoot, projectId);
  const rootResolved = path.resolve(projectsRoot);
  if (!path.resolve(projectDir).startsWith(rootResolved + path.sep)) return null;
  return projectDir;
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
    response.json({
      projectId: request.params.projectId,
      projectDir,
      transcript,
    });
  } catch {
    response.status(404).json({ error: "Transcript not found for this project." });
  }
});

app.get("/api/projects/:projectId/video", async (request, response) => {
  const projectDir = resolveProjectDir(request.params.projectId);
  if (!projectDir) {
    response.status(400).json({ error: "Invalid projectId." });
    return;
  }
  let inputFile;
  try {
    const entries = await fs.readdir(projectDir);
    inputFile = entries.find((entry) => /^input\.[A-Za-z0-9]+$/.test(entry));
  } catch {
    response.status(404).json({ error: "Project not found." });
    return;
  }
  if (!inputFile) {
    response.status(404).json({ error: "Source video missing." });
    return;
  }
  response.sendFile(path.join(projectDir, inputFile));
});

app.post("/api/render", async (request, response) => {
  const { projectId, timeline } = request.body || {};

  if (!projectId || typeof projectId !== "string" || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
    response.status(400).json({ error: "Invalid projectId." });
    return;
  }
  if (!Array.isArray(timeline) || timeline.length === 0) {
    response.status(400).json({ error: "Timeline is empty — nothing to render." });
    return;
  }

  const projectDir = path.join(projectsRoot, projectId);
  const projectsRootResolved = path.resolve(projectsRoot);
  if (!path.resolve(projectDir).startsWith(projectsRootResolved + path.sep)) {
    response.status(400).json({ error: "Invalid projectId." });
    return;
  }

  let inputFile;
  try {
    const entries = await fs.readdir(projectDir);
    inputFile = entries.find((entry) => /^input\.[A-Za-z0-9]+$/.test(entry));
  } catch {
    response.status(404).json({ error: "Project directory not found." });
    return;
  }
  if (!inputFile) {
    response.status(404).json({ error: "Source video missing from project." });
    return;
  }

  let cleanTimeline;
  try {
    cleanTimeline = timeline.map((seg) => {
      const a = Number(seg?.source_start);
      const b = Number(seg?.source_end);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
        throw new Error("Invalid segment.");
      }
      return { source_start: a, source_end: b };
    });
  } catch {
    response.status(400).json({ error: "Timeline contains invalid segments." });
    return;
  }

  const sourcePath = path.join(projectDir, inputFile);
  const planPath = path.join(projectDir, "edit-plan.json");
  const outputPath = path.join(projectDir, "output.mp4");
  const downloadName = `${path.parse(inputFile).name}.edit.mp4`;

  try {
    await fs.writeFile(
      planPath,
      JSON.stringify({ version: 1, timeline: cleanTimeline }, null, 2)
    );
    await runRender({ sourcePath, planPath, outputPath });
  } catch (error) {
    response.status(500).json({
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

function runRender({ sourcePath, planPath, outputPath }) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "scripts", "render_edit_plan.py");
    const args = [
      script,
      "--source-video",
      sourcePath,
      "--edit-plan",
      planPath,
      "--output",
      outputPath,
    ];
    execFile(
      python,
      args,
      { cwd: __dirname, maxBuffer: 1024 * 1024 * 50 },
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
  console.log(`Local editor listening on http://localhost:${port}`);
});
