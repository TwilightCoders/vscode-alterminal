/**
 * PTY Daemon — standalone Node.js process that owns PTY file descriptors.
 *
 * Launched by the extension host as a detached child process.
 * Listens on a Unix domain socket (or named pipe on Windows).
 * Keeps PTYs alive across extension host reloads.
 *
 * Usage: node ptyDaemon.js <lockfilePath> <socketPath> <secret>
 */

import * as net from "net";
import * as fs from "fs";
import { execFileSync } from "child_process";
import * as pty from "@lydell/node-pty";
import {
  type ClientMessage,
  type DaemonMessage,
  type DaemonLockfile,
  type PtyInfo,
  encodeMessage,
  FrameDecoder,
} from "./protocol";
import { writeLockfile, removeLockfile, removeStaleSocket } from "./lockfile";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max buffered output per PTY during client disconnect (1MB). */
const MAX_BUFFER_SIZE = 1024 * 1024;

/** Inactivity timeout — daemon exits if no clients connect for this long. */
const INACTIVITY_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

// ---------------------------------------------------------------------------
// PTY entry
// ---------------------------------------------------------------------------

interface PtyEntry {
  ptyId: string;
  sessionId: string;
  process: pty.IPty;
  buffer: string[];
  bufferSize: number;
  cwd: string;
  cols: number;
  rows: number;
}

// ---------------------------------------------------------------------------
// Client connection
// ---------------------------------------------------------------------------

interface ClientConnection {
  socket: net.Socket;
  decoder: FrameDecoder;
  sessionId: string | null;
  authenticated: boolean;
}

// ---------------------------------------------------------------------------
// Daemon state
// ---------------------------------------------------------------------------

