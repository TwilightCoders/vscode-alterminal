import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PtyManager } from "../../src/terminal/ptyManager";

/**
 * Tests for PtyManager.writeDroppedFileToTemp — the real drag-and-drop temp
 * file path (Claude Code image-attach et al). Previously this suite asserted
 * tautologies against a hand-copied reimplementation; it now drives the actual
 * method so a regression in decoding / sanitization / placement is caught.
 */
suite("PtyManager.writeDroppedFileToTemp", () => {
  const written: string[] = [];

  teardown(() => {
    for (const p of written.splice(0)) {
      try { fs.unlinkSync(p); } catch { /* already gone */ }
    }
  });

  test("decodes a data: URL and writes the bytes into a tmpdir file", async () => {
    const mgr = new PtyManager();
    // 1x1 PNG
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jU77hwAAAABJRU5ErkJggg==";
    const out = await mgr.writeDroppedFileToTemp(`data:image/png;base64,${b64}`, "shot.png");
    written.push(out);

    assert.ok(out.startsWith(os.tmpdir()), "writes under the OS temp dir");
    assert.ok(path.basename(out).startsWith("alterminal-"), "prefixes the temp name");
    assert.ok(path.basename(out).endsWith("shot.png"), "preserves the original name");
    assert.deepStrictEqual(
      fs.readFileSync(out),
      Buffer.from(b64, "base64"),
      "file content is the decoded PNG bytes",
    );
  });

  test("writes non-data payloads verbatim as utf8", async () => {
    const mgr = new PtyManager();
    const out = await mgr.writeDroppedFileToTemp("plain text body", "notes.txt");
    written.push(out);
    assert.strictEqual(fs.readFileSync(out, "utf8"), "plain text body");
  });

  test("sanitizes path separators in the filename (no traversal out of tmpdir)", async () => {
    const mgr = new PtyManager();
    const out = await mgr.writeDroppedFileToTemp("x", "../../etc/evil.png");
    written.push(out);
    assert.strictEqual(path.dirname(out), os.tmpdir(), "stays directly in tmpdir");
    assert.ok(
      !path.basename(out).includes("/") && !path.basename(out).includes("\\"),
      "separators stripped from the basename",
    );
  });

  test("returns a unique path per call for the same filename", async () => {
    const mgr = new PtyManager();
    const a = await mgr.writeDroppedFileToTemp("a", "dup.txt");
    const b = await mgr.writeDroppedFileToTemp("b", "dup.txt");
    written.push(a, b);
    assert.notStrictEqual(a, b, "two drops of the same name don't collide");
  });
});
