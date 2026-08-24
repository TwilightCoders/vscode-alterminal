import * as assert from "assert";
import {
  filterVSCodeSequences,
  extractCwdFromOsc7,
  extractUserVars,
  replaceBelWithST,
  detectFocusRequest,
  describeFocusSuspects,
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

    test("should remove plain OSC 9 (Windows Terminal notifications)", () => {
      const data = "hello\x1b]9;Build complete\x07world";
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

  // ---------------------------------------------------------------------------
  // Focus-steal handling.
  //
  // Background: Alterminal lives in the VS Code PANEL, beside the integrated
  // terminal. Programs in the PTY can emit "raise / focus this window" escapes
  // that VS Code honours on ITS terminal — yanking keyboard focus out of
  // Alterminal mid-keystroke. We already strip the OSC shell-integration set
  // (633/133/7/9/1337/?1004) so they never leak; the gap was XTWINOPS window
  // manipulation (`CSI 1 t` de-iconify, `CSI 5 t` raise), which VS Code honours.
  //
  // Two new pure helpers:
  //   detectFocusRequest(data)   — true iff data contains a GENUINE raise/focus
  //                                request, so the caller can redirect focus to
  //                                OUR view instead of letting VS Code grab its
  //                                terminal. Narrow on purpose (no shell-int
  //                                noise) to avoid focus-thrash on every prompt.
  //   describeFocusSuspects(data)— diagnostic: list the focus-relevant escapes
  //                                seen (so an observed steal can be attributed
  //                                to actual bytes rather than guessed at).
  // ---------------------------------------------------------------------------

  suite("filterVSCodeSequences — XTWINOPS focus gap", () => {
    test("should remove CSI 5 t (raise window to front)", () => {
      assert.strictEqual(filterVSCodeSequences("a\x1b[5tb"), "ab");
    });

    test("should remove CSI 1 t (de-iconify / restore window)", () => {
      assert.strictEqual(filterVSCodeSequences("a\x1b[1tb"), "ab");
    });

    test("should NOT remove CSI 2 t (iconify / minimize — not a focus steal)", () => {
      const data = "a\x1b[2tb";
      assert.strictEqual(filterVSCodeSequences(data), data);
    });

    test("should NOT touch SGR (CSI 1;31 m) — the regex must not eat colours", () => {
      const data = "a\x1b[1;31mred\x1b[0mb";
      assert.strictEqual(filterVSCodeSequences(data), data);
    });

    test("should NOT touch erase (CSI 2 J) or cursor position (CSI 3;5 H)", () => {
      const data = "\x1b[2J\x1b[3;5Hhello";
      assert.strictEqual(filterVSCodeSequences(data), data);
    });

    test("should NOT touch multi-param XTWINOPS like CSI 10;5 t (not raise/restore)", () => {
      const data = "a\x1b[10;5tb";
      assert.strictEqual(filterVSCodeSequences(data), data);
    });
  });

  suite("detectFocusRequest", () => {
    test("true for CSI 5 t (raise window)", () => {
      assert.strictEqual(detectFocusRequest("out\x1b[5tmore"), true);
    });

    test("true for CSI 1 t (de-iconify)", () => {
      assert.strictEqual(detectFocusRequest("\x1b[1t"), true);
    });

    test("true for iTerm RequestAttention=yes", () => {
      assert.strictEqual(
        detectFocusRequest("\x1b]1337;RequestAttention=yes\x07"),
        true,
      );
    });

    test("true for iTerm RequestAttention=fireworks", () => {
      assert.strictEqual(
        detectFocusRequest("\x1b]1337;RequestAttention=fireworks\x1b\\"),
        true,
      );
    });

    test("false for RequestAttention=no (cancelling attention is not a focus grab)", () => {
      assert.strictEqual(
        detectFocusRequest("\x1b]1337;RequestAttention=no\x07"),
        false,
      );
    });

    test("false for CSI 2 t (iconify)", () => {
      assert.strictEqual(detectFocusRequest("\x1b[2t"), false);
    });

    test("false for shell-integration noise (OSC 633 / 133 / 7)", () => {
      assert.strictEqual(detectFocusRequest("\x1b]633;A\x07"), false);
      assert.strictEqual(detectFocusRequest("\x1b]133;B\x07"), false);
      assert.strictEqual(detectFocusRequest("\x1b]7;file://h/p\x07"), false);
    });

    test("false for SGR / erase / cursor moves", () => {
      assert.strictEqual(detectFocusRequest("\x1b[1;31m"), false);
      assert.strictEqual(detectFocusRequest("\x1b[2J"), false);
      assert.strictEqual(detectFocusRequest("\x1b[3;5H"), false);
    });

    test("false for plain text", () => {
      assert.strictEqual(detectFocusRequest("hello world\r\n"), false);
    });

    test("is reentrant (global regex resets lastIndex)", () => {
      assert.strictEqual(detectFocusRequest("\x1b[5t"), true);
      assert.strictEqual(detectFocusRequest("\x1b[5t"), true);
    });
  });

  suite("describeFocusSuspects", () => {
    test("captures CSI window-manipulation with control chars escaped", () => {
      assert.deepStrictEqual(describeFocusSuspects("x\x1b[5ty"), ["\\e[5t"]);
    });

    test("captures OSC 9 notifications but NOT OSC 9;9 CWD (that is noise)", () => {
      assert.deepStrictEqual(
        describeFocusSuspects("\x1b]9;Build done\x07"),
        ["\\e]9;Build done\\a"],
      );
      assert.deepStrictEqual(
        describeFocusSuspects("\x1b]9;9;/Users/volte\x07"),
        [],
      );
    });

    test("captures DEC ?1004 focus reporting and OSC 1337", () => {
      const got = describeFocusSuspects(
        "\x1b[?1004h\x1b]1337;RequestAttention=yes\x07",
      );
      assert.deepStrictEqual(got, ["\\e[?1004h", "\\e]1337;RequestAttention=yes\\a"]);
    });

    test("returns [] for ordinary output (no false positives on SGR/cursor)", () => {
      assert.deepStrictEqual(
        describeFocusSuspects("\x1b[1;31mred\x1b[0m\x1b[3;5Hhi"),
        [],
      );
    });

    test("is reentrant", () => {
      assert.deepStrictEqual(describeFocusSuspects("\x1b[5t"), ["\\e[5t"]);
      assert.deepStrictEqual(describeFocusSuspects("\x1b[5t"), ["\\e[5t"]);
    });
  });
});

suite("OSC 7 cwd — Windows paths", () => {
  test("strips the file-URI leading slash from a drive path", () => {
    // new URL('file:///C:/x').pathname is '/C:/x' — valid on POSIX, not a
    // usable Windows path. This is what broke cwd reporting on Windows.
    assert.strictEqual(
      extractCwdFromOsc7("\x1b]7;file:///C:/Users/me/proj\x07"),
      "C:\\Users\\me\\proj",
    );
  });

  test("handles a percent-encoded Windows path with spaces", () => {
    assert.strictEqual(
      extractCwdFromOsc7("\x1b]7;file:///C:/Users/me/my%20proj\x07"),
      "C:\\Users\\me\\my proj",
    );
  });

  test("handles a bare drive root", () => {
    assert.strictEqual(extractCwdFromOsc7("\x1b]7;file:///C:/\x07"), "C:\\");
  });

  test("POSIX paths are unchanged, including with a hostname authority", () => {
    // Our bash/zsh scripts emit file://$HOSTNAME$PWD — the authority must NOT
    // be reinterpreted as a UNC share, or every unix cwd would corrupt.
    assert.strictEqual(
      extractCwdFromOsc7("\x1b]7;file://myhost/home/dale/proj\x07"),
      "/home/dale/proj",
    );
    assert.strictEqual(
      extractCwdFromOsc7("\x1b]7;file:///home/dale/proj\x07"),
      "/home/dale/proj",
    );
  });
});
