import * as assert from "node:assert/strict";
import { normalizeSelection, isCellInSelection } from "../src/model/selection.js";

describe("selection geometry", () => {
  describe("normalizeSelection", () => {
    it("leaves already-ordered endpoints alone", () => {
      const s = normalizeSelection([2, 1], [5, 3], false);
      assert.deepEqual(s.start, [2, 1]);
      assert.deepEqual(s.end, [5, 3]);
    });

    it("swaps endpoints given in reverse row order", () => {
      const s = normalizeSelection([5, 3], [2, 1], false);
      assert.deepEqual(s.start, [2, 1]);
      assert.deepEqual(s.end, [5, 3]);
    });

    it("swaps by column when on the same row", () => {
      const s = normalizeSelection([8, 4], [2, 4], false);
      assert.deepEqual(s.start, [2, 4]);
      assert.deepEqual(s.end, [8, 4]);
    });
  });

  describe("isCellInSelection — no selection", () => {
    it("returns false when selection is null", () => {
      assert.equal(isCellInSelection(0, 0, null), false);
    });
  });

  describe("isCellInSelection — single row", () => {
    const sel = normalizeSelection([4, 6], [15, 6], false); // "quick brown" cols 4..14

    it("includes cells from start col up to (not including) end col", () => {
      assert.equal(isCellInSelection(4, 6, sel), true);
      assert.equal(isCellInSelection(14, 6, sel), true);
      assert.equal(isCellInSelection(15, 6, sel), false, "end col is exclusive");
    });

    it("excludes cells before the start col", () => {
      assert.equal(isCellInSelection(3, 6, sel), false);
    });

    it("excludes other rows", () => {
      assert.equal(isCellInSelection(8, 5, sel), false);
      assert.equal(isCellInSelection(8, 7, sel), false);
    });
  });

  describe("isCellInSelection — multi row", () => {
    const sel = normalizeSelection([10, 2], [3, 4], false);

    it("first row: from start col to end of line", () => {
      assert.equal(isCellInSelection(10, 2, sel), true);
      assert.equal(isCellInSelection(200, 2, sel), true, "first row extends past content");
      assert.equal(isCellInSelection(9, 2, sel), false);
    });

    it("middle row: entirely selected", () => {
      assert.equal(isCellInSelection(0, 3, sel), true);
      assert.equal(isCellInSelection(999, 3, sel), true);
    });

    it("last row: up to (excluding) end col", () => {
      assert.equal(isCellInSelection(0, 4, sel), true);
      assert.equal(isCellInSelection(2, 4, sel), true);
      assert.equal(isCellInSelection(3, 4, sel), false, "end col exclusive");
    });

    it("excludes rows outside the range", () => {
      assert.equal(isCellInSelection(0, 1, sel), false);
      assert.equal(isCellInSelection(0, 5, sel), false);
    });
  });

  describe("isCellInSelection — column (block) mode", () => {
    const sel = normalizeSelection([3, 2], [7, 5], true);

    it("selects a rectangle of columns across rows", () => {
      assert.equal(isCellInSelection(3, 2, sel), true);
      assert.equal(isCellInSelection(6, 5, sel), true);
      assert.equal(isCellInSelection(7, 3, sel), false, "right edge exclusive");
      assert.equal(isCellInSelection(2, 3, sel), false, "left of block");
    });

    it("respects the row bounds", () => {
      assert.equal(isCellInSelection(5, 1, sel), false);
      assert.equal(isCellInSelection(5, 6, sel), false);
    });

    it("handles reversed column endpoints", () => {
      const rev = normalizeSelection([7, 2], [3, 5], true);
      assert.equal(isCellInSelection(4, 3, rev), true);
    });
  });
});
