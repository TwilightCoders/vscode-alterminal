import * as assert from "node:assert/strict";
import { DamageTracker } from "../src/model/DamageTracker.js";

describe("DamageTracker", () => {
  it("starts fully dirty after resize", () => {
    const d = new DamageTracker();
    d.resize(24);
    assert.equal(d.isAllDirty, true);
    assert.equal(d.hasDamage, true);
    assert.deepEqual(d.range, [0, 23]);
  });

  it("clears to no damage", () => {
    const d = new DamageTracker();
    d.resize(24);
    d.clear();
    assert.equal(d.hasDamage, false);
    assert.equal(d.range, null);
  });

  it("coalesces multiple ranges into one span", () => {
    const d = new DamageTracker();
    d.resize(24);
    d.clear();
    d.markRange(3, 5);
    d.markRange(10, 12);
    assert.deepEqual(d.range, [3, 12]);
  });

  it("normalizes reversed ranges", () => {
    const d = new DamageTracker();
    d.resize(24);
    d.clear();
    d.markRange(8, 4);
    assert.deepEqual(d.range, [4, 8]);
  });

  it("clamps ranges to the row count", () => {
    const d = new DamageTracker();
    d.resize(10);
    d.clear();
    d.markRange(-5, 100);
    assert.deepEqual(d.range, [0, 9]);
  });

  it("answers per-row dirty queries", () => {
    const d = new DamageTracker();
    d.resize(24);
    d.clear();
    d.markRange(5, 7);
    assert.equal(d.isRowDirty(4), false);
    assert.equal(d.isRowDirty(5), true);
    assert.equal(d.isRowDirty(7), true);
    assert.equal(d.isRowDirty(8), false);
  });

  it("treats every row as dirty when all-dirty", () => {
    const d = new DamageTracker();
    d.resize(24);
    assert.equal(d.isRowDirty(0), true);
    assert.equal(d.isRowDirty(23), true);
  });
});
