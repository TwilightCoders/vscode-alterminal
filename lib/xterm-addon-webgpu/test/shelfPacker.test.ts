import * as assert from "node:assert/strict";
import { ShelfPacker } from "../src/atlas/shelfPacker.js";

describe("ShelfPacker", () => {
  it("places the first glyph at the origin", () => {
    const p = new ShelfPacker(256, 256);
    assert.deepEqual(p.allocate(10, 20), { x: 0, y: 0 });
  });

  it("advances horizontally on the same shelf for equal-height glyphs", () => {
    const p = new ShelfPacker(256, 256);
    p.allocate(10, 20);
    assert.deepEqual(p.allocate(10, 20), { x: 10, y: 0 });
    assert.deepEqual(p.allocate(5, 20), { x: 20, y: 0 });
    assert.equal(p.shelfCount, 1);
  });

  it("opens a new shelf when the current row is full", () => {
    const p = new ShelfPacker(20, 256);
    p.allocate(10, 20); // {0,0}
    p.allocate(10, 20); // {10,0} fills the row (width 20)
    const third = p.allocate(10, 20);
    assert.deepEqual(third, { x: 0, y: 20 });
    assert.equal(p.shelfCount, 2);
  });

  it("prefers the shortest shelf that still fits (best height fit)", () => {
    // Width 30 leaves 10px of horizontal room on each shelf after a 20px glyph,
    // forcing two shelves of differing heights to coexist with room to spare.
    const p = new ShelfPacker(30, 256);
    p.allocate(20, 30); // shelf 0 @ y=0  (height 30, 10px room left)
    p.allocate(20, 10); // won't fit shelf 0's remaining 10px -> shelf 1 @ y=30 (height 10, 10px room left)
    assert.equal(p.shelfCount, 2);
    // A height-8 glyph fits both shelves; it should pick the shorter one (y=30).
    const pos = p.allocate(10, 8);
    assert.deepEqual(pos, { x: 20, y: 30 });
  });

  it("returns null when a glyph is larger than the atlas", () => {
    const p = new ShelfPacker(64, 64);
    assert.equal(p.allocate(128, 10), null);
    assert.equal(p.allocate(10, 128), null);
  });

  it("returns null when vertical room is exhausted", () => {
    const p = new ShelfPacker(20, 40);
    assert.ok(p.allocate(20, 20)); // y 0..20
    assert.ok(p.allocate(20, 20)); // y 20..40
    assert.equal(p.allocate(20, 20), null); // no room
  });

  it("reports vertical fill fraction", () => {
    const p = new ShelfPacker(100, 100);
    p.allocate(10, 25);
    assert.equal(p.verticalFill, 0.25);
  });

  it("reset clears all shelves", () => {
    const p = new ShelfPacker(100, 100);
    p.allocate(10, 25);
    p.allocate(10, 25);
    p.reset();
    assert.equal(p.shelfCount, 0);
    assert.equal(p.verticalFill, 0);
    assert.deepEqual(p.allocate(10, 10), { x: 0, y: 0 });
  });
});
