import * as assert from "node:assert/strict";
import { computeVerticalCellMetrics } from "../src/util/cellMetrics.js";

/**
 * Vertical cell metrics: the split between the snug content BAND (the line box —
 * what the cursor/selection/background fill, sized by font × lineHeight) and the
 * cell PITCH (how far apart rows sit = band + the absolute-px lineSpacing gap).
 *
 * lineSpacing adds space BELOW each line without resizing the glyphs or
 * inflating the line box, so the gap must change the pitch but leave bandHeight
 * and the baseline untouched.
 */
describe("computeVerticalCellMetrics", () => {
  const base = { deviceCharHeight: 34, lineHeight: 1, dpr: 2, ascent: 26, descent: 6 };

  it("with no lineSpacing, pitch equals the band (back-compat)", () => {
    const m = computeVerticalCellMetrics({ ...base, lineSpacingCssPx: 0 });
    assert.equal(m.bandHeight, 34);
    assert.equal(m.gap, 0);
    assert.equal(m.cellPitch, 34);
    assert.equal(m.cellPitch, m.bandHeight);
  });

  it("adds the gap (scaled by dpr) to the pitch only", () => {
    const m = computeVerticalCellMetrics({ ...base, lineSpacingCssPx: 6 });
    assert.equal(m.gap, 12, "6 css px × dpr 2 = 12 device px");
    assert.equal(m.bandHeight, 34, "band is unchanged by the gap");
    assert.equal(m.cellPitch, 46, "pitch = band + gap");
  });

  it("leaves the baseline unchanged when a gap is added (gap is below, not around)", () => {
    const a = computeVerticalCellMetrics({ ...base, lineSpacingCssPx: 0 });
    const b = computeVerticalCellMetrics({ ...base, lineSpacingCssPx: 10 });
    assert.equal(a.baseline, b.baseline, "the gap must not move the glyph baseline");
  });

  it("computes the baseline centered within the BAND (not the inflated cell)", () => {
    // leading = band - (ascent+descent) = 34 - 32 = 2; baseline = round(26 + 1) = 27
    const m = computeVerticalCellMetrics({ ...base, lineSpacingCssPx: 8 });
    assert.equal(m.baseline, 27);
  });

  it("honours lineHeight in the band while keeping gap absolute", () => {
    const m = computeVerticalCellMetrics({ ...base, lineHeight: 1.5, lineSpacingCssPx: 4 });
    assert.equal(m.bandHeight, Math.floor(34 * 1.5)); // 51
    assert.equal(m.gap, 8);
    assert.equal(m.cellPitch, Math.floor(34 * 1.5) + 8);
  });

  it("clamps a negative lineSpacing to zero", () => {
    const m = computeVerticalCellMetrics({ ...base, lineSpacingCssPx: -5 });
    assert.equal(m.gap, 0);
    assert.equal(m.cellPitch, m.bandHeight);
  });

  it("rounds a fractional device-pixel gap", () => {
    const m = computeVerticalCellMetrics({ ...base, dpr: 1.5, lineSpacingCssPx: 3 });
    assert.equal(m.gap, Math.round(3 * 1.5)); // 5 (4.5 → 5)
  });
});
