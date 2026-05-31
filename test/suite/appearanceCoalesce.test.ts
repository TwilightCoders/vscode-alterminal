import * as assert from "assert";
import { coalesceAppearance } from "../../src/webview/appearanceCoalesce";

/**
 * Regression guard for the "wide letter-spacing on reload" incident
 * (alterminal dev.19 → dev.20): `applyAppearance` pushed
 * `appearance.fontFamily` straight through, but the alterminal config
 * default is the empty string. xterm + canvas silently reject empty-family
 * font assignments and fall back to `10px sans-serif`, so cells stayed at
 * their normal width while glyphs rasterized smaller — visible as huge
 * letter spacing on BOTH webgl and webgpu after a window reload.
 *
 * The xterm constructor's pattern is `appearance.X || fallback`; this
 * suite locks the coalescer's mirror of that semantics for every key
 * where empty/zero is load-bearing.
 */
suite("coalesceAppearance — truthy-skip for constructor-fallback keys", () => {
  const baseline = {
    fontFamily: "Menlo, monospace",
    fontWeight: "normal",
    fontWeightBold: "bold",
    fontSize: 14,
    lineHeight: 1,
    wordSeparator: " ()[]",
    letterSpacing: 0,
    minimumContrastRatio: 4.5,
    cursorBlink: true,
    cursorStyle: "block",
    smoothScrollDuration: 0,
  };

  test("does NOT clobber fontFamily when appearance.fontFamily is empty string", () => {
    // This is the exact failure mode that wide-spaced both renderers:
    // user hasn't set alterminal.fontFamily or terminal.integrated.fontFamily,
    // so configurationWatcher emits the empty-string fallback. Writing it to
    // xterm breaks font measurement.
    const writes = coalesceAppearance(baseline, { fontFamily: "" });
    assert.ok(
      !("fontFamily" in writes),
      "empty fontFamily must be skipped — the constructor-time value stays",
    );
  });

  test("does NOT clobber fontFamily on undefined / null", () => {
    assert.ok(!("fontFamily" in coalesceAppearance(baseline, { fontFamily: undefined })));
    assert.ok(!("fontFamily" in coalesceAppearance(baseline, { fontFamily: null })));
  });

  test("DOES write fontFamily when a real family is supplied", () => {
    const writes = coalesceAppearance(baseline, { fontFamily: "Fira Code" });
    assert.strictEqual(writes.fontFamily, "Fira Code");
  });

  test("does NOT clobber fontSize when appearance.fontSize is 0", () => {
    // 0 is falsy; constructor uses `|| fallback`. Pushing 0 to xterm would
    // produce zero-height cells.
    const writes = coalesceAppearance(baseline, { fontSize: 0 });
    assert.ok(!("fontSize" in writes), "fontSize=0 must be skipped");
  });

  test("does NOT clobber lineHeight when 0", () => {
    const writes = coalesceAppearance(baseline, { lineHeight: 0 });
    assert.ok(!("lineHeight" in writes));
  });

  test("does NOT clobber fontWeight / fontWeightBold / wordSeparator when empty", () => {
    const writes = coalesceAppearance(baseline, {
      fontWeight: "",
      fontWeightBold: "",
      wordSeparators: "",
    });
    assert.ok(!("fontWeight" in writes));
    assert.ok(!("fontWeightBold" in writes));
    assert.ok(!("wordSeparator" in writes));
  });

  // For keys where 0 / false is a legitimate value (the constructor uses
  // `??` not `||` for these), strict-skip must apply — empty must NOT
  // collapse to "no override".
  test("DOES write letterSpacing=0 when current is non-zero", () => {
    const writes = coalesceAppearance({ ...baseline, letterSpacing: 2 }, { letterSpacing: 0 });
    assert.strictEqual(writes.letterSpacing, 0);
  });

  test("DOES write cursorBlink=false when current is true", () => {
    const writes = coalesceAppearance(baseline, { cursorBlinking: false });
    assert.strictEqual(writes.cursorBlink, false);
  });

  test("DOES write smoothScrollDuration=0 when smoothScrolling=false (current=125)", () => {
    const writes = coalesceAppearance({ ...baseline, smoothScrollDuration: 125 }, { smoothScrolling: false });
    assert.strictEqual(writes.smoothScrollDuration, 0);
  });

  test("DOES write smoothScrollDuration=125 when smoothScrolling=true", () => {
    const writes = coalesceAppearance(baseline, { smoothScrolling: true });
    assert.strictEqual(writes.smoothScrollDuration, 125);
  });

  test("skips no-op writes (no key in result when current === incoming)", () => {
    const writes = coalesceAppearance(baseline, {
      fontFamily: baseline.fontFamily,
      fontSize: baseline.fontSize,
      cursorBlinking: baseline.cursorBlink,
    });
    assert.deepStrictEqual(writes, {}, "identical values must not be written");
  });
});
