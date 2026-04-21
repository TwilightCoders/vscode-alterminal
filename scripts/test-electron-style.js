#!/usr/bin/env node
// Simulate VS Code's ext host spawning loomptyd, then parent dying
// the way Electron might close an ext host. Tries to reproduce Dale's
// persistence failure without involving VS Code.

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LOOMPTYD = path.resolve(__dirname, "..", "bin", "loomptyd");

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function scenario(label, killMethod) {
  const id = `${process.pid}-${Date.now()}`;
  const socket = path.join(os.tmpdir(), `alterm-esim-${id}.sock`);
  const lockfile = path.join(os.tmpdir(), `alterm-esim-${id}.json`);
  const log = path.join(os.tmpdir(), `alterm-esim-${id}.log`);

  // Spawn a parent Node process (simulates ext host)
  const parent = cp.fork(
    path.join(__dirname, "..", "test", "helpers", "spawnDaemonSubprocess.js"),
    [LOOMPTYD, socket, lockfile, log],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );

  let daemonPid = null;
  await new Promise((resolve, reject) => {
    parent.on("message", (msg) => {
      if (msg.type === "ready") { daemonPid = msg.pid; resolve(); }
      else reject(new Error(msg.message));
    });
    setTimeout(() => reject(new Error("timeout")), 5000);
  });

  // Invoke killMethod to kill the parent (and maybe its children)
  await killMethod(parent, daemonPid);

  await sleep(800);
  const survived = isAlive(daemonPid);
  console.log(`  ${label.padEnd(55)} ${survived ? "\x1b[32m✓ daemon survived\x1b[0m" : "\x1b[31m✗ daemon DIED\x1b[0m"}`);

  // Cleanup
  if (survived) try { process.kill(daemonPid, "SIGKILL"); } catch {}
  try { parent.kill("SIGKILL"); } catch {}
  [socket, lockfile, log].forEach(p => { try { fs.unlinkSync(p); } catch {} });
}

async function main() {
  console.log("\nSimulating various parent-death scenarios:\n");

  await scenario("parent exits cleanly (process.exit(0))", async (parent) => {
    parent.send({ type: "exit-clean" });
  });

  await scenario("parent gets SIGTERM (Electron graceful shutdown)", async (parent) => {
    parent.kill("SIGTERM");
  });

  await scenario("parent gets SIGKILL (Electron hard kill)", async (parent) => {
    parent.kill("SIGKILL");
  });

  await scenario("parent gets SIGHUP", async (parent) => {
    parent.kill("SIGHUP");
  });

  // Simulate "parent + grandchild killed together" — sometimes process
  // supervisors do this via PGID kill. Our daemon is in its own PGID
  // after setsid, so this SHOULD not reach it.
  await scenario("kill -TERM -<parent-pgid> (process group kill)", async (parent) => {
    try { process.kill(-parent.pid, "SIGTERM"); } catch {}
  });

  await scenario("kill -TERM directly to daemon PID", async (_parent, daemonPid) => {
    process.kill(daemonPid, "SIGTERM");
  });

  console.log("");
  console.log("If all non-direct-signal scenarios pass, the daemon is properly detached.");
  console.log("If 'parent gets SIGKILL' fails, something in our spawn pattern is wrong.");
  console.log("");
}

main().catch(e => { console.error(e); process.exit(1); });
