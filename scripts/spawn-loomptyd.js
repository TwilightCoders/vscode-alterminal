#!/usr/bin/env node
// Launcher that spawns loomptyd and exits, orphaning the daemon.
//
// VS Code's ext host tracks child processes via cp.spawn and kills them
// directly (by PID) on ext host close — which kills our daemon even
// though it's setsid'd into its own session. By routing through this
// launcher, VS Code only knows about this short-lived Node process;
// loomptyd is a grandchild, untracked by VS Code, orphaned to launchd
// as soon as we exit.
//
// Usage (as argv): <loomptyd-path> <socket> <secret> [extra loomptyd args...]
//
// loomptyd (>=0.3.1) auto-derives its pidfile as <socket>.pid; the old
// --lockfile flag was removed, so no lockfile path is passed. Any extra args
// (e.g. --log PATH, --handoff-listen PATH) ride through to loomptyd verbatim.

const cp = require("child_process");

const [, , loomptyd, socket, secret, ...rest] = process.argv;

if (!loomptyd || !socket || !secret) {
  console.error("usage: spawn-loomptyd.js <loomptyd> <socket> <secret> [extra loomptyd args...]");
  process.exit(1);
}

const args = [
  "--socket", socket,
  "--secret", secret,
  ...rest,
];

const daemon = cp.spawn(loomptyd, args, {
  detached: true,
  stdio: "ignore",
});

daemon.unref();

// Print the daemon PID on stdout so the caller can find it.
// (Optional — the caller also polls for the lockfile.)
console.log(daemon.pid);

// Exit immediately. This orphans the daemon to launchd/init, out of
// VS Code's tracking.
process.exit(0);
