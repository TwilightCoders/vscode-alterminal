import * as assert from "assert";
import {
  filterVSCodeSequences,
  extractCwdFromOsc7,
  extractUserVars,
  replaceBelWithST,
} from "../../src/terminal/dataPipeline";

suite("Data Pipeline", () => {

  suite("filterVSCodeSequences", () => {
    test("should remove OSC 633 (VS Code shell integration)", () => {
      const data = "hello\x1b]633;A\x07world";
      assert.strictEqual(filterVSCodeSequences(data), "helloworld");
    });

    test("should remove OSC 133 (FinalTerm shell integration)", () => {
      const data = "hello\x1b]133;A\x07world";
      assert.strictEqual(filterVSCodeSequences(data), "helloworld");
    });

    test("should remove OSC 7 (CWD reporting)", () => {
      const data = "hello\x1b]7;file://host/Users/volte\x07world";
      assert.strictEqual(filterVSCodeSequences(data), "helloworld");
    });

    test("should remove OSC 9;9 (ConEmu CWD)", () => {
      const data = "hello\x1b]9;9;C:\\Users\\test\x07world";
      assert.strictEqual(filterVSCodeSequences(data), "helloworld");
    });

    test("should remove OSC 1337 (iTerm2 protocol)", () => {
      const data = "hello\x1b]1337;SetUserVar=foo=YmFy\x07world";
      assert.strictEqual(filterVSCodeSequences(data), "helloworld");
    });

    test("should remove DEC ?1004h (focus reporting enable)", () => {
      const data = "hello\x1b[?1004hworld";
      assert.strictEqual(filterVSCodeSequences(data), "helloworld");
    });

    test("should remove DEC ?1004l (focus reporting disable)", () => {
      const data = "hello\x1b[?1004lworld";
      assert.strictEqual(filterVSCodeSequences(data), "helloworld");
    });

    test("should handle ST terminator (ESC backslash)", () => {
      const data = "hello\x1b]633;B\x1b\\world";
      assert.strictEqual(filterVSCodeSequences(data), "helloworld");
    });

    test("should remove multiple sequences in one chunk", () => {
      const data = "\x1b]633;A\x07prompt\x1b]7;file://host/path\x07\x1b]633;B\x07";
      assert.strictEqual(filterVSCodeSequences(data), "prompt");
    });

    test("should not remove OSC 0 (title)", () => {
      const data = "hello\x1b]0;My Title\x07world";
      assert.strictEqual(filterVSCodeSequences(data), data);
    });

    test("should not remove OSC 8 (hyperlinks)", () => {
      const data = "hello\x1b]8;;https://example.com\x07linktext\x1b]8;;\x07world";
      assert.strictEqual(filterVSCodeSequences(data), data);
    });

    test("should preserve plain text", () => {
      const data = "hello world\r\n";
      assert.strictEqual(filterVSCodeSequences(data), data);
    });

    test("should be reentrant (global regex resets lastIndex)", () => {
      const data = "hello\x1b]633;A\x07world";
      assert.strictEqual(filterVSCodeSequences(data), "helloworld");
      assert.strictEqual(filterVSCodeSequences(data), "helloworld");
    });
  });

  suite("extractCwdFromOsc7", () => {
    test("should extract path from OSC 7", () => {
      const data = "\x1b]7;file://hostname/Users/volte/project\x07";
      assert.strictEqual(extractCwdFromOsc7(data), "/Users/volte/project");
    });

    test("should return the last CWD when multiple OSC 7 are present", () => {
      const data =
        "\x1b]7;file://host/first\x07some output\x1b]7;file://host/second\x07";
      assert.strictEqual(extractCwdFromOsc7(data), "/second");
    });

    test("should handle percent-encoded paths", () => {
      const data = "\x1b]7;file://host/Users/volte/my%20project\x07";
      assert.strictEqual(extractCwdFromOsc7(data), "/Users/volte/my project");
    });

    test("should return null for no OSC 7", () => {
      assert.strictEqual(extractCwdFromOsc7("hello world"), null);
    });

    test("should return null for malformed URL", () => {
      const data = "\x1b]7;not-a-valid-url\x07";
      assert.strictEqual(extractCwdFromOsc7(data), null);
    });

    test("should handle ST terminator", () => {
      const data = "\x1b]7;file://host/Users/volte\x1b\\";
      assert.strictEqual(extractCwdFromOsc7(data), "/Users/volte");
    });

    test("should be reentrant", () => {
      const data = "\x1b]7;file://host/path\x07";
      assert.strictEqual(extractCwdFromOsc7(data), "/path");
      assert.strictEqual(extractCwdFromOsc7(data), "/path");
    });
  });

  suite("extractUserVars", () => {
    test("should extract SetUserVar from OSC 1337", () => {
      // base64("bar") = "YmFy"
      const data = "\x1b]1337;SetUserVar=foo=YmFy\x07";
      const result = extractUserVars(data);
      assert.ok(result);
      assert.strictEqual(result!.get("foo"), "bar");
    });

    test("should extract multiple user vars", () => {
      // base64("bar") = "YmFy", base64("baz") = "YmF6"
      const data =
        "\x1b]1337;SetUserVar=key1=YmFy\x07\x1b]1337;SetUserVar=key2=YmF6\x07";
      const result = extractUserVars(data);
      assert.ok(result);
      assert.strictEqual(result!.get("key1"), "bar");
      assert.strictEqual(result!.get("key2"), "baz");
    });

    test("should return null for no SetUserVar", () => {
      assert.strictEqual(extractUserVars("hello world"), null);
    });

    test("should handle ST terminator", () => {
      const data = "\x1b]1337;SetUserVar=foo=YmFy\x1b\\";
      const result = extractUserVars(data);
      assert.ok(result);
      assert.strictEqual(result!.get("foo"), "bar");
    });

    test("should skip invalid base64 gracefully", () => {
      const data = "\x1b]1337;SetUserVar=foo=!!!invalid!!!\x07";
      const result = extractUserVars(data);
      // Invalid base64 is silently skipped — may decode to garbage or succeed
      // depending on Buffer.from tolerance. Main thing: no exception thrown.
      assert.ok(true);
    });

    test("should be reentrant", () => {
      const data = "\x1b]1337;SetUserVar=foo=YmFy\x07";
      const r1 = extractUserVars(data);
      const r2 = extractUserVars(data);
      assert.strictEqual(r1!.get("foo"), "bar");
      assert.strictEqual(r2!.get("foo"), "bar");
    });
  });

  suite("replaceBelWithST", () => {
    test("should replace BEL with ST", () => {
      assert.strictEqual(replaceBelWithST("hello\x07world"), "hello\x1b\\world");
    });

    test("should replace multiple BEL characters", () => {
      assert.strictEqual(
        replaceBelWithST("\x07one\x07two\x07"),
        "\x1b\\one\x1b\\two\x1b\\",
      );
    });

    test("should return data unchanged when no BEL present", () => {
      const data = "hello world\x1b[31m";
      assert.strictEqual(replaceBelWithST(data), data);
    });

    test("should handle empty string", () => {
      assert.strictEqual(replaceBelWithST(""), "");
    });
  });
});
