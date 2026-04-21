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
// Usage (as argv): <loomptyd-path> <socket> <secret> <lockfile> [--log PATH]

const cp = require("child_process");

const [, , loomptyd, socket, secret, lockfile, ...rest] = process.argv;

if (!loomptyd || !socket || !secret || !lockfile) {
  console.error("usage: spawn-loomptyd.js <loomptyd> <socket> <secret> <lockfile> [--log PATH]");
  process.exit(1);
}

const args = [
  "--socket", socket,
  "--secret", secret,
  "--lockfile", lockfile,
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
