#!/usr/bin/env node
// Tests how loomptyd responds to SIGHUP/SIGTERM/SIGINT.
// These are the signals VS Code likely sends to the ext host on close,
// which may propagate to our spawned daemon.

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LOOMPTYD = path.resolve(__dirname, "..", "bin", "loomptyd");

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function testSignal(signal) {
  const id = `${process.pid}-${Date.now()}`;
  const socket = path.join(os.tmpdir(), `alterm-sig-${id}.sock`);
  const lockfile = path.join(os.tmpdir(), `alterm-sig-${id}.json`);
  const log = path.join(os.tmpdir(), `alterm-sig-${id}.log`);

  const child = cp.spawn(LOOMPTYD, [
    "--socket", socket,
    "--secret", "s",
    "--lockfile", lockfile,
    "--log", log,
  ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  child.unref();

  // Wait for lockfile
  const start = Date.now();
  let info = null;
  while (Date.now() - start < 5000) {
    try {
      info = JSON.parse(fs.readFileSync(lockfile, "utf8"));
      if (info && info.pid) break;
    } catch {}
    await sleep(50);
  }
  if (!info) {
    console.log(`  [${signal}] daemon never came up`);
    return;
  }

  const pid = info.pid;
  process.kill(pid, signal);
  await sleep(500);

  const survived = isAlive(pid);
  console.log(`  ${signal.padEnd(8)} ${survived ? "\x1b[32m✓ survived\x1b[0m" : "\x1b[31m✗ DIED\x1b[0m"}`);

  // Cleanup
  try { process.kill(pid, "SIGKILL"); } catch {}
  try { fs.unlinkSync(socket); } catch {}
  try { fs.unlinkSync(lockfile); } catch {}
  try { fs.unlinkSync(log); } catch {}
}

async function main() {
  console.log("\nHow loomptyd responds to signals:\n");
  for (const sig of ["SIGHUP", "SIGTERM", "SIGINT", "SIGUSR1", "SIGPIPE"]) {
    await testSignal(sig);
  }
  console.log("");
  console.log("VS Code ext host close likely sends SIGTERM or SIGHUP to children.");
  console.log("If the daemon dies from those, we need to ignore them (like the old Node daemon did).\n");
}

main();
