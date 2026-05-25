import * as assert from "node:assert/strict";
import { deriveFontMetrics } from "../src/platform/fontMetrics.js";

describe("deriveFontMetrics", () => {
  it("uses the line box (ascent+descent) as cell height at lineHeight 1", () => {
    const m = deriveFontMetrics(8, 14, 4, 1);
    assert.equal(m.cellHeight, 18); // 14 + 4
  });

  it("places the baseline at the ascent when there is no extra leading", () => {
    const m = deriveFontMetrics(8, 14, 4, 1);
    assert.equal(m.baseline, 14);
  });

  it("splits extra line-height leading evenly above and below the text", () => {
    // lineHeight 1.5 over an 18px line box => 27px cell, 9px leading, 4.5 each side.
    const m = deriveFontMetrics(8, 14, 4, 1.5);
    assert.equal(m.cellHeight, 27);
    // baseline = ascent + leading/2 = 14 + 4.5 -> rounded 19 (i.e. centered text)
    assert.equal(m.baseline, Math.round(14 + 9 / 2));
    // symmetry: space above the ascent box == space below the descent box
    const spaceAbove = m.baseline - m.ascent; // 4.5 -> 5 (rounding)
    const spaceBelow = m.cellHeight - (m.baseline + m.descent); // 27 - (19+4) = 4
    assert.ok(Math.abs(spaceAbove - spaceBelow) <= 1, "leading split within 1px");
  });

  it("rounds the advance to a whole-pixel cell width", () => {
    assert.equal(deriveFontMetrics(8.4, 14, 4, 1).cellWidth, 8);
    assert.equal(deriveFontMetrics(8.6, 14, 4, 1).cellWidth, 9);
  });

  it("never produces a zero cell", () => {
    const m = deriveFontMetrics(0, 0, 0, 1);
    assert.ok(m.cellWidth >= 1 && m.cellHeight >= 1);
  });
});
