/**
 * Lockfile utilities for daemon discovery.
 *
 * The lockfile is a JSON file at a deterministic path per workspace,
 * containing the daemon's PID, socket path, and version.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DaemonLockfile } from "./protocol";

/**
 * Derive a deterministic short hash from workspace folder URIs.
 * Multiple windows for the same workspace will compute the same hash.
 */
export function workspaceHash(workspaceFolders: string[]): string {
  const key = workspaceFolders.slice().sort().join("\0");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** Directory for lockfiles and sockets. */
function runtimeDir(): string {
  return process.env.XDG_RUNTIME_DIR || os.tmpdir();
}

/** Lockfile path for a given workspace hash. */
export function lockfilePath(wsHash: string): string {
  return path.join(runtimeDir(), `alterminal-daemon-${wsHash}.json`);
}

/** Socket path for a given workspace hash. */
export function socketPath(wsHash: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\alterminal-${wsHash}`;
  }
  return path.join(runtimeDir(), `alterminal-${wsHash}.sock`);
}

/** Generate a random shared secret for client authentication. */
export function generateSecret(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** Write the lockfile atomically with restricted permissions (owner-only). */
export function writeLockfile(lockPath: string, info: DaemonLockfile): void {
  const tmp = lockPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, lockPath);
}

/** Read and parse the lockfile, returning null if missing or corrupt. */
export function readLockfile(lockPath: string): DaemonLockfile | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const data = JSON.parse(raw);
    if (!data.pid || !data.socketPath) {
      return null;
    }
    return data as DaemonLockfile;
  } catch {
    return null;
  }
}

/** Path to the secret credential file (sibling of the lockfile). */
export function secretPath(wsHash: string): string {
  return path.join(runtimeDir(), `alterminal-daemon-${wsHash}.secret`);
}

/** Write the daemon secret atomically with owner-only permissions. */
export function writeSecret(secretFilePath: string, secret: string): void {
  const tmp = secretFilePath + ".tmp";
  fs.writeFileSync(tmp, secret, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, secretFilePath);
}

/** Read the daemon secret, returning null if missing. */
export function readSecret(secretFilePath: string): string | null {
  try {
    return fs.readFileSync(secretFilePath, "utf8").trim();
  } catch {
    return null;
  }
}

/** Delete the secret file. */
export function removeSecret(secretFilePath: string): void {
  try {
    fs.unlinkSync(secretFilePath);
  } catch {
    // already gone
  }
}

/** Delete the lockfile. */
export function removeLockfile(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone
  }
}

/**
 * Atomically create a spawn lock file. Returns true if this process
 * won the race (created the file), false if another process already has it.
 * Uses O_EXCL for atomic create-if-not-exists.
 */
export function acquireSpawnLock(wsHash: string): boolean {
  const lockPath = path.join(runtimeDir(), `alterminal-spawn-${wsHash}.lock`);
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** Release the spawn lock file. */
export function releaseSpawnLock(wsHash: string): void {
  const lockPath = path.join(runtimeDir(), `alterminal-spawn-${wsHash}.lock`);
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone
  }
}

/** Check if spawn lock is stale (older than maxAge ms). */
export function isSpawnLockStale(wsHash: string, maxAgeMs = 30000): boolean {
  const lockPath = path.join(runtimeDir(), `alterminal-spawn-${wsHash}.lock`);
  try {
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > maxAgeMs;
  } catch {
    return true; // doesn't exist = stale
  }
}

/** Check whether a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Clean up a stale Unix socket file if it exists. */
export function removeStaleSocket(sockPath: string): void {
  if (process.platform === "win32") {
    return; // named pipes don't leave files
  }
  try {
    fs.unlinkSync(sockPath);
  } catch {
    // already gone
  }
}
