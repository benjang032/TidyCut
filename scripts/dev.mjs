import { spawn, spawnSync } from "node:child_process";

const build = spawnSync("npx", ["vite", "build"], {
  stdio: "inherit",
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const server = spawn("node", ["server.js"], {
  stdio: "inherit",
  env: {
    ...process.env,
    LOCAL_EDITOR_PORT: process.env.LOCAL_EDITOR_PORT || "5173",
    LOCAL_EDITOR_SERVE_STATIC: "1",
  },
});

function stop() {
  server.kill("SIGTERM");
}

process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stop();
  process.exit(143);
});

server.on("exit", (code) => {
  process.exit(code ?? 0);
});
