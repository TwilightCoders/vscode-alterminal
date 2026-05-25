import * as assert from "node:assert/strict";
import { InstanceStager } from "../src/model/InstanceStager.js";

describe("InstanceStager", () => {
  it("tracks count and used length", () => {
    const s = new InstanceStager(4, 2);
    assert.equal(s.count, 0);
    s.push([1, 2, 3, 4]);
    assert.equal(s.count, 1);
    assert.equal(s.used.length, 4);
    assert.equal(s.usedByteLength, 16);
  });

  it("packs values contiguously", () => {
    const s = new InstanceStager(2);
    s.push([1, 2]);
    s.push([3, 4]);
    assert.deepEqual([...s.used], [1, 2, 3, 4]);
  });

  it("grows past the initial capacity without losing data", () => {
    const s = new InstanceStager(2, 1); // capacity 1 instance
    s.push([1, 1]);
    s.push([2, 2]); // forces growth
    s.push([3, 3]); // forces growth again
    assert.equal(s.count, 3);
    assert.deepEqual([...s.used], [1, 1, 2, 2, 3, 3]);
  });

  it("reset rewinds without reallocating", () => {
    const s = new InstanceStager(2, 4);
    s.push([1, 1]);
    s.reset();
    assert.equal(s.count, 0);
    assert.equal(s.used.length, 0);
    s.push([9, 9]);
    assert.deepEqual([...s.used], [9, 9]);
  });

  it("rejects a wrong-sized instance", () => {
    const s = new InstanceStager(4);
    assert.throws(() => s.push([1, 2, 3]), /expected 4 floats, got 3/);
  });
});
