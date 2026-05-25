/**
 * Dev-only demo server: serves the package directory (no-cache) and bridges a
 * real shell PTY to the browser over a WebSocket, so demo.html runs an actual
 * xterm.js terminal — real shell, real output — drawn by the WebGPU renderer.
 *
 * Not part of the published package (package.json "files" ships only dist).
 * Uses the host repo's @lydell/node-pty (resolved by walking up node_modules).
 *
 *   node demo/server.mjs   →   http://localhost:8091/demo.html
 *
 * WS protocol (client → server): first char is a tag.
 *   "i" + data        raw keyboard input → pty.write
 *   "r" + {cols,rows} resize the pty
 * server → client: raw pty output as text frames.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as pty from "@lydell/node-pty";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 8091;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/demo.html";
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-cache, no-store, must-revalidate",
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/pty" });
wss.on("connection", (ws) => {
  const shell = process.env.SHELL || "/bin/zsh";
  const term = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
    env: process.env,
  });
  const onData = term.onData((d) => {
    if (ws.readyState === ws.OPEN) ws.send(d);
  });
  const onExit = term.onExit(() => {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  });
  ws.on("message", (raw) => {
    const msg = raw.toString();
    const tag = msg[0];
    const body = msg.slice(1);
    if (tag === "r") {
      try {
        const { cols, rows } = JSON.parse(body);
        if (cols > 0 && rows > 0) term.resize(cols, rows);
      } catch {
        /* ignore malformed resize */
      }
    } else if (tag === "i") {
      term.write(body);
    }
  });
  ws.on("close", () => {
    onData.dispose();
    onExit.dispose();
    try {
      term.kill();
    } catch {
      /* already gone */
    }
  });
});

server.listen(PORT, () => {
  console.log(`webgpu-term demo → http://localhost:${PORT}/demo.html  (Ctrl-C to stop)`);
});
