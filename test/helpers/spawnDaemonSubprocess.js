// Helper subprocess for the "daemon survives parent death" test.
// Spawns loomptyd exactly the way DaemonManager does, reports the
// daemon PID to the parent, then sits idle until killed.
//
// Usage: node spawnDaemonSubprocess.js <loomptyd> <socket> <lockfile> <log>

const cp = require("child_process");
const fs = require("fs");
const crypto = require("crypto");

const [, , binary, socketPath, lockPath, logPath] = process.argv;

const secret = crypto.randomBytes(16).toString("hex");

const child = cp.spawn(binary, [
  "--socket", socketPath,
  "--secret", secret,
  "--lockfile", lockPath,
  "--log", logPath,
], {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.resume();
child.stderr.resume();
child.unref();

// Poll for lockfile
const startedAt = Date.now();
const poll = setInterval(() => {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const info = JSON.parse(raw);
    if (info && info.pid && info.socketPath) {
      clearInterval(poll);
      process.send({ type: "ready", pid: info.pid });
    }
  } catch {
    if (Date.now() - startedAt > 5000) {
      clearInterval(poll);
      process.send({ type: "error", message: "daemon startup timeout in helper" });
      process.exit(1);
    }
  }
}, 50);

// Clean-exit handler: if parent sends {type:"exit-clean"}, exit 0 gracefully.
// Otherwise sit idle and let the parent signal us.
process.on("message", (msg) => {
  if (msg && msg.type === "exit-clean") {
    process.exit(0);
  }
});
