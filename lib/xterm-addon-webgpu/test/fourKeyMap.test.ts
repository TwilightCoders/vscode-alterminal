import * as assert from "node:assert/strict";
import { FourKeyMap } from "../src/util/fourKeyMap.js";

describe("FourKeyMap", () => {
  it("stores and retrieves by a 4-tuple key", () => {
    const m = new FourKeyMap<string>();
    m.set(1, 2, 3, 4, "a");
    assert.equal(m.get(1, 2, 3, 4), "a");
  });

  it("returns undefined for a missing key without throwing", () => {
    const m = new FourKeyMap<string>();
    m.set(1, 2, 3, 4, "a");
    assert.equal(m.get(9, 9, 9, 9), undefined);
    assert.equal(m.get(1, 2, 3, 5), undefined);
  });

  it("treats differing styles of the same code as distinct entries", () => {
    const m = new FourKeyMap<string>();
    m.set(65, 0, 0, 0, "plain-A");
    m.set(65, 1, 0, 0, "styled-A");
    assert.equal(m.get(65, 0, 0, 0), "plain-A");
    assert.equal(m.get(65, 1, 0, 0), "styled-A");
    assert.equal(m.size, 2);
  });

  it("does not double-count overwrites", () => {
    const m = new FourKeyMap<number>();
    m.set(1, 1, 1, 1, 10);
    m.set(1, 1, 1, 1, 20);
    assert.equal(m.size, 1);
    assert.equal(m.get(1, 1, 1, 1), 20);
  });

  it("deletes and updates size", () => {
    const m = new FourKeyMap<number>();
    m.set(1, 1, 1, 1, 10);
    assert.equal(m.delete(1, 1, 1, 1), true);
    assert.equal(m.delete(1, 1, 1, 1), false);
    assert.equal(m.size, 0);
    assert.equal(m.get(1, 1, 1, 1), undefined);
  });

  it("iterates all values", () => {
    const m = new FourKeyMap<number>();
    m.set(1, 0, 0, 0, 1);
    m.set(2, 0, 0, 0, 2);
    m.set(2, 1, 0, 0, 3);
    const seen = [...m.values()].sort((a, b) => a - b);
    assert.deepEqual(seen, [1, 2, 3]);
  });

  it("clears everything", () => {
    const m = new FourKeyMap<number>();
    m.set(1, 1, 1, 1, 1);
    m.set(2, 2, 2, 2, 2);
    m.clear();
    assert.equal(m.size, 0);
    assert.equal(m.get(1, 1, 1, 1), undefined);
  });
});
