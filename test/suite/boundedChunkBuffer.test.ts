import * as assert from "assert";
import { BoundedChunkBuffer } from "../../src/terminal/boundedChunkBuffer";

suite("BoundedChunkBuffer", () => {
  test("starts empty", () => {
    const b = new BoundedChunkBuffer({ maxChunks: 10, maxBytes: 1024 });
    assert.strictEqual(b.length, 0);
    assert.strictEqual(b.totalBytes, 0);
    assert.strictEqual(b.flush(), "");
  });

  test("preserves chunks under both caps", () => {
    const b = new BoundedChunkBuffer({ maxChunks: 10, maxBytes: 1024 });
    b.push("hello");
    b.push("world");
    assert.strictEqual(b.length, 2);
    assert.strictEqual(b.totalBytes, 10);
    assert.strictEqual(b.flush(), "helloworld");
  });

  test("flush empties the buffer", () => {
    const b = new BoundedChunkBuffer({ maxChunks: 10, maxBytes: 1024 });
    b.push("abc");
    b.flush();
    assert.strictEqual(b.length, 0);
    assert.strictEqual(b.totalBytes, 0);
    assert.strictEqual(b.flush(), "");
  });

  test("entry-count cap drops oldest chunks", () => {
    const b = new BoundedChunkBuffer({ maxChunks: 3, maxBytes: 1_000_000 });
    b.push("a");
    b.push("b");
    b.push("c");
    b.push("d");  // pushes "a" out

    assert.strictEqual(b.length, 3);
    assert.strictEqual(b.flush(), "bcd");
  });

  test("byte cap drops oldest chunks until total <= max", () => {
    const b = new BoundedChunkBuffer({ maxChunks: 100, maxBytes: 10 });
    b.push("aaaa");  // 4
    b.push("bbbb");  // 8
    b.push("cccc");  // would be 12 → drops "aaaa", left with bbbb+cccc = 8

    assert.strictEqual(b.totalBytes, 8);
    assert.strictEqual(b.flush(), "bbbbcccc");
  });

  test("byte cap drops multiple chunks for one large append", () => {
    const b = new BoundedChunkBuffer({ maxChunks: 100, maxBytes: 10 });
    b.push("aa");     // 2
    b.push("bb");     // 4
    b.push("cc");     // 6
    b.push("dd");     // 8
    b.push("z".repeat(9));  // 17 → must drop a,b,c,d to fit; only "zzzzzzzzz" left

    assert.strictEqual(b.totalBytes, 9);
    assert.strictEqual(b.length, 1);
    assert.strictEqual(b.flush(), "zzzzzzzzz");
  });

  test("oversized single chunk is kept (otherwise we'd drop everything)", () => {
    const b = new BoundedChunkBuffer({ maxChunks: 100, maxBytes: 10 });
    b.push("x".repeat(50));  // single chunk larger than the cap

    assert.strictEqual(b.totalBytes, 50);
    assert.strictEqual(b.length, 1);
    assert.strictEqual(b.flush(), "x".repeat(50));
  });

  test("byte and entry caps both enforced", () => {
    const b = new BoundedChunkBuffer({ maxChunks: 3, maxBytes: 100 });
    b.push("a");
    b.push("b");
    b.push("c");
    b.push("d");  // entry cap drops "a"

    assert.strictEqual(b.length, 3);
    assert.strictEqual(b.totalBytes, 3);
    assert.strictEqual(b.flush(), "bcd");
  });

  test("ignores empty pushes (no-op)", () => {
    const b = new BoundedChunkBuffer({ maxChunks: 10, maxBytes: 1024 });
    b.push("");
    assert.strictEqual(b.length, 0);
    assert.strictEqual(b.totalBytes, 0);
  });

  test("totalBytes tracks accurately through many evictions", () => {
    const b = new BoundedChunkBuffer({ maxChunks: 1000, maxBytes: 100 });
    for (let i = 0; i < 1000; i++) b.push("0123456789"); // each 10 bytes

    // Cap is 100 bytes → only the last 10 entries fit
    assert.strictEqual(b.totalBytes, 100);
    assert.strictEqual(b.length, 10);
  });
});
