/**
 * Per-OS resolution of the loomptyd binary that the extension should spawn.
 *
 * Pulled out of DaemonManager as a pure function so it can be unit-tested for
 * every platform from any host — the bug this exists to prevent was only ever
 * observable on Windows, which is exactly where we don't run the suite by
 * default.
 */

import * as path from "path";

export interface DaemonLookupOptions {
  /** The extension's bin/ directory. */
  binDir: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Injected so tests don't need a real filesystem. */
  isFile: (p: string) => boolean;
}

export type DaemonLookupResult =
  /** Use this binary. */
  | { kind: "found"; path: string }
  /** Nothing vendored; the caller should fall back to a PATH search. */
  | { kind: "searchPath" }
  /** No daemon can work here — fail fast, don't try to exec anything. */
  | { kind: "unsupported"; reason: string };

/** Name of the vendored, platform-tagged daemon for a given target. */
export function vendoredDaemonName(platform: NodeJS.Platform, arch: string): string {
  return `loomptyd-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

export function resolveDaemonBinary(o: DaemonLookupOptions): DaemonLookupResult {
  // The platform-tagged binary is the only one whose target we actually KNOW.
  const tagged = path.join(o.binDir, vendoredDaemonName(o.platform, o.arch));
  if (o.isFile(tagged)) {
    return { kind: "found", path: tagged };
  }

  // Windows stops here, for two reasons:
  //
  // 1. The unsuffixed `bin/loomptyd` is a local dev artifact built by
  //    scripts/build-daemon.js. In a packaged extension it is whatever
  //    platform the publisher built on — in practice a macOS Mach-O. Exec'ing
  //    it on Windows cannot succeed, and it does not fail fast: it cost ~10
  //    seconds of dead startup per launch before spawn gave up and fell back
  //    to direct mode.
  // 2. There is no loomptyd on a Windows PATH either — the daemon is POSIX-only
  //    (unix sockets, SCM_RIGHTS, flock) until the native port lands. And
  //    `which` isn't a Windows command, so the PATH search below would itself
  //    fail with a confusing ENOENT rather than "no daemon here".
  if (o.platform === "win32") {
    return {
      kind: "unsupported",
      reason: `no loomptyd for ${o.platform}-${o.arch} (daemon is POSIX-only; using direct mode)`,
    };
  }

  const generic = path.join(o.binDir, "loomptyd");
  if (o.isFile(generic)) {
    return { kind: "found", path: generic };
  }

  return { kind: "searchPath" };
}
