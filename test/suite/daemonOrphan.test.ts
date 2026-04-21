import * as assert from "assert";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PtyDaemonClient } from "../../src/daemon/ptyDaemonClient";
import { readLockfile } from "../../src/daemon/lockfile";

/**
 * Orphan-daemon scenarios.
 *
 * Reproduces the failure mode Dale hit live: an orphan daemon from a
 * previous session is running, but the secret file is missing. Our
 * DaemonManager can't auth to it, and needs to clean up and spawn fresh
 * — without taking down the orphan or losing our new spawn in the process.
 */

const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const LOOMPTYD = path.join(PROJECT_ROOT, "bin/loomptyd");

function uniquePaths() {
  const id = `test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const dir = os.tmpdir();
  return {
    socket:   path.join(dir, `alterm-${id}.sock`),
    lockfile: path.join(dir, `alterm-${id}.json`),
    log:      path.join(dir, `alterm-${id}.log`),
  };
}

function spawnRaw(paths: ReturnType<typeof uniquePaths>, secret: string): Promise<number> {
  const child = cp.spawn(LOOMPTYD, [
    "--socket", paths.socket,
    "--secret", secret,
    "--lockfile", paths.lockfile,
    "--log", paths.log,
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.resume();
  child.stderr!.resume();
  child.unref();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("daemon startup timed out"));
    }, 5000);
    const poll = setInterval(() => {
      const info = readLockfile(paths.lockfile);
      if (info) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(info.pid);
      }
    }, 50);
  });
}

function killPid(pid: number) { try { process.kill(pid, "SIGTERM"); } catch {} }
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function cleanupPaths(paths: ReturnType<typeof uniquePaths>) {
  for (const p of Object.values(paths)) {
    try { fs.unlinkSync(p); } catch {}
  }
}

suite("Orphan Daemon Scenarios", () => {

  test("unlinking socket file does not kill a listening daemon", async function () {
    this.timeout(10000);
    const paths = uniquePaths();
    const pid = await spawnRaw(paths, "first-secret");

    try {
      assert.ok(isAlive(pid), "daemon should be alive");

      // Simulate DaemonManager's cleanup: remove the socket file
      fs.unlinkSync(paths.socket);

      // Give the daemon a moment to react (it shouldn't)
      await sleep(300);
      assert.ok(isAlive(pid), "daemon should survive its socket file being unlinked");
    } finally {
      killPid(pid);
      await sleep(200);
      cleanupPaths(paths);
    }
  });

  test("binding a second daemon to same path after unlink: both survive", async function () {
    this.timeout(10000);
    const paths = uniquePaths();
    const firstPid = await spawnRaw(paths, "first-secret");

    try {
      // Simulate what _spawnAndConnect does: remove all state files
      fs.unlinkSync(paths.lockfile);
      try { fs.unlinkSync(paths.socket); } catch {}

      // Spawn a second daemon at the same socket path
      const secondPid = await spawnRaw(paths, "second-secret");

      await sleep(300);

      // Both should still be alive
      assert.ok(isAlive(firstPid), `first daemon (PID ${firstPid}) should survive`);
      assert.ok(isAlive(secondPid), `second daemon (PID ${secondPid}) should be alive`);
      assert.notStrictEqual(firstPid, secondPid, "pids should differ");

      // The lockfile should reflect the newer daemon
      const info = readLockfile(paths.lockfile);
      assert.strictEqual(info?.pid, secondPid, "lockfile points to the new daemon");

      // Connection to the socket path goes to the new daemon (most recent bind)
      const client = new PtyDaemonClient("s", "second-secret");
      await client.connect(paths.socket);
      assert.strictEqual(client.connected, true);
      client.disconnect();
    } finally {
      killPid(firstPid);
      // The second pid is whatever readLockfile says — kill that too
      const info = readLockfile(paths.lockfile);
      if (info?.pid && info.pid !== firstPid) killPid(info.pid);
      await sleep(200);
      cleanupPaths(paths);
    }
  });

  test("client attempting wrong-secret auth to orphan does not kill it", async function () {
    this.timeout(10000);
    const paths = uniquePaths();
    const pid = await spawnRaw(paths, "real-secret");

    try {
      // Client tries auth with wrong secret (simulates reading a stale/wrong
      // secret file, or the "no secret" path where we'd skip entirely)
      const client = new PtyDaemonClient("s", "wrong-secret");
      await assert.rejects(() => client.connect(paths.socket), /[Aa]uth/);
      await sleep(300);

      assert.ok(isAlive(pid), "daemon should survive a failed auth attempt");
    } finally {
      killPid(pid);
      await sleep(200);
      cleanupPaths(paths);
    }
  });

  test("orphan with missing secret file + full DaemonManager cleanup flow", async function () {
    this.timeout(15000);
    const paths = uniquePaths();

    // Set up the EXACT orphan scenario from Dale's report:
    // - A loomptyd is running
    // - Lockfile points to it
    // - Secret file is MISSING
    const orphanPid = await spawnRaw(paths, "lost-secret");

    try {
      // Verify orphan state matches Dale's diagnostic output
      assert.ok(isAlive(orphanPid), "orphan is alive");
      const info = readLockfile(paths.lockfile);
      assert.strictEqual(info?.pid, orphanPid, "lockfile points to orphan");
      // No secret file exists — we never wrote one

      // Simulate _spawnAndConnect's cleanup: remove lockfile + socket
      fs.unlinkSync(paths.lockfile);
      try { fs.unlinkSync(paths.socket); } catch {}

      // Now spawn a replacement (what _spawnDaemon does)
      const newPid = await spawnRaw(paths, "new-secret");

      await sleep(500);

      // BOTH should be alive — the orphan is orphaned but not killed
      assert.ok(
        isAlive(orphanPid),
        `orphan (PID ${orphanPid}) should still be alive — only the filesystem entries were cleaned`,
      );
      assert.ok(isAlive(newPid), "new daemon alive");

      // The new client should be able to connect + auth
      const client = new PtyDaemonClient("s", "new-secret");
      await client.connect(paths.socket);
      assert.strictEqual(client.connected, true);
      const pong = await client.ping();
      assert.strictEqual(pong, true);
      client.disconnect();
    } finally {
      killPid(orphanPid);
      const info = readLockfile(paths.lockfile);
      if (info?.pid && info.pid !== orphanPid) killPid(info.pid);
      await sleep(200);
      cleanupPaths(paths);
    }
  });
});
