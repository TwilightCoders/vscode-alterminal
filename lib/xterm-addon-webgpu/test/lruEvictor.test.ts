import * as assert from "node:assert/strict";
import { LruEvictor } from "../src/atlas/lruEvictor.js";

describe("LruEvictor", () => {
  it("tracks size as glyphs are marked used", () => {
    const e = new LruEvictor();
    e.beginFrame();
    e.markUsed(1);
    e.markUsed(2);
    assert.equal(e.size, 2);
  });

  it("never offers a glyph used in the current frame for eviction", () => {
    const e = new LruEvictor();
    e.beginFrame();
    e.markUsed(1);
    e.markUsed(2);
    // Everything was touched this frame -> nothing evictable.
    assert.deepEqual(e.selectEvictable(10), []);
  });

  it("offers stale glyphs once a new frame begins", () => {
    const e = new LruEvictor();
    e.beginFrame();
    e.markUsed(1);
    e.markUsed(2);
    e.beginFrame(); // new frame; 1 and 2 are now stale
    e.markUsed(2); // refresh 2 only
    const evictable = e.selectEvictable(10);
    assert.deepEqual(evictable, [1], "only the un-refreshed glyph is evictable");
  });

  it("orders eviction candidates least-recently-used first", () => {
    const e = new LruEvictor();
    e.beginFrame();
    e.markUsed(10); // frame 1
    e.beginFrame();
    e.markUsed(20); // frame 2
    e.beginFrame();
    e.markUsed(30); // frame 3
    e.beginFrame(); // frame 4 — all three are stale
    assert.deepEqual(e.selectEvictable(2), [10, 20], "oldest two, in age order");
  });

  it("returns fewer candidates than requested when not enough are stale", () => {
    const e = new LruEvictor();
    e.beginFrame();
    e.markUsed(1);
    e.beginFrame();
    e.markUsed(1); // refreshed; nothing else exists
    assert.deepEqual(e.selectEvictable(5), []);
  });

  it("removes and forgets a glyph", () => {
    const e = new LruEvictor();
    e.beginFrame();
    e.markUsed(1);
    assert.equal(e.has(1), true);
    e.remove(1);
    assert.equal(e.has(1), false);
    assert.equal(e.size, 0);
  });
});
