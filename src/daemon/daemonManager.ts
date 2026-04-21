/**
 * Daemon Manager — handles spawning, discovering, and connecting to
 * the loomptyd daemon process from the extension host.
 *
 * Uses a single global daemon shared by all VS Code windows.
 * Session names (UUIDs) are globally unique so no partitioning is needed.
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
  secretPath,
  generateSecret,
  readLockfile,
  readSecret,
  writeSecret,
  removeLockfile,
  removeSecret,
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

  /**
   * Restart the daemon with a graceful handoff.
   * The old daemon passes its PTY FDs to the new one, so existing
   * shells survive. The client reconnects automatically.
   */
  async restart(): Promise<PtyDaemonClient | null> {
    if (!this._client?.connected) {
      Logger.info("No daemon to restart — starting fresh");
      return this.connect();
    }

    Logger.info("Requesting daemon handoff...");

    try {
      // Send handoff message to old daemon
      await this._client.handoff();
    } catch (err) {
      Logger.warn("Handoff request failed:", err);
    }

    // Old daemon spawns replacement and exits.
    // Disconnect our client (socket will close).
    this._client.disconnect();
    this._client = null;

    // Wait for the new daemon to start (old daemon closes server, spawns
    // replacement, new daemon adopts FDs and starts listening)
    await this._sleep(2000);

    // Connect to the new daemon
    for (let i = 0; i < MAX_CONNECT_ATTEMPTS; i++) {
      Logger.info(`[daemon] Restart reconnect attempt ${i + 1}/${MAX_CONNECT_ATTEMPTS}...`);
      const client = await this._tryConnect();
      if (client) {
        Logger.info("Reconnected to restarted daemon");
        return client;
      }
      Logger.info(`[daemon] Restart reconnect attempt ${i + 1} failed`);
      await this._sleep(RETRY_DELAY_MS);
    }

    Logger.error("Failed to reconnect after daemon restart");
    return null;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Try connecting to an existing daemon via lockfile. */
  private async _tryConnect(): Promise<PtyDaemonClient | null> {
    const lockPath = lockfilePath(GLOBAL_DAEMON_ID);
    const lockInfo = readLockfile(lockPath);
    if (!lockInfo || !isProcessAlive(lockInfo.pid)) {
      Logger.info(`[daemon] _tryConnect: lockInfo=${!!lockInfo} alive=${lockInfo ? isProcessAlive(lockInfo.pid) : "n/a"}`);
      // Clean up stale lockfile
      if (lockInfo) {
        removeLockfile(lockPath);
        removeStaleSocket(lockInfo.socketPath);
      }
      return null;
    }

    const secret = readSecret(secretPath(GLOBAL_DAEMON_ID));
    if (!secret) {
      Logger.info("[daemon] _tryConnect: lockfile exists but no secret file");
      return null;
    }

    try {
      const client = new PtyDaemonClient(this._sessionId, secret);
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
    removeSecret(secretPath(GLOBAL_DAEMON_ID));
    removeStaleSocket(socketPath(GLOBAL_DAEMON_ID));
    return null;
  }

  /** Spawn a new daemon and connect to it. Caller holds the spawn lock. */
  private async _spawnAndConnect(): Promise<PtyDaemonClient | null> {
    const lockPath = lockfilePath(GLOBAL_DAEMON_ID);
    const sockPath = socketPath(GLOBAL_DAEMON_ID);

    // Clean up any leftover state
    removeLockfile(lockPath);
    removeSecret(secretPath(GLOBAL_DAEMON_ID));
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

  /**
   * Spawn the loomptyd daemon binary.
   * loomptyd daemonizes via setsid (no fork), so the spawned process IS
   * the daemon — it keeps running rather than parent-exiting. We detect
   * readiness by polling for the lockfile it writes once the control
   * socket is bound.
   */
  private async _spawnDaemon(lockPath: string, sockPath: string): Promise<string> {
    const secret = generateSecret();
    const binary = await this._findLoomptyd();
    const launcher = path.join(this._extensionPath, "scripts", "spawn-loomptyd.js");

    return new Promise((resolve, reject) => {
      // Route through a short-lived Node launcher that spawns loomptyd
      // and exits. VS Code's ext host tracks child processes by PID and
      // kills them directly on close — which kills loomptyd even with
      // setsid. The launcher breaks this tracking: VS Code only knows
      // about the launcher (which dies immediately), while loomptyd is
      // a grandchild orphaned to launchd.
      const launcherArgs = [launcher, binary, sockPath, secret, lockPath];

      Logger.info(`[daemon] Spawning via launcher: node ${launcherArgs.join(" ")}`);

      const launcherStderr: string[] = [];
      const launcherProc = cp.spawn(process.execPath, launcherArgs, {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env },
      });
      launcherProc.stderr!.on("data", (chunk: Buffer) => {
        launcherStderr.push(chunk.toString());
      });
      launcherProc.unref();

      const readStderr = () => launcherStderr.join("").trim();

      const timeout = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`Daemon startup timed out: ${readStderr()}`));
      }, 10000);

      const poll = setInterval(() => {
        const info = readLockfile(lockPath);
        if (info) {
          writeSecret(secretPath(GLOBAL_DAEMON_ID), secret);
          clearInterval(poll);
          clearTimeout(timeout);
          Logger.info(`[daemon] loomptyd ready, PID ${info.pid}`);
          resolve(secret);
        }
      }, 100);

      // Launcher exits quickly after spawning loomptyd. If it exits
      // non-zero before the lockfile appears, the spawn itself failed.
      launcherProc.on("exit", (code, signal) => {
        if (code !== 0 && code !== null && !readLockfile(lockPath)) {
          clearInterval(poll);
          clearTimeout(timeout);
          reject(new Error(
            `launcher failed (code=${code}, signal=${signal}): ${readStderr()}`,
          ));
        }
      });

      launcherProc.on("error", (err) => {
        clearInterval(poll);
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Find the loomptyd binary.
   * Search order:
   *   1. Extension's bin/ directory (bundled for production)
   *   2. System PATH
   */
  private _findLoomptyd(): Promise<string> {
    return new Promise((resolve, reject) => {
      // Check extension bundle first
      const bundled = path.join(this._extensionPath, "bin", "loomptyd");
      try {
        const stat = require("fs").statSync(bundled);
        if (stat.isFile()) {
          resolve(bundled);
          return;
        }
      } catch {
        // Not bundled — fall through to PATH search
      }

      // Search PATH
      cp.execFile("which", ["loomptyd"], (err, stdout) => {
        if (!err && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(new Error(
            "loomptyd not found. Install it or place it in the extension's bin/ directory. " +
            "Build from: https://github.com/twilightcoders/loompty",
          ));
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
