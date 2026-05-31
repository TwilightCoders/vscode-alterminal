import * as assert from "node:assert/strict";
import {
  onDevicePixelRatioChanged,
  onCharSizeChanged,
} from "../src/util/fontEventHandlers.js";

/**
 * Regression guard for the "VS Code Cmd++ → wide-spaced glyphs in
 * WebGPU" incident.
 *
 * xterm fires `IRenderer.handleDevicePixelRatioChange()` when the page
 * DPR changes (display move, Electron webFrame.setZoomLevel, etc.) and
 * `IRenderer.handleCharSizeChanged()` when the measured font cell size
 * changes (font/lineHeight/letterSpacing edits). The renderer's
 * previous implementations of both handlers just resized the canvas at
 * the OLD metrics — leaving the glyph atlas cached at the old DPR /
 * cell-size while the cell grid was laid out at the new one. Visible
 * symptom: small glyphs spread across normal-sized cells (huge
 * apparent letter-spacing).
 *
 * The fix: each handler MUST trigger a full font refresh (rebuild
 * atlas + push fresh metrics) before any further draw. These specs
 * pin that contract on a tiny pure helper, since the renderer itself
 * is GPU-dependent and not unit-testable.
 */
describe("fontEventHandlers", () => {
  it("onDevicePixelRatioChanged invokes refreshFont", () => {
    let refreshed = 0;
    onDevicePixelRatioChanged({ refreshFont: () => { refreshed++; } });
    assert.equal(refreshed, 1);
  });

  it("onCharSizeChanged invokes refreshFont", () => {
    let refreshed = 0;
    onCharSizeChanged({ refreshFont: () => { refreshed++; } });
    assert.equal(refreshed, 1);
  });

  it("does NOT skip refreshFont if the callback is provided (defensive: no surprise no-ops)", () => {
    // The bug was equivalent to refreshFont being a no-op in production.
    // If a future refactor inserts a conditional / early-return that
    // silently drops the refresh, this guard catches it.
    let calls: string[] = [];
    onDevicePixelRatioChanged({ refreshFont: () => calls.push("dpr") });
    onCharSizeChanged({ refreshFont: () => calls.push("size") });
    assert.deepEqual(calls, ["dpr", "size"]);
  });

  it("propagates errors from refreshFont (does NOT swallow)", () => {
    // We don't want silent atlas-rebuild failures. If refreshFont throws,
    // the caller — and any wider error boundary — must see it.
    assert.throws(
      () => onDevicePixelRatioChanged({ refreshFont: () => { throw new Error("atlas oom"); } }),
      /atlas oom/,
    );
    assert.throws(
      () => onCharSizeChanged({ refreshFont: () => { throw new Error("atlas oom"); } }),
      /atlas oom/,
    );
  });
});
