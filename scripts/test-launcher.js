#!/usr/bin/env node
// Verify the spawn-loomptyd.js launcher gives us a daemon whose PID we
// can hide from the immediate parent.

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const LOOMPTYD = path.resolve(__dirname, "..", "bin", "loomptyd");
const LAUNCHER = path.resolve(__dirname, "spawn-loomptyd.js");

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function main() {
  const id = `${process.pid}-${Date.now()}`;
  const socket = path.join(os.tmpdir(), `alterm-launch-${id}.sock`);
  const lockfile = path.join(os.tmpdir(), `alterm-launch-${id}.json`);
  const secret = crypto.randomBytes(16).toString("hex");

  console.log("\nSpawning loomptyd via launcher...\n");

  const launcher = cp.spawn(process.execPath, [LAUNCHER, LOOMPTYD, socket, secret, lockfile], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  launcher.stdout.on("data", c => stdout += c);

  // Wait for launcher to exit
  await new Promise(r => launcher.on("exit", r));
  console.log(`  launcher exited (pid was ${launcher.pid}, stdout=${stdout.trim()})`);

  // Wait for lockfile
  let info = null;
  for (let i = 0; i < 50; i++) {
    try { info = JSON.parse(fs.readFileSync(lockfile, "utf8")); if (info?.pid) break; } catch {}
    await sleep(100);
  }

  if (!info) { console.log("  \x1b[31m✗ daemon never came up\x1b[0m"); process.exit(1); }
  console.log(`  daemon alive at pid ${info.pid}`);
  console.log(`  launcher PID was ${launcher.pid}, daemon is different: ${info.pid !== launcher.pid ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗ SAME\x1b[0m"}`);

  // The critical test: we still have `launcher` reference but it's dead.
  // VS Code in this analogy has the launcher reference too. If VS Code
  // tried launcher.kill(), it would target a dead process — leaving the
  // daemon unharmed.
  try { launcher.kill("SIGKILL"); } catch {}
  await sleep(300);
  console.log(`  after launcher.kill(SIGKILL): daemon ${isAlive(info.pid) ? "\x1b[32m✓ still alive\x1b[0m" : "\x1b[31m✗ DIED\x1b[0m"}`);

  // Cleanup
  try { process.kill(info.pid, "SIGKILL"); } catch {}
  await sleep(200);
  [socket, lockfile].forEach(p => { try { fs.unlinkSync(p); } catch {} });
}

main().catch(e => { console.error(e); process.exit(1); });
