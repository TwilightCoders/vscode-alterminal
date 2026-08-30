import * as assert from "assert";
import * as path from "path";
import { resolveDaemonBinary, vendoredDaemonName } from "../../src/daemon/daemonLookup";

const BIN = path.join("/ext", "bin");

/** isFile stub that answers true only for the listed absolute paths. */
function only(...present: string[]) {
  const set = new Set(present);
  return (p: string) => set.has(p);
}

suite("daemonLookup", () => {
  test("prefers the platform-tagged binary when vendored", () => {
    const tagged = path.join(BIN, "loomptyd-darwin-arm64");
    const result = resolveDaemonBinary({
      binDir: BIN,
      platform: "darwin",
      arch: "arm64",
      isFile: only(tagged, path.join(BIN, "loomptyd")),
    });
    assert.deepStrictEqual(result, { kind: "found", path: tagged });
  });

  test("falls back to the untagged dev binary on POSIX", () => {
    const generic = path.join(BIN, "loomptyd");
    const result = resolveDaemonBinary({
      binDir: BIN,
      platform: "darwin",
      arch: "arm64",
      isFile: only(generic),
    });
    assert.deepStrictEqual(result, { kind: "found", path: generic });
  });

  test("asks for a PATH search when bin/ is empty on POSIX", () => {
    const result = resolveDaemonBinary({
      binDir: BIN,
      platform: "linux",
      arch: "x64",
      isFile: only(),
    });
    assert.strictEqual(result.kind, "searchPath");
  });

  // The regression this file exists for. `bin/loomptyd` is whatever platform
  // the publisher built on — a macOS Mach-O in practice. Selecting it on
  // Windows cost ~10 seconds of dead startup per launch before spawn gave up.
  test("never selects the untagged dev binary on win32", () => {
    const result = resolveDaemonBinary({
      binDir: BIN,
      platform: "win32",
      arch: "x64",
      isFile: only(path.join(BIN, "loomptyd")),
    });
    assert.strictEqual(result.kind, "unsupported");
  });

  // `which` is not a Windows command, so a PATH search there fails with a
  // confusing ENOENT instead of "no daemon for this platform".
  test("never asks for a PATH search on win32", () => {
    const result = resolveDaemonBinary({
      binDir: BIN,
      platform: "win32",
      arch: "x64",
      isFile: only(),
    });
    assert.strictEqual(result.kind, "unsupported");
    if (result.kind === "unsupported") {
      assert.match(result.reason, /win32-x64/);
      assert.match(result.reason, /direct mode/i);
    }
  });

  test("uses a real Windows daemon once one is vendored", () => {
    const tagged = path.join(BIN, "loomptyd-win32-x64.exe");
    const result = resolveDaemonBinary({
      binDir: BIN,
      platform: "win32",
      arch: "x64",
      isFile: only(tagged),
    });
    assert.deepStrictEqual(result, { kind: "found", path: tagged });
  });

  test("tags Windows binaries with .exe and POSIX ones without", () => {
    assert.strictEqual(vendoredDaemonName("win32", "x64"), "loomptyd-win32-x64.exe");
    assert.strictEqual(vendoredDaemonName("linux", "arm64"), "loomptyd-linux-arm64");
  });
});
