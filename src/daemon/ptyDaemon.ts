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
import * as path from "path";
import * as os from "os";
import { execFileSync, spawn as cpSpawn } from "child_process";
import * as pty from "@lydell/node-pty";
import {
  type ClientMessage,
  type DaemonMessage,
  type DaemonLockfile,
  type HandoffState,
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
  process: pty.IPty | null; // null for adopted PTYs
  buffer: string[];
  bufferSize: number;
  cwd: string;
  cols: number;
  rows: number;
  // Adopted PTY fields (set when process is null)
  adopted?: {
    masterFd: number;
    slavePath: string;
    pid: number;
    reader: net.Socket;
    exitPollTimer: ReturnType<typeof setInterval>;
  };
}

/** Starting FD index for inherited PTY masters in handoff. */
const HANDOFF_FD_START = 3;

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

const [, , lockPath, sockPath, secret, ...extraArgs] = process.argv;
if (!lockPath || !sockPath || !secret) {
  process.stderr.write("Usage: node ptyDaemon.js <lockfilePath> <socketPath> <secret> [--adopt <stateFile>]\n");
  process.exit(1);
}

// Check for --adopt flag (hot restart with inherited FDs)
const adoptIndex = extraArgs.indexOf("--adopt");
const adoptStateFile = adoptIndex >= 0 ? extraArgs[adoptIndex + 1] : null;

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
    if (entry.process) {
      try { entry.process.kill(); } catch { /* already dead */ }
    } else if (entry.adopted) {
      try { process.kill(entry.adopted.pid, "SIGTERM"); } catch { /* already dead */ }
      entry.adopted.reader.destroy();
      clearInterval(entry.adopted.exitPollTimer);
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
    const errMsg = `Failed to spawn PTY: ${(err as Error).message}`;
    process.stderr.write(`[daemon] ${errMsg}\n`);
    send(client, {
      type: "error",
      id: msg.id,
      message: errMsg,
    });
  }
}

function attachPty(msg: ClientMessage & { type: "attach" }, client: ClientConnection): void {
  const entry = ptys.get(msg.ptyId);
  if (!entry) {
    send(client, { type: "error", id: msg.id, message: `PTY ${msg.ptyId} not found` });
    return;
  }

  // Reassign to the requesting session (session IDs change across reboots,
  // but UUIDs are the true PTY identity).
  if (entry.sessionId !== msg.sessionId) {
    entry.sessionId = msg.sessionId;
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
    // Return all PTYs — UUIDs are globally unique, so the client
    // can match by ptyId regardless of session. Session IDs change
    // across reboots but UUIDs persist in workspaceState.
    const pid = entry.process?.pid ?? entry.adopted?.pid ?? 0;
    const processName = entry.process?.process || "";
    infos.push({
      ptyId: entry.ptyId,
      pid,
      processName,
      cwd: entry.cwd,
      cols: entry.cols,
      rows: entry.rows,
    });
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
      writeToPty(msg.ptyId, msg.data);
      break;
    }

    case "resize": {
      resizePty(msg.ptyId, msg.cols, msg.rows);
      break;
    }

    case "kill":
      killPty(msg.ptyId);
      break;

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

    case "handoff":
      handleHandoff(msg, client);
      break;
  }
}

// ---------------------------------------------------------------------------
// Handoff — graceful daemon restart with PTY FD inheritance
// ---------------------------------------------------------------------------

/**
 * Handle a handoff request: serialize PTY state, spawn a new daemon that
 * inherits the master FDs, then shut down this process.
 */
function handleHandoff(msg: ClientMessage & { type: "handoff" }, client: ClientConnection): void {
  const entries = Array.from(ptys.values());

  if (entries.length === 0) {
    send(client, { type: "pong", id: msg.id }); // ACK with empty handoff
    // No PTYs to hand off — just shut down so a fresh daemon can start
    server.close();
    removeLockfile(lockPath);
    removeStaleSocket(sockPath);
    process.exit(0);
  }

  // Build handoff state and collect master FDs
  const masterFds: number[] = [];
  const state: HandoffState = { ptys: [] };

  for (const entry of entries) {
    let masterFd: number;
    let slavePath: string;

    if (entry.adopted) {
      masterFd = entry.adopted.masterFd;
      slavePath = entry.adopted.slavePath;
    } else if (entry.process) {
      masterFd = (entry.process as any)._fd;
      slavePath = (entry.process as any)._pty || "";
    } else {
      continue; // skip entries with no FD
    }

    state.ptys.push({
      ptyId: entry.ptyId,
      sessionId: entry.sessionId,
      pid: entry.adopted?.pid ?? entry.process?.pid ?? 0,
      slavePath,
      cwd: entry.cwd,
      cols: entry.cols,
      rows: entry.rows,
      buffer: entry.buffer,
      fdIndex: masterFds.length,
    });
    masterFds.push(masterFd);
  }

  // Write state to temp file
  const stateFile = path.join(os.tmpdir(), `alterminal-handoff-${process.pid}.json`);
  fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });

  // Build stdio array: [ignore, ignore, ignore, ...masterFds]
  const stdio: Array<"ignore" | number> = ["ignore", "ignore", "ignore"];
  for (const fd of masterFds) {
    stdio.push(fd);
  }

  // ACK the handoff before shutting down
  send(client, { type: "pong", id: msg.id });

  // Disconnect all clients gracefully
  for (const c of clients) {
    try { c.socket.end(); } catch { /* ignore */ }
  }

  // Detach our onData/onExit listeners so PTY processes aren't affected
  for (const entry of entries) {
    if (entry.adopted?.reader) {
      entry.adopted.reader.destroy();
      clearInterval(entry.adopted.exitPollTimer);
    }
  }

  // Close server and remove socket BEFORE spawning replacement,
  // so the new daemon can bind to the same socket path.
  server.close(() => {
    removeStaleSocket(sockPath);

    // Spawn replacement daemon with inherited FDs
    const daemonScript = process.argv[1];
    const child = cpSpawn(
      process.execPath,
      [daemonScript, lockPath, sockPath, secret, "--adopt", stateFile],
      { detached: true, stdio },
    );
    child.unref();

    // Exit after a brief delay to let the spawn complete
    setTimeout(() => process.exit(0), 200);
  });
}

