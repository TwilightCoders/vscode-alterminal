#!/usr/bin/env node
/**
 * Diagnostic: inspect the alterminal daemon state from outside VS Code.
 *
 * Usage:  node scripts/daemon-status.js
 *
 * Reports:
 *   - Whether a loomptyd process is running (PID, args)
 *   - Whether the lockfile exists and what it contains
 *   - Whether the secret file exists
 *   - Whether the socket is accepting connections
 *   - Whether we can authenticate and list sessions
 *
 * Run this AFTER an F5, WITHOUT closing the extension host, to see
 * what state the daemon is in.
 */

const cp = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();

// Match what lockfile.ts does: GLOBAL_DAEMON_ID = "global"
const LOCK = path.join(runtimeDir, "alterminal-daemon-global.json");
const SECRET = path.join(runtimeDir, "alterminal-daemon-global.secret");
const SOCKET = path.join(runtimeDir, "alterminal-global.sock");

function ok(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function bad(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }
function info(msg) { console.log(`  \x1b[34mℹ\x1b[0m ${msg}`); }

console.log("\n\x1b[1m=== Alterminal Daemon Diagnostic ===\x1b[0m\n");

// 1. Process check
console.log("\x1b[1m1. Process:\x1b[0m");
try {
  const psOutput = cp.execSync("pgrep -lf loomptyd", { encoding: "utf8" }).trim();
  if (psOutput) {
    ok("loomptyd running:");
    psOutput.split("\n").forEach((l) => info(`    ${l}`));
  } else {
    bad("no loomptyd process found");
  }
} catch {
  bad("no loomptyd process found");
}

// 2. Lockfile
console.log("\n\x1b[1m2. Lockfile:\x1b[0m " + LOCK);
let lockInfo = null;
try {
  const raw = fs.readFileSync(LOCK, "utf8");
  lockInfo = JSON.parse(raw);
  ok(`exists, contents: ${JSON.stringify(lockInfo)}`);
  // Is the PID alive?
  try {
    process.kill(lockInfo.pid, 0);
    ok(`PID ${lockInfo.pid} is alive`);
  } catch {
    bad(`PID ${lockInfo.pid} is DEAD — stale lockfile`);
  }
} catch (e) {
  bad(`not found or unreadable: ${e.message}`);
}

// 3. Secret file
console.log("\n\x1b[1m3. Secret file:\x1b[0m " + SECRET);
let secret = null;
try {
  secret = fs.readFileSync(SECRET, "utf8").trim();
  ok(`exists, length ${secret.length}`);
  const mode = fs.statSync(SECRET).mode & 0o777;
  if (mode === 0o600) {
    ok(`permissions 0600 (owner-only)`);
  } else {
    bad(`permissions are ${mode.toString(8)}, expected 600`);
  }
} catch (e) {
  bad(`not found: ${e.message}`);
}

// 4. Socket
console.log("\n\x1b[1m4. Socket:\x1b[0m " + SOCKET);
const socketPath = lockInfo?.socketPath || SOCKET;
if (fs.existsSync(socketPath)) {
  ok(`socket file exists at ${socketPath}`);
} else {
  bad(`socket file not found at ${socketPath}`);
}

if (!secret || !lockInfo) {
  console.log("\n\x1b[33mSkipping connection test (no secret or lockfile)\x1b[0m");
  process.exit(1);
}

// 5. Connect + authenticate + list
console.log("\n\x1b[1m5. Connection test:\x1b[0m");

const HEADER_SIZE = 4;

function encodeFrame(obj) {
  const json = JSON.stringify(obj);
  const payload = Buffer.from(json, "utf8");
  const frame = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, HEADER_SIZE);
  return frame;
}

function decodeFrames(buf) {
  const out = [];
  while (buf.length >= HEADER_SIZE) {
    const len = buf.readUInt32BE(0);
    if (buf.length < HEADER_SIZE + len) break;
    const json = buf.subarray(HEADER_SIZE, HEADER_SIZE + len).toString("utf8");
    try { out.push(JSON.parse(json)); } catch {}
    buf = buf.subarray(HEADER_SIZE + len);
  }
  return { msgs: out, rest: buf };
}

const socket = net.createConnection(socketPath);
let buf = Buffer.alloc(0);
let authed = false;
let listDone = false;

const timeout = setTimeout(() => {
  bad("timed out waiting for responses");
  process.exit(1);
}, 5000);

socket.on("connect", () => {
  ok("TCP connected");
  socket.write(encodeFrame({ type: "auth", secret }));
});

socket.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  const { msgs, rest } = decodeFrames(buf);
  buf = rest;
  for (const msg of msgs) {
    if (msg.type === "auth_ok" && !authed) {
      authed = true;
      ok("auth_ok");
      socket.write(encodeFrame({ type: "list", id: 1 }));
    } else if (msg.type === "ptyList" && !listDone) {
      listDone = true;
      ok(`list returned ${msg.sessions.length} sessions`);
      for (const s of msg.sessions) {
        info(`    ${s.name}  pid=${s.pid}  alive=${s.alive}  cwd=${s.cwd}`);
      }
      clearTimeout(timeout);
      socket.end();
      console.log("\n\x1b[32mAll checks passed.\x1b[0m\n");
      process.exit(0);
    } else if (msg.type === "error") {
      bad(`daemon error: ${msg.message}`);
      clearTimeout(timeout);
      process.exit(1);
    }
  }
});

socket.on("error", (err) => {
  bad(`socket error: ${err.message}`);
  clearTimeout(timeout);
  process.exit(1);
});
