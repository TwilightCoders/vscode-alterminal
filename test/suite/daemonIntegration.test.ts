import * as assert from "assert";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PtyDaemonClient } from "../../src/daemon/ptyDaemonClient";
import { readLockfile, generateSecret } from "../../src/daemon/lockfile";

/**
 * Daemon integration tests — spawn real loomptyd, exercise the client.
 *
 * These tests answer three questions the live extension cannot easily debug:
 *   1. Can we spawn loomptyd and reach a connected state? (_spawnDaemon fix)
 *   2. Does the daemon survive when its spawning process dies?
 *   3. Can a fresh client reattach to a session and see the PTY's scrollback?
 *
 * Each test gets a unique socket path and cleans up its own daemon.
 */

const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const LOOMPTYD = path.join(PROJECT_ROOT, "bin/loomptyd");
const SPAWN_HELPER = path.join(PROJECT_ROOT, "test/helpers/spawnDaemonSubprocess.js");

function uniquePaths() {
  const id = `test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const dir = os.tmpdir();
  return {
    socket:   path.join(dir, `alterm-${id}.sock`),
    lockfile: path.join(dir, `alterm-${id}.json`),
    log:      path.join(dir, `alterm-${id}.log`),
  };
}

/** Spawn loomptyd directly (bypassing DaemonManager). Returns pid + secret. */
function spawnDaemonDirect(paths: ReturnType<typeof uniquePaths>): Promise<{
  pid: number;
  secret: string;
  child: cp.ChildProcess;
}> {
  const secret = generateSecret();
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
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("daemon didn't come up in 5s"));
    }, 5000);

    const poll = setInterval(() => {
      const info = readLockfile(paths.lockfile);
      if (info) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve({ pid: info.pid, secret, child });
      }
    }, 50);
  });
}

function killPid(pid: number) {
  try { process.kill(pid, "SIGTERM"); } catch {}
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanupPaths(paths: ReturnType<typeof uniquePaths>) {
  for (const p of Object.values(paths)) {
    try { fs.unlinkSync(p); } catch {}
  }
}

suite("Daemon Integration", () => {

  suite("spawn + connect", () => {
    test("daemon comes up and accepts a connection with auth", async function () {
      this.timeout(10000);
      const paths = uniquePaths();
      const { pid, secret } = await spawnDaemonDirect(paths);

      try {
        assert.ok(isAlive(pid), "daemon should be alive after spawn");

        const client = new PtyDaemonClient("session-id", secret);
        await client.connect(paths.socket);
        assert.strictEqual(client.connected, true);

        const pong = await client.ping();
        assert.strictEqual(pong, true);

        client.disconnect();
      } finally {
        killPid(pid);
        await sleep(200);
        cleanupPaths(paths);
      }
    });

    test("client rejects connection with wrong secret", async function () {
      this.timeout(10000);
      const paths = uniquePaths();
      const { pid } = await spawnDaemonDirect(paths);

      try {
        const client = new PtyDaemonClient("session-id", "wrong-secret");
        await assert.rejects(
          () => client.connect(paths.socket),
          /[Aa]uth/,
        );
      } finally {
        killPid(pid);
        await sleep(200);
        cleanupPaths(paths);
      }
    });
  });

  suite("daemon persistence", () => {
    async function runPersistenceTest(signal: NodeJS.Signals) {
      const paths = uniquePaths();

      const child = cp.fork(
        SPAWN_HELPER,
        [LOOMPTYD, paths.socket, paths.lockfile, paths.log],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );

      let daemonPid: number | null = null;
      const ready = new Promise<void>((resolve, reject) => {
        child.on("message", (msg: any) => {
          if (msg.type === "ready") { daemonPid = msg.pid; resolve(); }
          else if (msg.type === "error") reject(new Error(msg.message));
        });
        child.on("exit", (code, sig) => {
          if (!daemonPid) reject(new Error(`helper exited early code=${code} sig=${sig}`));
        });
        setTimeout(() => reject(new Error("helper timeout")), 8000);
      });

      try {
        await ready;
        assert.ok(daemonPid, "helper reported daemon pid");
        assert.ok(isAlive(daemonPid!), "daemon alive while helper running");

        child.kill(signal);
        await sleep(500);

        assert.ok(
          isAlive(daemonPid!),
          `daemon should survive helper ${signal} — this is the whole point of persistence`,
        );
      } finally {
        if (daemonPid) killPid(daemonPid);
        try { child.kill("SIGKILL"); } catch {}
        await sleep(200);
        cleanupPaths(paths);
      }
    }

    test("daemon survives SIGTERM to spawning process", async function () {
      this.timeout(15000);
      await runPersistenceTest("SIGTERM");
    });

    test("daemon survives SIGKILL to spawning process", async function () {
      this.timeout(15000);
      await runPersistenceTest("SIGKILL");
    });

    test("daemon survives spawning process exit(0)", async function () {
      this.timeout(15000);
      const paths = uniquePaths();

      // Helper exits cleanly via process.exit(0) on an ipc message.
      // This simulates VS Code's extension host clean shutdown.
      const child = cp.fork(
        SPAWN_HELPER,
        [LOOMPTYD, paths.socket, paths.lockfile, paths.log],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );

      let daemonPid: number | null = null;
      const ready = new Promise<void>((resolve, reject) => {
        child.on("message", (msg: any) => {
          if (msg.type === "ready") { daemonPid = msg.pid; resolve(); }
          else if (msg.type === "error") reject(new Error(msg.message));
        });
        setTimeout(() => reject(new Error("helper timeout")), 8000);
      });

      try {
        await ready;
        assert.ok(daemonPid, "helper reported daemon pid");
        child.send({ type: "exit-clean" });
        await sleep(500);

        assert.ok(
          isAlive(daemonPid!),
          "daemon should survive helper clean exit",
        );
      } finally {
        if (daemonPid) killPid(daemonPid);
        try { child.kill("SIGKILL"); } catch {}
        await sleep(200);
        cleanupPaths(paths);
      }
    });
  });

  suite("reattach with scrollback", () => {
    test("fresh client sees previously written data in scrollback", async function () {
      this.timeout(15000);
      const paths = uniquePaths();
      const { pid, secret } = await spawnDaemonDirect(paths);

      try {
        // First client: spawn session, write "Hello" (no newline), disconnect.
        const client1 = new PtyDaemonClient("sess-1", secret);
        await client1.connect(paths.socket);

        const sessionName = `test-session-${Date.now()}`;
        const dataReceived: string[] = [];
        client1.on("data", (_name: string, data: string) => { dataReceived.push(data); });

        await client1.spawn(
          sessionName,
          "/bin/sh",
          [],
          process.cwd(),
          { TERM: "dumb" },  // dumb terminal = no fancy prompt, cleaner scrollback
          80,
          24,
        );

        // Wait for the initial prompt to render
        await sleep(300);
        client1.write(sessionName, "Hello");
        // Wait for shell to echo it back
        await sleep(300);

        client1.disconnect();
        await sleep(200);

        // Second client: reattach, verify scrollback replay contains "Hello"
        const client2 = new PtyDaemonClient("sess-2", secret);
        await client2.connect(paths.socket);

        const replayed: string[] = [];
        client2.on("data", (_name: string, data: string) => { replayed.push(data); });

        await client2.attach(sessionName);

        // Scrollback streams as the first data callbacks after attach
        await sleep(500);

        const full = replayed.join("");
        assert.ok(
          full.includes("Hello"),
          `scrollback replay should contain "Hello", got: ${JSON.stringify(full)}`,
        );

        client2.kill(sessionName);
        await sleep(200);
        client2.disconnect();
      } finally {
        killPid(pid);
        await sleep(200);
        cleanupPaths(paths);
      }
    });

    test("list shows sessions across client reconnects", async function () {
      this.timeout(15000);
      const paths = uniquePaths();
      const { pid, secret } = await spawnDaemonDirect(paths);

      try {
        const client1 = new PtyDaemonClient("sess-1", secret);
        await client1.connect(paths.socket);

        const sessionName = `test-list-${Date.now()}`;
        await client1.spawn(
          sessionName, "/bin/sh", [], process.cwd(), { TERM: "dumb" }, 80, 24,
        );

        const list1 = await client1.list();
        assert.ok(
          list1.some((p) => p.ptyId === sessionName),
          "first client sees the session it spawned",
        );
        client1.disconnect();
        await sleep(200);

        const client2 = new PtyDaemonClient("sess-2", secret);
        await client2.connect(paths.socket);

        const list2 = await client2.list();
        assert.ok(
          list2.some((p) => p.ptyId === sessionName),
          "fresh client sees the session across the reconnect",
        );

        client2.kill(sessionName);
        await sleep(200);
        client2.disconnect();
      } finally {
        killPid(pid);
        await sleep(200);
        cleanupPaths(paths);
      }
    });
  });
});
