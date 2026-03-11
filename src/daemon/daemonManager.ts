/**
 * Daemon Manager — handles spawning, discovering, and connecting to
 * the PTY daemon process from the extension host.
 *
 * Uses a single global daemon shared by all VS Code windows.
 * Session IDs partition PTYs so each window only sees its own.
 * Spawn lock (O_EXCL) prevents races when multiple windows activate
 * simultaneously after a reboot.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import { Logger } from "../utils/logger";
import { PtyDaemonClient } from "./ptyDaemonClient";
import {
  lockfilePath,
  socketPath,
  generateSecret,
  readLockfile,
  removeLockfile,
  removeStaleSocket,
  isProcessAlive,
  acquireSpawnLock,
  releaseSpawnLock,
  isSpawnLockStale,
} from "./lockfile";

/** Fixed identifier — all windows share one daemon. */
const GLOBAL_DAEMON_ID = "global";

/** Max attempts to connect (covers the case where another window is spawning). */
const MAX_CONNECT_ATTEMPTS = 5;

/** Delay between retry attempts (ms). */
const RETRY_DELAY_MS = 500;

export class DaemonManager {
  private _client: PtyDaemonClient | null = null;
  private _sessionId: string;
  private _extensionPath: string;

  constructor(
    context: vscode.ExtensionContext,
    extensionPath: string,
  ) {
    this._extensionPath = extensionPath;

    // Restore or generate session ID (unique per window, persists across reloads)
    const savedSessionId = context.workspaceState.get<string>("alterminal.sessionId");
    if (savedSessionId) {
      this._sessionId = savedSessionId;
    } else {
      this._sessionId = this._generateSessionId();
      context.workspaceState.update("alterminal.sessionId", this._sessionId);
    }
  }

  get client(): PtyDaemonClient | null {
    return this._client;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get connected(): boolean {
    return this._client?.connected ?? false;
  }

  /**
   * Connect to the global daemon, spawning it if necessary.
   * Handles the race condition where multiple windows activate simultaneously
   * by using an atomic spawn lock with retry.
   */
  async connect(): Promise<PtyDaemonClient | null> {
    for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
      // Try connecting to an existing daemon
      const client = await this._tryConnect();
      if (client) {
        return client;
      }

      // No daemon running. Try to acquire the spawn lock.
      if (acquireSpawnLock(GLOBAL_DAEMON_ID)) {
        try {
          return await this._spawnAndConnect();
        } finally {
          releaseSpawnLock(GLOBAL_DAEMON_ID);
        }
      }

      // Another window is spawning. If the lock is stale (>15s), break it.
      if (isSpawnLockStale(GLOBAL_DAEMON_ID)) {
        Logger.warn("Stale spawn lock detected, breaking it");
        releaseSpawnLock(GLOBAL_DAEMON_ID);
        continue;
      }

      // Wait for the other window to finish spawning
      Logger.info(`Daemon spawn in progress by another window, waiting (attempt ${attempt}/${MAX_CONNECT_ATTEMPTS})`);
      await this._sleep(RETRY_DELAY_MS);
    }

    Logger.error("Failed to connect to PTY daemon after all attempts");
    return null;
  }

  /** Gracefully disconnect from the daemon (on deactivate). */
  disconnect(): void {
    if (this._client) {
      this._client.disconnect();
      this._client = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Try connecting to an existing daemon via lockfile. */
  private async _tryConnect(): Promise<PtyDaemonClient | null> {
    const lockPath = lockfilePath(GLOBAL_DAEMON_ID);
    const lockInfo = readLockfile(lockPath);
    if (!lockInfo || !isProcessAlive(lockInfo.pid)) {
      // Clean up stale lockfile
      if (lockInfo) {
        removeLockfile(lockPath);
        removeStaleSocket(lockInfo.socketPath);
      }
      return null;
    }

    try {
      const client = new PtyDaemonClient(this._sessionId, lockInfo.secret);
      await client.connect(lockInfo.socketPath);
      const alive = await client.ping();
      if (alive) {
        this._client = client;
        this._setupDisconnectHandler(client);
        Logger.info(`Connected to PTY daemon (PID ${lockInfo.pid})`);
        return client;
      }
      client.disconnect();
    } catch {
      // Socket exists but unreachable — daemon may be dead
      Logger.info("Daemon socket unreachable");
    }

    // Clean up after failed connection
    removeLockfile(lockPath);
    removeStaleSocket(socketPath(GLOBAL_DAEMON_ID));
    return null;
  }

  /** Spawn a new daemon and connect to it. Caller holds the spawn lock. */
  private async _spawnAndConnect(): Promise<PtyDaemonClient | null> {
    const lockPath = lockfilePath(GLOBAL_DAEMON_ID);
    const sockPath = socketPath(GLOBAL_DAEMON_ID);

    // Clean up any leftover state
    removeLockfile(lockPath);
    removeStaleSocket(sockPath);

    try {
      const daemonSecret = await this._spawnDaemon(lockPath, sockPath);
      const client = new PtyDaemonClient(this._sessionId, daemonSecret);
      await client.connect(sockPath);
      this._client = client;
      this._setupDisconnectHandler(client);
      Logger.info("Spawned and connected to new PTY daemon");
      return client;
    } catch (err) {
      Logger.error("Failed to spawn PTY daemon:", err);
      return null;
    }
  }

  private _setupDisconnectHandler(client: PtyDaemonClient): void {
    client.on("disconnected", () => {
      Logger.warn("Lost connection to PTY daemon");
      if (this._client === client) {
        this._client = null;
      }
    });
  }

  private async _spawnDaemon(lockPath: string, sockPath: string): Promise<string> {
    const secret = generateSecret();
    const daemonScript = path.join(this._extensionPath, "out", "daemon", "ptyDaemon.js");

    // Use system node (not process.execPath which is the Electron binary).
    // VS Code kills processes launched via its own binary on window close.
    // Spawned detached with stdio:ignore so the daemon is fully independent.
    const nodeBin = await this._findNode();

    return new Promise((resolve, reject) => {
      const child = cp.spawn(nodeBin, [daemonScript, lockPath, sockPath, secret], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      });

      // Fully detach — daemon must survive extension host restarts
      child.unref();

      const timeout = setTimeout(() => {
        reject(new Error("Daemon startup timed out"));
        try { child.kill(); } catch {}
      }, 10000);

      // Poll for lockfile to appear (daemon writes it when server is ready)
      const pollInterval = 100;
      const poll = setInterval(() => {
        const info = readLockfile(lockPath);
        if (info && info.secret === secret) {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve(secret);
        }
      }, pollInterval);

      child.on("error", (err) => {
        clearInterval(poll);
        clearTimeout(timeout);
        reject(err);
      });

      child.on("exit", (code) => {
        clearInterval(poll);
        clearTimeout(timeout);
        if (code !== null && code !== 0) {
          reject(new Error(`Daemon exited with code ${code}`));
        }
      });
    });
  }

  /** Find the system node binary. Falls back to process.execPath (Electron). */
  private _findNode(): Promise<string> {
    return new Promise((resolve) => {
      cp.execFile("which", ["node"], (err, stdout) => {
        if (!err && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          // Fallback: use Electron binary (may not survive window close)
          Logger.warn("[daemon] System node not found, falling back to process.execPath");
          resolve(process.execPath);
        }
      });
    });
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private _generateSessionId(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    for (let i = 0; i < 16; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }
}
