/**
 * Single source of truth for the extension's version string.
 *
 * There are two underlying numbers, and historically each display surface
 * combined them differently. This module reconciles them in one place so the
 * status bar, the view header, and TERM_PROGRAM_VERSION all show the same
 * string.
 *
 *   - package.json `version`  — the semver (e.g. "0.2.0-dev.6"). What VS Code
 *     uses to load the vsix; bumped on `npm run dev:install`.
 *   - DEV_BUILD_NUMBER        — a monotonic dev-build counter (.vscode/dev-counter)
 *     regenerated into src/generated/buildInfo.ts by scripts/bump-dev-build.js.
 *     Bumped on every F5 launch *and* every dev:install, so it uniquely
 *     identifies the exact build you are running.
 *
 * `dev:install` syncs package.json's `-dev.N` to the counter, so for an
 * installed build the two agree. For an F5 build-from-source, package.json's
 * `-dev.N` is stale (it only changes on install) but the counter is current —
 * so `getVersion()` prefers the counter when present.
 *
 * A real release (no dev counter generated) falls back to the clean semver.
 */
import * as fs from "fs";
import * as path from "path";

function readSemver(): string {
  // package.json is one level up from out/version.js, two from out/**/foo.js.
  const candidates = [
    path.join(__dirname, "..", "package.json"),
    path.join(__dirname, "..", "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf8")).version;
      if (typeof v === "string" && v) return v;
    } catch {
      /* try next candidate */
    }
  }
  return "0.0.0";
}

function readDevBuild(): number | null {
  try {
    // Generated only by a dev build/launch; absent in clean checkouts/releases.
    const n = require("./generated/buildInfo").DEV_BUILD_NUMBER;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

/**
 * Pure reconciliation: given the package.json semver and an optional dev-build
 * counter, produce the canonical display string. Prefers the live counter over
 * package.json's (possibly stale) `-dev.N`. Exported for testing.
 */
export function composeVersion(semver: string, devBuild: number | null): string {
  if (devBuild != null) {
    return semver.replace(/-dev\.\d+$/, "") + `-dev.${devBuild}`;
  }
  return semver;
}

const _semver = readSemver();
const _devBuild = readDevBuild();

/** The raw package.json semver, e.g. "0.2.0-dev.6". */
export function getSemver(): string {
  return _semver;
}

/** The dev-build counter, or null outside dev builds. */
export function getDevBuild(): number | null {
  return _devBuild;
}

/**
 * The canonical version string shown everywhere, e.g. "0.2.0-dev.4".
 * Prefers the live dev-build counter over package.json's (possibly stale) `-dev.N`.
 */
export function getVersion(): string {
  return composeVersion(_semver, _devBuild);
}
