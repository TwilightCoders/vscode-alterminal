import * as assert from "node:assert/strict";
import { viewportCursorRow, cursorOnScreen } from "../src/util/cursorViewport.js";

/**
 * Regression guard for the "scroll-back drags cursor + corrupts history"
 * bug. xterm reports `buffer.cursorY` measured from `buffer.baseY`, NOT
 * from `viewportY`. When the user scrolls back, `viewportY` drops below
 * `baseY`, so using `cursorY` raw pins the cursor to a viewport row that
 * no longer corresponds to where new PTY output is being written —
 * subsequent output rendered through that mis-positioned cursor cell
 * scribbles over the historical buffer the user is reading.
 */
describe("viewportCursorRow", () => {
  it("returns cursorY unchanged when not scrolled (viewportY === baseY)", () => {
    // The common case: user is at the bottom of the terminal.
    assert.equal(viewportCursorRow(10, 100, 100), 10);
    assert.equal(viewportCursorRow(0, 0, 0), 0);
  });

  it("pushes the cursor OFF-SCREEN (row >= rows) when the user scrolls back", () => {
    // baseY=100, cursor at row 10 of the live area → absolute row 110.
    // User scrolled viewport to start at row 80. Cursor should be at
    // viewport row 30 — well past a 24-row viewport, so OFF-SCREEN.
    const r = viewportCursorRow(/*cursorY*/ 10, /*baseY*/ 100, /*viewportY*/ 80);
    assert.equal(r, 30);
    assert.equal(cursorOnScreen(10, 100, 80, /*rows*/ 24), false);
  });

  it("does NOT pin the cursor to a fixed screen row across different scroll positions", () => {
    // This is the heart of the bug: raw cursorY would return 10 here AND
    // in the not-scrolled case above, "dragging" the cursor with the
    // scroll. The correct mapping changes with viewportY.
    const a = viewportCursorRow(10, 100, 100); // not scrolled
    const b = viewportCursorRow(10, 100, 90); // scrolled back 10 rows
    const c = viewportCursorRow(10, 100, 80); // scrolled back 20 rows
    assert.equal(a, 10);
    assert.equal(b, 20);
    assert.equal(c, 30);
    assert.notEqual(b, a);
    assert.notEqual(c, a);
  });

  it("can produce a negative viewport row when viewport is below baseY", () => {
    // Defensive: if some path sets viewportY above the cursor's absolute
    // row, the math still produces a sensible negative offset rather than
    // wrapping or clamping. Caller decides what to do with off-screen.
    const r = viewportCursorRow(0, 100, 150);
    assert.equal(r, -50);
    assert.equal(cursorOnScreen(0, 100, 150, 24), false);
  });

  it("reports on-screen for the common cursor position when at the bottom", () => {
    assert.equal(cursorOnScreen(23, 100, 100, 24), true); // last visible row
    assert.equal(cursorOnScreen(0, 100, 100, 24), true); // first visible row
    assert.equal(cursorOnScreen(24, 100, 100, 24), false); // one past the end
  });
});
