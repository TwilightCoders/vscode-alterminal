import * as assert from "assert";
import { composeVersion } from "../../src/version";

suite("version — composeVersion", () => {
  test("returns clean semver when no dev counter (release build)", () => {
    assert.strictEqual(composeVersion("0.2.0", null), "0.2.0");
    assert.strictEqual(composeVersion("1.0.0-rc.1", null), "1.0.0-rc.1");
  });

  test("prefers the live dev counter over package.json's stale -dev.N", () => {
    // F5 build-from-source: package.json says dev.6 but the counter has moved on.
    assert.strictEqual(composeVersion("0.2.0-dev.6", 9), "0.2.0-dev.9");
  });

  test("appends -dev.N when semver has no dev suffix", () => {
    assert.strictEqual(composeVersion("0.2.0", 4), "0.2.0-dev.4");
  });

  test("only the trailing -dev.N is replaced, not other prerelease tags", () => {
    assert.strictEqual(composeVersion("0.2.0-beta.1-dev.3", 7), "0.2.0-beta.1-dev.7");
  });

  test("dev counter of 0 is honored (not treated as absent)", () => {
    assert.strictEqual(composeVersion("0.2.0-dev.5", 0), "0.2.0-dev.0");
  });
});