const ptys = new Map<string, PtyEntry>();
const clients: Set<ClientConnection> = new Set();
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const [, , lockPath, sockPath, secret] = process.argv;
if (!lockPath || !sockPath || !secret) {
  process.stderr.write("Usage: node ptyDaemon.js <lockfilePath> <socketPath> <secret>\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Inactivity management
// ---------------------------------------------------------------------------

function resetInactivityTimer(): void {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
  }
  inactivityTimer = setTimeout(() => {
    if (clients.size === 0) {
      shutdown();
    }
  }, INACTIVITY_TIMEOUT_MS);
  inactivityTimer.unref();
}

function shutdown(): void {
  for (const entry of ptys.values()) {
    try {
      entry.process.kill();
    } catch {
      // already dead
    }
  }
  ptys.clear();
  removeLockfile(lockPath);
  removeStaleSocket(sockPath);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Send helper
// ---------------------------------------------------------------------------

function send(client: ClientConnection, msg: DaemonMessage): void {
  if (!client.socket.destroyed) {
    client.socket.write(encodeMessage(msg));
  }
}

function broadcast(sessionId: string, msg: DaemonMessage): void {
  for (const client of clients) {
    if (client.authenticated && client.sessionId === sessionId) {
      send(client, msg);
    }
  }
}

/** Check if any authenticated client is connected for a session. */
function hasConnectedClient(sessionId: string): boolean {
  for (const client of clients) {
    if (client.authenticated && client.sessionId === sessionId) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// PTY management
// ---------------------------------------------------------------------------

function spawnPty(msg: ClientMessage & { type: "spawn" }, client: ClientConnection): void {
  if (ptys.has(msg.ptyId)) {
    send(client, { type: "error", id: msg.id, message: `PTY ${msg.ptyId} already exists` });
    return;
  }

  try {
    const proc = pty.spawn(msg.shell, msg.args, {
      name: "xterm-256color",
      cols: msg.cols,
      rows: msg.rows,
      cwd: msg.cwd,
      env: msg.env,
    });

    // Shell init via TTY stuffing — same timing as direct mode.
    // Suppress kernel echo so the stuffed command is invisible.
    if (msg.env.ALTERMINAL_SHELL_INIT) {
      const slavePty = (proc as any)._pty as string | undefined;
      if (slavePty) {
        try {
          const fd = fs.openSync(slavePty, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
          try { execFileSync("stty", ["-echo"], { stdio: [fd, "pipe", "pipe"] }); } finally { fs.closeSync(fd); }
        } catch { /* stty failed — echo will be visible but init still works */ }
      }
      proc.write(` source "$ALTERMINAL_SHELL_INIT" 2>/dev/null; unset ALTERMINAL_SHELL_INIT\r`);
      if (slavePty) {
        try {
          const fd = fs.openSync(slavePty, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
          try { execFileSync("stty", ["echo"], { stdio: [fd, "pipe", "pipe"] }); } finally { fs.closeSync(fd); }
        } catch { /* ignore */ }
      }
    }

    const entry: PtyEntry = {
      ptyId: msg.ptyId,
      sessionId: msg.sessionId,
      process: proc,
      buffer: [],
      bufferSize: 0,
      cwd: msg.cwd,
      cols: msg.cols,
      rows: msg.rows,
    };

    proc.onData((data: string) => {
      // Extract CWD from OSC 7 if present
      const osc7Match = data.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)/);
      if (osc7Match) {
        try {
          entry.cwd = decodeURIComponent(osc7Match[1]);
        } catch {
          // ignore malformed URI
        }
      }

      if (hasConnectedClient(entry.sessionId)) {
        broadcast(entry.sessionId, { type: "data", ptyId: msg.ptyId, data });
      } else {
        // Buffer output while client is disconnected
        entry.buffer.push(data);
        entry.bufferSize += data.length;
        // Trim buffer if it exceeds max size (drop oldest chunks)
        while (entry.bufferSize > MAX_BUFFER_SIZE && entry.buffer.length > 0) {
          const removed = entry.buffer.shift()!;
          entry.bufferSize -= removed.length;
        }
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      broadcast(entry.sessionId, {
        type: "exit",
        ptyId: msg.ptyId,
        exitCode,
        signal,
      });
      ptys.delete(msg.ptyId);
    });

    ptys.set(msg.ptyId, entry);

    send(client, {
      type: "spawned",
      id: msg.id,
      ptyId: msg.ptyId,
      pid: proc.pid,
    });
  } catch (err) {
    send(client, {
      type: "error",
      id: msg.id,
      message: `Failed to spawn PTY: ${(err as Error).message}`,
    });
  }
}

function attachPty(msg: ClientMessage & { type: "attach" }, client: ClientConnection): void {
  const entry = ptys.get(msg.ptyId);
  if (!entry) {
    send(client, { type: "error", id: msg.id, message: `PTY ${msg.ptyId} not found` });
    return;
  }

  // Only the owning session can reattach
  if (entry.sessionId !== msg.sessionId) {
    send(client, { type: "error", id: msg.id, message: `PTY ${msg.ptyId} belongs to another session` });
    return;
  }

  // Replay buffered output
  send(client, { type: "replayStart", ptyId: msg.ptyId });
  for (const chunk of entry.buffer) {
    send(client, { type: "data", ptyId: msg.ptyId, data: chunk });
  }
  send(client, { type: "replayEnd", ptyId: msg.ptyId });

  // Clear buffer now that it's been delivered
  entry.buffer.length = 0;
  entry.bufferSize = 0;
}

function listPtys(msg: ClientMessage & { type: "list" }, client: ClientConnection): void {
  const infos: PtyInfo[] = [];
  for (const entry of ptys.values()) {
    if (entry.sessionId === msg.sessionId) {
      infos.push({
        ptyId: entry.ptyId,
        pid: entry.process.pid,
        processName: entry.process.process || "",
        cwd: entry.cwd,
        cols: entry.cols,
        rows: entry.rows,
      });
    }
  }
  send(client, { type: "ptyList", id: msg.id, ptys: infos });
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handleMessage(msg: ClientMessage, client: ClientConnection): void {
  // First message must authenticate with the shared secret
  if (!client.authenticated) {
    if ("sessionId" in msg && (msg as any).secret === secret) {
      client.authenticated = true;
      client.sessionId = msg.sessionId;
      resetInactivityTimer();
    } else {
      send(client, { type: "error", message: "Authentication failed" });
      client.socket.destroy();
      return;
    }
  }

  switch (msg.type) {
    case "spawn":
      spawnPty(msg, client);
      break;

    case "write": {
      const entry = ptys.get(msg.ptyId);
      if (entry) {
        entry.process.write(msg.data);
      }
      break;
    }

    case "resize": {
      const entry = ptys.get(msg.ptyId);
      if (entry) {
        entry.process.resize(msg.cols, msg.rows);
        entry.cols = msg.cols;
        entry.rows = msg.rows;
      }
      break;
    }

    case "kill": {
      const entry = ptys.get(msg.ptyId);
      if (entry) {
        try {
          entry.process.kill();
        } catch {
          // already dead
        }
        ptys.delete(msg.ptyId);
      }
      break;
    }

    case "list":
      listPtys(msg, client);
      break;

    case "attach":
      attachPty(msg, client);
      break;

    case "detach":
      // Client is about to disconnect (extension deactivating).
      // PTYs for this session will start buffering automatically
      // since hasConnectedClient() will return false after disconnect.
      break;

    case "clearBuffer": {
      const entry = ptys.get(msg.ptyId);
      if (entry) {
        entry.buffer.length = 0;
        entry.bufferSize = 0;
      }
      break;
    }

    case "ping":
      send(client, { type: "pong", id: msg.id });
      break;
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

removeStaleSocket(sockPath);

const server = net.createServer((socket) => {
  const client: ClientConnection = {
    socket,
    decoder: new FrameDecoder(),
    sessionId: null,
    authenticated: false,
  };
  clients.add(client);
  resetInactivityTimer();

  socket.on("data", (chunk) => {
    const messages = client.decoder.decode(chunk);
    for (const msg of messages) {
      handleMessage(msg as ClientMessage, client);
    }
  });

  socket.on("close", () => {
    clients.delete(client);
    if (clients.size === 0) {
      resetInactivityTimer();
    }
  });

  socket.on("error", () => {
    clients.delete(client);
    if (clients.size === 0) {
      resetInactivityTimer();
    }
  });
});

server.listen(sockPath, () => {
  // Write lockfile so extension can discover us
  const info: DaemonLockfile = {
    pid: process.pid,
    socketPath: sockPath,
    secret,
    version: "1",
    startedAt: Date.now(),
  };
  writeLockfile(lockPath, info);

  // Lockfile written — parent polls for it to detect readiness.
});

server.on("error", (err) => {
  process.stderr.write(`Daemon server error: ${err.message}\n`);
  shutdown();
});

// Ignore SIGTERM/SIGHUP — VS Code sends these on window close, but the
// daemon must survive. Shutdown happens via inactivity timer or SIGKILL.
process.on("SIGTERM", () => {});
process.on("SIGHUP", () => {});
// SIGINT still shuts down (manual Ctrl+C during development)
process.on("SIGINT", shutdown);

// Start inactivity timer
resetInactivityTimer();
