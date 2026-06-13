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
import * as fs from "fs";
import { Logger } from "../utils/logger";
import { PtyDaemonClient } from "./ptyDaemonClient";
import {
  pidfilePath,
  socketPath,
  secretPath,
  logPath,
  generateSecret,
  readPidfile,
  readSecret,
  writeSecret,
  removePidfile,
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
  // Set true immediately before a disconnect WE initiate (dispose, or the
  // old client during a restart), so the disconnect handler knows not to
  // treat it as a daemon death and auto-reconnect. Consumed on each fire.
  private _intentionalDisconnect = false;
  /**
   * Called after an UNEXPECTED daemon disconnect is recovered by
   * reconnecting to the (new) daemon. The extension wires this to
   * re-point PtyManager at the new client and reattach live sessions —
   * this is what lets every window independently survive another window
   * restarting the shared daemon.
   */
  public onReconnected?: (client: PtyDaemonClient) => void;

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
      this._intentionalDisconnect = true;
      this._client.disconnect();
      this._client = null;
    }
  }

  /**
   * Zero-downtime daemon restart via loompty's SCM_RIGHTS handoff
   * (PROTOCOL §4.11/§6, Layer 1 `--handoff-listen`):
   *
   *   1. Spawn a successor daemon that listens on a handoff socket
   *      (`--handoff-listen <path>`), reusing the canonical control
   *      socket / lockfile / secret. It writes `<path>.ready` after
   *      `listen()`.
   *   2. Tell the old daemon to hand off to that socket. It connects,
   *      transfers session metadata + PTY master fds (SCM_RIGHTS) directly
   *      to the successor, then shuts down — releasing the control socket.
   *   3. The successor adopts the sessions and rebinds the control socket.
   *   4. We poll the control socket until the successor answers, then
   *      reconnect. Shells survive untouched (same PTY fds, new daemon).
   *
   * Abort-safe: a failed handoff leaves the old daemon running, so we just
   * reconnect to it. No daemon → spawn fresh.
   */
  async restart(): Promise<PtyDaemonClient | null> {
    if (!this._client?.connected) {
      return (await this._tryConnect()) ?? this.connect();
    }

    const sockPath = socketPath(GLOBAL_DAEMON_ID);
    const secret = readSecret(secretPath(GLOBAL_DAEMON_ID));
    if (!secret) {
      Logger.warn("[daemon] no secret on file — cannot hand off; staying on current daemon");
      return this._client;
    }

    const handoffPath = path.join(
      path.dirname(sockPath),
      `alterminal-handoff-${GLOBAL_DAEMON_ID}-${Date.now()}.sock`,
    );
    const readyMarker = `${handoffPath}.ready`;
    const oldClient = this._client;

    try {
      Logger.info("[daemon] starting zero-downtime handoff...");
      // 1. Bring up the successor listening on the handoff socket.
      await this._spawnSuccessorForHandoff(sockPath, secret, handoffPath);

      // 2. Tell the old daemon to transfer its sessions to the successor.
      //    Fire-and-forget: on success it shuts down silently. Mark our own
      //    disconnect intentional so the auto-reconnect handler stays out of
      //    the way — restart() does its own reconnect+reattach below.
      oldClient.handoff(handoffPath);
      this._intentionalDisconnect = true;
      oldClient.disconnect();
      this._client = null;

      // 3+4. Poll the canonical control socket until the successor (which
      //      rebinds after adoption) answers, then reconnect.
      for (let i = 0; i < MAX_CONNECT_ATTEMPTS * 3; i++) {
        await this._sleep(RETRY_DELAY_MS);
        const client = await this._tryConnect();
        if (client) {
          Logger.info("[daemon] handoff complete — reconnected to successor, sessions preserved");
          return client;
        }
      }
      Logger.error("[daemon] handoff: no daemon answered the control socket after handoff");
      return null;
    } catch (err) {
      // Abort-safe: the old daemon kept running. Reconnect to it.
      Logger.warn(`[daemon] handoff aborted (${(err as Error)?.message || err}); old daemon still running`);
      return (await this._tryConnect()) ?? this.connect();
    } finally {
      try { fs.rmSync(readyMarker, { force: true }); } catch { /* best effort */ }
      try { fs.rmSync(handoffPath, { force: true }); } catch { /* best effort */ }
    }
  }

  /**
   * Spawn a successor daemon in `--handoff-listen` mode (reusing the
   * canonical control socket / lockfile / secret) and resolve once it has
   * written its post-`listen()` ready marker. Rejects on timeout.
   */
  private async _spawnSuccessorForHandoff(
    sockPath: string,
    secret: string,
    handoffPath: string,
  ): Promise<void> {
    const binary = await this._findLoomptyd();
    const launcher = path.join(this._extensionPath, "scripts", "spawn-loomptyd.js");
    const readyMarker = `${handoffPath}.ready`;

    // Clear any stale marker/socket from a prior aborted attempt.
    try { fs.rmSync(readyMarker, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(handoffPath, { force: true }); } catch { /* ignore */ }

    return new Promise((resolve, reject) => {
      // The launcher appends trailing args to loomptyd's argv, so
      // --handoff-listen and --log ride through unchanged. The successor
      // logs to the SAME canonical path as its predecessor (O_APPEND), so
      // the handoff shows up as one continuous timeline.
      const launcherArgs = [
        launcher, binary, sockPath, secret,
        "--log", logPath(GLOBAL_DAEMON_ID),
        "--handoff-listen", handoffPath,
      ];
      const stderr: string[] = [];
      const proc = cp.spawn(process.execPath, launcherArgs, {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env },
      });
      proc.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
      proc.unref();

      const timeout = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`successor not listening on handoff socket: ${stderr.join("").trim()}`));
      }, 10000);

      const poll = setInterval(() => {
        if (fs.existsSync(readyMarker)) {
          clearInterval(poll);
          clearTimeout(timeout);
          Logger.info("[daemon] successor is listening on the handoff socket");
          resolve();
        }
      }, 100);

      proc.on("error", (err) => {
        clearInterval(poll);
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Try connecting to an existing daemon, discovered via its `<socket>.pid` pidfile. */
  private async _tryConnect(): Promise<PtyDaemonClient | null> {
    const sockPath = socketPath(GLOBAL_DAEMON_ID);
    const pidPath = pidfilePath(GLOBAL_DAEMON_ID);
    const pid = readPidfile(pidPath);
    if (!pid || !isProcessAlive(pid)) {
      Logger.info(`[daemon] _tryConnect: pid=${pid ?? "none"} alive=${pid ? isProcessAlive(pid) : "n/a"}`);
      // Stale pidfile from a crashed daemon — clean it (and the dead socket) up.
      if (pid) {
        removePidfile(pidPath);
        removeStaleSocket(sockPath);
      }
      return null;
    }

    const secret = readSecret(secretPath(GLOBAL_DAEMON_ID));
    if (!secret) {
      Logger.info("[daemon] _tryConnect: pidfile exists but no secret file");
      return null;
    }

    try {
      const client = new PtyDaemonClient(this._sessionId, secret);
      await client.connect(sockPath);
      const alive = await client.ping();
      if (alive) {
        this._client = client;
        this._setupDisconnectHandler(client);
        Logger.info(`Connected to PTY daemon (PID ${pid})`);
        return client;
      }
      client.disconnect();
    } catch {
      // Socket exists but unreachable — daemon may be dead
      Logger.info("Daemon socket unreachable");
    }

    // Clean up after failed connection
    removePidfile(pidPath);
    removeSecret(secretPath(GLOBAL_DAEMON_ID));
    removeStaleSocket(sockPath);
    return null;
  }

  /** Spawn a new daemon and connect to it. Caller holds the spawn lock. */
  private async _spawnAndConnect(): Promise<PtyDaemonClient | null> {
    const sockPath = socketPath(GLOBAL_DAEMON_ID);

    // Clean up any leftover state
    removePidfile(pidfilePath(GLOBAL_DAEMON_ID));
    removeSecret(secretPath(GLOBAL_DAEMON_ID));
    removeStaleSocket(sockPath);

    try {
      const daemonSecret = await this._spawnDaemon(sockPath);
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
      if (this._client === client) {
        this._client = null;
      }
      // An intentional disconnect (dispose, or the old client during our own
      // restart) is consumed here and ignored — no auto-reconnect.
      if (this._intentionalDisconnect) {
        this._intentionalDisconnect = false;
        Logger.info("[daemon] intentional disconnect — not reconnecting");
        return;
      }
      // Unexpected: the daemon went away (crash, or ANOTHER window restarted
      // the shared daemon). Reconnect to whatever now serves the canonical
      // socket (the successor) and reattach our live sessions. This is how a
      // restart triggered in one window is survived by every other window.
      Logger.warn("[daemon] unexpected daemon disconnect — reconnecting + reattaching");
      void this._reconnectAndReattach();
    });
  }

  /**
   * Recover from an unexpected daemon disconnect: poll the canonical control
   * socket until the (successor) daemon answers, then hand the new client to
   * the extension so it re-points PtyManager and reattaches live sessions.
   */
  private async _reconnectAndReattach(): Promise<void> {
    for (let i = 0; i < MAX_CONNECT_ATTEMPTS * 4; i++) {
      await this._sleep(RETRY_DELAY_MS);
      const client = await this._tryConnect();
      if (client) {
        Logger.info("[daemon] reconnected after unexpected disconnect — reattaching sessions");
        this.onReconnected?.(client);
        return;
      }
    }
    Logger.error("[daemon] could not reconnect after unexpected daemon disconnect");
  }

  /**
   * Spawn the loomptyd daemon binary.
   * loomptyd daemonizes via setsid (no fork), so the spawned process IS
   * the daemon — it keeps running rather than parent-exiting. We detect
   * readiness by polling for the `<socket>.pid` pidfile it writes once the
   * control socket is bound.
   */
  private async _spawnDaemon(sockPath: string): Promise<string> {
    const secret = generateSecret();
    const binary = await this._findLoomptyd();
    const launcher = path.join(this._extensionPath, "scripts", "spawn-loomptyd.js");
    const pidPath = pidfilePath(GLOBAL_DAEMON_ID);

    return new Promise((resolve, reject) => {
      // Route through a short-lived Node launcher that spawns loomptyd
      // and exits. VS Code's ext host tracks child processes by PID and
      // kills them directly on close — which kills loomptyd even with
      // setsid. The launcher breaks this tracking: VS Code only knows
      // about the launcher (which dies immediately), while loomptyd is
      // a grandchild orphaned to launchd. loomptyd auto-derives its
      // pidfile from --socket (<socket>.pid), so no lockfile arg is passed.
      const launcherArgs = [
        launcher, binary, sockPath, secret,
        "--log", logPath(GLOBAL_DAEMON_ID),
      ];

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
        const pid = readPidfile(pidPath);
        if (pid) {
          writeSecret(secretPath(GLOBAL_DAEMON_ID), secret);
          clearInterval(poll);
          clearTimeout(timeout);
          Logger.info(`[daemon] loomptyd ready, PID ${pid}`);
          resolve(secret);
        }
      }, 100);

      // Launcher exits quickly after spawning loomptyd. If it exits
      // non-zero before the pidfile appears, the spawn itself failed.
      launcherProc.on("exit", (code, signal) => {
        if (code !== 0 && code !== null && !readPidfile(pidPath)) {
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
      // Check the extension bundle first. Releases vendor a platform-specific
      // binary (bin/loomptyd-<platform>-<arch>); local dev builds drop a
      // generic bin/loomptyd via scripts/build-daemon.sh. Prefer the former.
      const binDir = path.join(this._extensionPath, "bin");
      const bundledCandidates = [
        path.join(binDir, `loomptyd-${process.platform}-${process.arch}`),
        path.join(binDir, "loomptyd"),
      ];
      for (const candidate of bundledCandidates) {
        try {
          if (require("fs").statSync(candidate).isFile()) {
            resolve(candidate);
            return;
          }
        } catch {
          // Try the next candidate, then fall through to PATH search.
        }
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
