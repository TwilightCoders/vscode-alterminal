import * as assert from "assert";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PtyDaemonClient } from "../../src/daemon/ptyDaemonClient";
import { readPidfile, generateSecret } from "../../src/daemon/lockfile";

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
const DAEMON_BOOT_TIMEOUT_MS = Number(process.env.ALTERMINAL_DAEMON_TEST_TIMEOUT_MS ?? 30000);
const DAEMON_TEST_TIMEOUT_MS = DAEMON_BOOT_TIMEOUT_MS + 5000;

function uniquePaths() {
  const id = `test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const dir = os.tmpdir();
  const socket = path.join(dir, `alterm-${id}.sock`);
  return {
    socket,
    pidfile: socket + ".pid", // loomptyd auto-derives this from --socket
    log:     path.join(dir, `alterm-${id}.log`),
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
      reject(new Error(`daemon didn't come up in ${DAEMON_BOOT_TIMEOUT_MS}ms`));
    }, DAEMON_BOOT_TIMEOUT_MS);

    const poll = setInterval(() => {
      const pid = readPidfile(paths.pidfile);
      if (pid) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve({ pid, secret, child });
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
  // These spawn a real loomptyd from bin/loomptyd. That binary is gitignored
  // (built locally / vendored per-platform), so it's absent on CI runners
  // without a loompty source tree. Skip rather than hard-fail when it's missing.
  suiteSetup(function () {
    if (!fs.existsSync(LOOMPTYD)) this.skip();
    if (process.env.ALTERMINAL_RUN_DAEMON_TESTS !== "1") this.skip();
  });

  suite("spawn + connect", () => {
    test("daemon comes up and accepts a connection with auth", async function () {
      this.timeout(DAEMON_TEST_TIMEOUT_MS);
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
      this.timeout(DAEMON_TEST_TIMEOUT_MS);
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
        [LOOMPTYD, paths.socket, paths.log],
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
        setTimeout(() => reject(new Error(`helper timeout after ${DAEMON_BOOT_TIMEOUT_MS}ms`)), DAEMON_BOOT_TIMEOUT_MS);
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
      this.timeout(DAEMON_TEST_TIMEOUT_MS);
      await runPersistenceTest("SIGTERM");
    });

    test("daemon survives SIGKILL to spawning process", async function () {
      this.timeout(DAEMON_TEST_TIMEOUT_MS);
      await runPersistenceTest("SIGKILL");
    });

    test("daemon survives spawning process exit(0)", async function () {
      this.timeout(DAEMON_TEST_TIMEOUT_MS);
      const paths = uniquePaths();

      // Helper exits cleanly via process.exit(0) on an ipc message.
      // This simulates VS Code's extension host clean shutdown.
      const child = cp.fork(
        SPAWN_HELPER,
        [LOOMPTYD, paths.socket, paths.log],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );

      let daemonPid: number | null = null;
      const ready = new Promise<void>((resolve, reject) => {
        child.on("message", (msg: any) => {
          if (msg.type === "ready") { daemonPid = msg.pid; resolve(); }
          else if (msg.type === "error") reject(new Error(msg.message));
        });
        setTimeout(() => reject(new Error(`helper timeout after ${DAEMON_BOOT_TIMEOUT_MS}ms`)), DAEMON_BOOT_TIMEOUT_MS);
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
      this.timeout(DAEMON_TEST_TIMEOUT_MS);
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
      this.timeout(DAEMON_TEST_TIMEOUT_MS);
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

  suite("zero-downtime handoff (Layer 1 --handoff-listen)", () => {
    // Spawn a successor in --handoff-listen mode, sharing the predecessor's
    // control socket. Resolves once it has written its post-listen marker.
    function spawnSuccessor(
      paths: ReturnType<typeof uniquePaths>,
      secret: string,
      handoffPath: string,
    ): Promise<cp.ChildProcess> {
      const child = cp.spawn(LOOMPTYD, [
        "--socket", paths.socket,
        "--secret", secret,
        "--handoff-listen", handoffPath,
      ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout!.resume();
      child.stderr!.resume();
      child.unref();

      const ready = `${handoffPath}.ready`;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(poll);
          reject(new Error("successor never wrote its handoff-listen ready marker"));
        }, 8000);
        const poll = setInterval(() => {
          if (fs.existsSync(ready)) {
            clearInterval(poll);
            clearTimeout(timeout);
            resolve(child);
          }
        }, 50);
      });
    }

    test("successor adopts the live session across a daemon swap (same pid, scrollback intact)", async function () {
      this.timeout(DAEMON_TEST_TIMEOUT_MS);
      const paths = uniquePaths();
      const handoffPath = path.join(os.tmpdir(), `alterm-handoff-${process.pid}-${Date.now()}.sock`);
      const { pid: pidA, secret } = await spawnDaemonDirect(paths);

      try {
        // Predecessor: spawn a session, write a marker into its scrollback.
        const clientA = new PtyDaemonClient("A", secret);
        await clientA.connect(paths.socket);
        const sessionName = `handoff-sess-${Date.now()}`;
        const { pid: shellPid } = await clientA.spawn(
          sessionName, "/bin/sh", [], process.cwd(), { TERM: "dumb" }, 80, 24,
        );
        assert.ok(shellPid > 0, "session should have a real shell pid");
        await sleep(300);
        clientA.write(sessionName, "HANDOFF_MARKER");
        await sleep(300);

        // Bring up the successor listening on the handoff socket.
        const successor = await spawnSuccessor(paths, secret, handoffPath);

        // Tell the predecessor to hand off, then drop our connection to it.
        clientA.handoff(handoffPath);
        clientA.disconnect();

        // Poll the (shared) control socket until the successor has adopted
        // the session and rebound. The predecessor's pid should be gone.
        let clientB: PtyDaemonClient | null = null;
        for (let i = 0; i < 40 && !clientB; i++) {
          await sleep(250);
          try {
            const c = new PtyDaemonClient("B", secret);
            await c.connect(paths.socket);
            if (await c.ping()) { clientB = c; break; }
            c.disconnect();
          } catch { /* successor not up yet — retry */ }
        }
        assert.ok(clientB, "a daemon should answer the control socket after handoff");

        // The original spawning daemon process must be gone (it shut down
        // after the handoff) — proving this is the successor, not a no-op.
        await sleep(300);
        assert.ok(!isAlive(pidA), "predecessor daemon should have shut down after handoff");

        // The adopted session must still exist with the SAME shell pid —
        // i.e. the live PTY was transferred (SCM_RIGHTS), not respawned.
        const sessions = await clientB!.list();
        const adopted = sessions.find((p) => p.ptyId === sessionName);
        assert.ok(adopted, "successor should list the adopted session");
        assert.strictEqual(adopted!.pid, shellPid, "shell pid must survive the handoff unchanged");

        // Scrollback must have survived the transfer.
        const replayed: string[] = [];
        clientB!.on("data", (_n: string, d: string) => replayed.push(d));
        await clientB!.attach(sessionName);
        await sleep(500);
        assert.ok(
          replayed.join("").includes("HANDOFF_MARKER"),
          "adopted session's scrollback should survive the handoff",
        );

        clientB!.kill(sessionName);
        await sleep(200);
        clientB!.disconnect();
        try { successor.kill("SIGTERM"); } catch { /* already gone */ }
      } finally {
        killPid(pidA);
        await sleep(200);
        try { fs.rmSync(`${handoffPath}.ready`, { force: true }); } catch {}
        try { fs.rmSync(handoffPath, { force: true }); } catch {}
        cleanupPaths(paths);
      }
    });
  });

  suite("reattach (resume-only, no replay)", () => {
    test("reattach resumes the live stream WITHOUT replaying scrollback", async function () {
      this.timeout(DAEMON_TEST_TIMEOUT_MS);
      const paths = uniquePaths();
      const { pid, secret } = await spawnDaemonDirect(paths);

      try {
        // Seed scrollback with a marker via a first (attached) client.
        const clientA = new PtyDaemonClient("A", secret);
        await clientA.connect(paths.socket);
        const sessionName = `reattach-sess-${Date.now()}`;
        await clientA.spawn(
          sessionName, "/bin/sh", [], process.cwd(), { TERM: "dumb" }, 80, 24,
        );
        await sleep(300);
        // Commit the marker to scrollback HISTORY (trailing newline), not
        // the live input line — otherwise a resize-triggered redraw of the
        // current line would surface it and we couldn't distinguish a
        // redraw from an actual scrollback replay.
        clientA.write(sessionName, "echo REATTACH_MARKER\n");
        await sleep(400);
        clientA.disconnect();
        await sleep(200);

        // Reattach (resume-only) with a fresh client.
        const clientB = new PtyDaemonClient("B", secret);
        await clientB.connect(paths.socket);
        const got: string[] = [];
        clientB.on("data", (_n: string, d: string) => got.push(d));
        await clientB.reattach(sessionName, { cols: 80, rows: 24 });

        // No scrollback should replay — the historical marker must NOT
        // reappear (a current-line resize redraw only touches the prompt).
        await sleep(500);
        assert.ok(
          !got.join("").includes("REATTACH_MARKER"),
          `reattach must NOT replay scrollback, but got: ${JSON.stringify(got.join(""))}`,
        );

        // The live stream must still work — new input echoes back.
        clientB.write(sessionName, "echo LIVE_PING\n");
        await sleep(400);
        assert.ok(
          got.join("").includes("LIVE_PING"),
          "reattach should leave a working live stream (echo of new input)",
        );

        clientB.kill(sessionName);
        await sleep(200);
        clientB.disconnect();
      } finally {
        killPid(pid);
        await sleep(200);
        cleanupPaths(paths);
      }
    });
  });
});
