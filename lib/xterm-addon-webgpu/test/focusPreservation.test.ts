import * as assert from "node:assert/strict";
import { shouldRestoreFocus } from "../src/util/focusPreservation.js";

/**
 * Source-level prevention for the focus-steal class.
 *
 * A WebGPU device is acquired asynchronously, so the renderer is hot-swapped
 * into xterm's render service one or more frames after activate(). If the user
 * was typing — keyboard focus on xterm's `.xterm-helper-textarea` — when the
 * swap lands, the DOM churn can transiently blur the textarea, long enough for
 * VS Code's panel to route focus to its own integrated terminal. The addon
 * captures focus state right before the swap and restores it right after; this
 * predicate is the (DOM-free, testable) decision of whether to restore.
 */
describe("shouldRestoreFocus", () => {
  it("restores when the textarea held focus before the swap", () => {
    const textarea = { id: "ta" };
    assert.equal(shouldRestoreFocus(textarea, textarea), true);
  });

  it("does not restore when focus was on some other element", () => {
    const textarea = { id: "ta" };
    const other = { id: "other" };
    assert.equal(shouldRestoreFocus(other, textarea), false);
  });

  it("does not restore when nothing was focused (activeBefore null)", () => {
    const textarea = { id: "ta" };
    assert.equal(shouldRestoreFocus(null, textarea), false);
  });

  it("does not restore when there is no textarea to restore to", () => {
    // Guards the null===null trap: a missing textarea must never count as a hit
    // just because activeElement was also null.
    assert.equal(shouldRestoreFocus(null, null), false);
    assert.equal(shouldRestoreFocus(undefined, undefined), false);
  });
});
