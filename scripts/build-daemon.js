#!/usr/bin/env node
/**
 * Portable wrapper around scripts/build-daemon.sh.
 *
 * `npm run compile` used to invoke `bash scripts/build-daemon.sh` directly,
 * which fails on Windows — there is no bash — taking the whole compile down
 * with it, before TypeScript ever runs. The shell script stays the source of
 * truth on POSIX; this only decides whether to run it.
 *
 * Skipping on Windows is correct rather than merely convenient: loomptyd is
 * POSIX-only (unix sockets, SCM_RIGHTS, flock), so there is no Windows daemon
 * to build. Windows runs the extension in direct node-pty mode, which needs
 * nothing from this step. When the Windows port lands, this is the single
 * place that decides how to build it.
 */
const { spawnSync } = require("child_process");

if (process.platform === "win32") {
  console.log("⏭  Skipping loomptyd build on Windows (daemon is POSIX-only; direct mode is used)");
  process.exit(0);
}

const r = spawnSync("bash", ["scripts/build-daemon.sh"], { stdio: "inherit" });
if (r.error && r.error.code === "ENOENT") {
  console.log("⏭  Skipping loomptyd build — bash not available");
  process.exit(0);
}
process.exit(r.status ?? 1);
