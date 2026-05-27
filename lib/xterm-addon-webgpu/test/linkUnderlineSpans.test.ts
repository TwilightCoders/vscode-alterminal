import * as assert from "node:assert/strict";
import { linkUnderlineSpans } from "../src/util/linkUnderlineSpans.js";

describe("linkUnderlineSpans", () => {
  it("underlines exactly [x1, x2) on a single-row link", () => {
    const spans = linkUnderlineSpans({ x1: 5, y1: 2, x2: 12, y2: 2, cols: 80 }, 24, 80);
    assert.deepEqual(spans, [{ row: 2, colStart: 5, colEnd: 12 }]);
  });

  it("does not shift the start or overshoot the end (regression: WebGL-style misposition)", () => {
    // A link covering columns 20..27 must underline precisely those cells —
    // not start late (missing the scheme) nor run into trailing whitespace.
    const spans = linkUnderlineSpans({ x1: 20, y1: 0, x2: 27, y2: 0, cols: 120 }, 30, 120);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].colStart, 20);
    assert.equal(spans[0].colEnd, 27);
  });

  it("spans first/middle/last rows for a multi-row link", () => {
    const spans = linkUnderlineSpans({ x1: 70, y1: 1, x2: 10, y2: 3, cols: 80 }, 24, 80);
    assert.deepEqual(spans, [
      { row: 1, colStart: 70, colEnd: 80 }, // first row: x1..cols
      { row: 2, colStart: 0, colEnd: 80 }, // middle row: full width
      { row: 3, colStart: 0, colEnd: 10 }, // last row: 0..x2
    ]);
  });

  it("clamps to the grid and drops out-of-range / empty rows", () => {
    // y1 above the viewport, columns past cols — clamp, don't emit garbage.
    const spans = linkUnderlineSpans({ x1: 75, y1: -1, x2: 200, y2: 1, cols: 80 }, 24, 80);
    assert.deepEqual(spans, [
      // row -1 dropped; row 0 full width (clamped from 200→80); row 1 0..80 (clamped)
      { row: 0, colStart: 0, colEnd: 80 },
      { row: 1, colStart: 0, colEnd: 80 },
    ]);
  });

  it("emits nothing for a zero-width span", () => {
    assert.deepEqual(linkUnderlineSpans({ x1: 10, y1: 4, x2: 10, y2: 4, cols: 80 }, 24, 80), []);
  });
});
