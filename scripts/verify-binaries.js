#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Skip verification for local dev builds
if (process.env.ALTERMINAL_DEV_BUILD) {
  console.log('⏭  Skipping binary verification (dev build)');
  process.exit(0);
}

const requiredBinaries = [
  'node_modules/@lydell/node-pty',
  'node_modules/@lydell/node-pty-darwin-x64',
  'node_modules/@lydell/node-pty-darwin-arm64',
  'node_modules/@lydell/node-pty-linux-x64',
  'node_modules/@lydell/node-pty-linux-arm64',
  'node_modules/@lydell/node-pty-win32-x64',
];

let missing = [];
for (const binary of requiredBinaries) {
  if (!fs.existsSync(binary)) {
    missing.push(binary);
  }
}

if (missing.length > 0) {
  console.error('❌ ERROR: Missing required binaries:');
  missing.forEach(b => console.error('  - ' + b));
  console.error('\nRun: npm run install-binaries');
  process.exit(1);
}

console.log('✅ All platform binaries present');

// ── Vendored loomptyd: redistributability ────────────────────────────
//
// The daemon we SHIP must run on a user's machine, not just on the machine
// that built it. Existence alone proves nothing: a `loomptyd` dynamically
// linked against a Homebrew libuv exists, execs fine on the developer's box
// (which has that dylib), and then dies at exec for every user who doesn't:
//
//   dyld: Library not loaded: /opt/homebrew/opt/libuv/lib/libuv.1.dylib
//
// That shipped undetected because this gate only did existsSync() — and note
// an exec-only check would ALSO have passed on the dev machine. The linkage
// scan below is the check that catches it regardless of what the builder has
// installed, so it is the load-bearing one.
//
// Failure mode when it slips through: no daemon can start → no PTY session
// persistence (fresh shells every launch) → and the extension churns on
// spawn/connect retries against a daemon that dies instantly.

const NON_SYSTEM_LIB_RE = /\/opt\/homebrew|\/usr\/local|\/opt\/local|Cellar/;

/** Absolute-path dynamic deps that won't exist on an arbitrary user machine. */
function nonRedistributableDeps(binary) {
  if (process.platform !== 'darwin') return [];   // otool is macOS-only
  let out;
  try {
    out = execFileSync('otool', ['-L', binary], { encoding: 'utf8' });
  } catch {
    return [];   // otool unavailable — can't assess, don't block
  }
  return out
    .split('\n')
    .slice(1)                                   // first line is the binary itself
    .map(l => l.trim().split(' ')[0])
    .filter(l => l && NON_SYSTEM_LIB_RE.test(l));
}

const vendoredDaemons = fs.existsSync('bin')
  ? fs.readdirSync('bin').filter(f => /^loomptyd-(darwin|linux|win32)-/.test(f))
  : [];

if (vendoredDaemons.length === 0) {
  console.error('❌ ERROR: no vendored loomptyd binary in bin/ — the release would ship without a daemon.');
  console.error('   Run: npm run vendor-daemon');
  process.exit(1);
}

const badlyLinked = [];
for (const name of vendoredDaemons) {
  const deps = nonRedistributableDeps(path.join('bin', name));
  if (deps.length > 0) badlyLinked.push({ name, deps });
}

if (badlyLinked.length > 0) {
  console.error('❌ ERROR: vendored loomptyd links libraries that will not exist on user machines:');
  for (const { name, deps } of badlyLinked) {
    console.error(`  - bin/${name}`);
    deps.forEach(d => console.error(`      ${d}`));
  }
  console.error('\nThe daemon must be self-contained (statically linked) to be redistributable.');
  console.error('Build loompty with static libuv, then: npm run vendor-daemon');
  process.exit(1);
}

// Exec the host-matching daemon: proves it actually loads and reports a
// version (catches a corrupt, truncated, or wrong-arch artifact — and a stale
// one, since the version is printed for the release log).
const hostDaemon = `loomptyd-${process.platform}-${os.arch()}`;
if (vendoredDaemons.includes(hostDaemon)) {
  try {
    const version = execFileSync(path.join('bin', hostDaemon), ['--version'], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    if (!/\d+\.\d+\.\d+/.test(version)) {
      console.error(`❌ ERROR: bin/${hostDaemon} --version printed no version string: "${version}"`);
      process.exit(1);
    }
    console.log(`✅ Vendored daemon loads: ${version} (bin/${hostDaemon})`);
  } catch (err) {
    console.error(`❌ ERROR: bin/${hostDaemon} failed to exec — it will fail the same way for users:`);
    console.error(`   ${err.stderr?.toString().trim() || err.message}`);
    process.exit(1);
  }
} else {
  console.log(`ℹ  No daemon vendored for this host (${hostDaemon}) — skipping exec check`);
}

// Platform coverage is a gap, not a break: warn (loudly) rather than block, so
// the release surfaces which platforms would run daemon-less (direct mode, no
// session persistence) instead of silently shipping that way.
const EXPECTED_PLATFORMS = ['loomptyd-darwin-arm64', 'loomptyd-darwin-x64', 'loomptyd-linux-x64'];
const uncovered = EXPECTED_PLATFORMS.filter(p => !vendoredDaemons.includes(p));
if (uncovered.length > 0) {
  console.warn('⚠  No vendored daemon for: ' + uncovered.join(', '));
  console.warn('   Those platforms fall back to direct mode (no PTY persistence across reloads).');
}

console.log(`✅ Vendored daemon(s) redistributable: ${vendoredDaemons.join(', ')}`);