/**
 * Adopt PTYs from a handoff state file. Called when the daemon starts
 * with --adopt <stateFile>. Inherited FDs start at index HANDOFF_FD_START (3).
 */
function adoptFromHandoff(stateFile: string): void {
  let state: HandoffState;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    fs.unlinkSync(stateFile); // clean up
  } catch (err) {
    process.stderr.write(`Failed to read handoff state: ${(err as Error).message}\n`);
    return;
  }

  for (const ptyState of state.ptys) {
    const masterFd = HANDOFF_FD_START + ptyState.fdIndex;

    // Verify the FD is alive
    try {
      fs.fstatSync(masterFd);
    } catch {
      process.stderr.write(`Handoff: FD ${masterFd} for ${ptyState.ptyId} is invalid, skipping\n`);
      continue;
    }

    // Create a readable stream from the master FD
    const reader = new net.Socket({ fd: masterFd, readable: true, writable: false });

    // Poll for child process exit (since we don't have node-pty's native watcher)
    const exitPollTimer = setInterval(() => {
      try {
        process.kill(ptyState.pid, 0); // test if alive
      } catch {
        // Process exited
        clearInterval(exitPollTimer);
        reader.destroy();
        broadcast(ptyState.sessionId, {
          type: "exit",
          ptyId: ptyState.ptyId,
          exitCode: -1,
          signal: 0,
        });
        ptys.delete(ptyState.ptyId);
      }
    }, 1000);
    exitPollTimer.unref();

    const entry: PtyEntry = {
      ptyId: ptyState.ptyId,
      sessionId: ptyState.sessionId,
      process: null,
      buffer: ptyState.buffer || [],
      bufferSize: (ptyState.buffer || []).reduce((sum, s) => sum + s.length, 0),
      cwd: ptyState.cwd,
      cols: ptyState.cols,
      rows: ptyState.rows,
      adopted: {
        masterFd,
        slavePath: ptyState.slavePath,
        pid: ptyState.pid,
        reader,
        exitPollTimer,
      },
    };

    // Read PTY output
    reader.on("data", (data: Buffer) => {
      const str = data.toString("utf-8");

      // Extract CWD from OSC 7 if present
      const osc7Match = str.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)/);
      if (osc7Match) {
        try {
          entry.cwd = decodeURIComponent(osc7Match[1]);
        } catch { /* ignore */ }
      }

      if (hasConnectedClient(entry.sessionId)) {
        broadcast(entry.sessionId, { type: "data", ptyId: entry.ptyId, data: str });
      } else {
        entry.buffer.push(str);
        entry.bufferSize += str.length;
        while (entry.bufferSize > MAX_BUFFER_SIZE && entry.buffer.length > 0) {
          const removed = entry.buffer.shift()!;
          entry.bufferSize -= removed.length;
        }
      }
    });

    reader.on("error", () => {
      // FD closed or PTY died
      clearInterval(exitPollTimer);
      ptys.delete(entry.ptyId);
    });

    ptys.set(ptyState.ptyId, entry);
    process.stderr.write(`Handoff: adopted PTY ${ptyState.ptyId} (pid ${ptyState.pid}, fd ${masterFd})\n`);
  }
}

// ---------------------------------------------------------------------------
// Update write/resize/kill to handle adopted PTYs
// ---------------------------------------------------------------------------

function writeToPty(ptyId: string, data: string): void {
  const entry = ptys.get(ptyId);
  if (!entry) return;

  if (entry.process) {
    entry.process.write(data);
  } else if (entry.adopted) {
    try {
      fs.writeSync(entry.adopted.masterFd, data);
    } catch { /* FD may have closed */ }
  }
}

function resizePty(ptyId: string, cols: number, rows: number): void {
  const entry = ptys.get(ptyId);
  if (!entry) return;

  entry.cols = cols;
  entry.rows = rows;

  if (entry.process) {
    entry.process.resize(cols, rows);
  } else if (entry.adopted) {
    // Use stty on the slave PTY to set dimensions
    try {
      const fd = fs.openSync(entry.adopted.slavePath, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
      try {
        execFileSync("stty", ["rows", String(rows), "cols", String(cols)], {
          stdio: [fd, "pipe", "pipe"],
        });
        // Send SIGWINCH to the child process
        process.kill(entry.adopted.pid, "SIGWINCH");
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* stty failed or process dead */ }
  }
}

function killPty(ptyId: string): void {
  const entry = ptys.get(ptyId);
  if (!entry) return;

  if (entry.process) {
    try { entry.process.kill(); } catch { /* already dead */ }
  } else if (entry.adopted) {
    try { process.kill(entry.adopted.pid, "SIGTERM"); } catch { /* already dead */ }
    entry.adopted.reader.destroy();
    clearInterval(entry.adopted.exitPollTimer);
  }
  ptys.delete(ptyId);
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

  // If started with --adopt, inherit PTYs from the previous daemon
  if (adoptStateFile) {
    adoptFromHandoff(adoptStateFile);
  }

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
