// Helper subprocess for the "daemon survives parent death" test.
// Spawns loomptyd exactly the way DaemonManager does, reports the
// daemon PID to the parent, then sits idle until killed.
//
// Usage: node spawnDaemonSubprocess.js <loomptyd> <socket> <log>
//
// loomptyd (>=0.3.1) auto-derives its pidfile as <socket>.pid; the old
// --lockfile flag was removed, so the helper polls <socket>.pid (plain pid).

const cp = require("child_process");
const fs = require("fs");
const crypto = require("crypto");

const [, , binary, socketPath, logPath] = process.argv;
const pidPath = socketPath + ".pid";

const secret = crypto.randomBytes(16).toString("hex");

const child = cp.spawn(binary, [
  "--socket", socketPath,
  "--secret", secret,
  "--log", logPath,
], {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.resume();
child.stderr.resume();
child.unref();

// Poll for the pidfile loomptyd writes once the control socket is bound.
const startedAt = Date.now();
const poll = setInterval(() => {
  let pid = NaN;
  try {
    pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
  } catch {
    // not up yet
  }
  if (Number.isInteger(pid) && pid > 0) {
    clearInterval(poll);
    process.send({ type: "ready", pid });
  } else if (Date.now() - startedAt > 5000) {
    clearInterval(poll);
    process.send({ type: "error", message: "daemon startup timeout in helper" });
    process.exit(1);
  }
}, 50);

// Clean-exit handler: if parent sends {type:"exit-clean"}, exit 0 gracefully.
// Otherwise sit idle and let the parent signal us.
process.on("message", (msg) => {
  if (msg && msg.type === "exit-clean") {
    process.exit(0);
  }
});
