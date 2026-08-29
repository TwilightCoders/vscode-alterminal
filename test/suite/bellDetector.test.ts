import * as assert from "assert";
import { BellDetector } from "../../src/terminal/bellDetector";

suite("BellDetector Test Suite", () => {
  let detector: BellDetector;

  setup(() => {
    detector = new BellDetector();
  });

  test("detects a bare BEL character", () => {
    assert.strictEqual(detector.detect(1, "\x07"), true);
  });

  test("detects BEL mixed with plain text", () => {
    assert.strictEqual(detector.detect(1, "hello\x07world"), true);
  });

  test("ignores data without BEL", () => {
    assert.strictEqual(detector.detect(1, "hello world"), false);
  });

  test("ignores BEL inside a complete OSC sequence", () => {
    // OSC 7 (CWD reporting) uses \x07 as terminator
    assert.strictEqual(detector.detect(1, "\x1b]7;file://host/path\x07"), false);
  });

  test("ignores BEL inside OSC 633 (shell integration)", () => {
    assert.strictEqual(detector.detect(1, "\x1b]633;A\x07"), false);
  });

  test("ignores BEL inside OSC 0 (title setting)", () => {
    assert.strictEqual(detector.detect(1, "\x1b]0;My Terminal\x07"), false);
  });

  test("detects BEL after a complete OSC sequence", () => {
    assert.strictEqual(detector.detect(1, "\x1b]633;A\x07\x07"), true);
  });

  test("ignores multiple complete OSC sequences", () => {
    assert.strictEqual(
      detector.detect(1, "\x1b]633;A\x07\x1b]7;file://host/path\x07"),
      false,
    );
  });

  test("handles OSC terminated by ST (ESC backslash)", () => {
    assert.strictEqual(detector.detect(1, "\x1b]633;A\x1b\\"), false);
  });

  // --- Chunked data tests ---

  test("split OSC: body in chunk 1, terminator in chunk 2", () => {
    // Chunk 1: incomplete OSC
    assert.strictEqual(detector.detect(1, "\x1b]7;file://host/path"), false);
    // Chunk 2: just the terminator — should NOT be treated as BEL
    assert.strictEqual(detector.detect(1, "\x07"), false);
  });

  test("split OSC 633: body in chunk 1, terminator in chunk 2", () => {
    assert.strictEqual(detector.detect(1, "\x1b]633;C"), false);
    assert.strictEqual(detector.detect(1, "\x07"), false);
  });

  test("split OSC followed by real BEL in same chunk", () => {
    assert.strictEqual(detector.detect(1, "\x1b]7;file://host/path"), false);
    // Chunk 2: OSC terminator + real BEL
    assert.strictEqual(detector.detect(1, "\x07\x07"), true);
  });

  test("split OSC followed by real BEL in later chunk", () => {
    assert.strictEqual(detector.detect(1, "\x1b]7;file://host/path"), false);
    assert.strictEqual(detector.detect(1, "\x07"), false); // OSC terminator
    assert.strictEqual(detector.detect(1, "\x07"), true);  // real BEL
  });

  test("real BEL before a split OSC", () => {
    assert.strictEqual(detector.detect(1, "\x07\x1b]633;A"), true);
    assert.strictEqual(detector.detect(1, "\x07"), false); // OSC terminator
  });

  test("multiple tabs tracked independently", () => {
    // Tab 1 starts an incomplete OSC
    assert.strictEqual(detector.detect(1, "\x1b]7;file://host/path"), false);
    // Tab 2 gets a real BEL — should fire (tab 2 is not in an OSC)
    assert.strictEqual(detector.detect(2, "\x07"), true);
    // Tab 1 gets the terminator — should not fire
    assert.strictEqual(detector.detect(1, "\x07"), false);
  });

  test("OSC state resets after terminator received", () => {
    assert.strictEqual(detector.detect(1, "\x1b]633;A"), false);
    assert.strictEqual(detector.detect(1, "\x07"), false); // terminates the OSC
    // Next BEL should be detected as real
    assert.strictEqual(detector.detect(1, "\x07"), true);
  });

  test("OSC terminated by ST across chunks", () => {
    assert.strictEqual(detector.detect(1, "\x1b]633;A"), false);
    assert.strictEqual(detector.detect(1, "\x1b\\"), false); // ST terminator
    assert.strictEqual(detector.detect(1, "\x07"), true); // real BEL
  });

  test("cleanup removes tab state", () => {
    detector.detect(1, "\x1b]633;A"); // start incomplete OSC
    detector.delete(1);
    // After delete, tab 1 has no pending OSC — BEL should fire
    assert.strictEqual(detector.detect(1, "\x07"), true);
  });

  test("plain text chunks don't affect OSC state", () => {
    assert.strictEqual(detector.detect(1, "\x1b]633;A"), false);
    assert.strictEqual(detector.detect(1, "plain text"), false);
    // Still in OSC — terminator should not be treated as BEL
    assert.strictEqual(detector.detect(1, "\x07"), false);
  });

  test("empty string is safe", () => {
    assert.strictEqual(detector.detect(1, ""), false);
  });

  // ──────────────────────────────────────────────────────────────────
  // Agent-notification escapes (Claude Code, etc.)
  // ──────────────────────────────────────────────────────────────────

  test("detects iTerm2 OSC 9 notification (Claude end-of-turn)", () => {
    assert.strictEqual(
      detector.detect(1, "\x1b]9;Claude is waiting for your input\x07"),
      true,
    );
  });

  test("detects iTerm2 OSC 9 with ST terminator", () => {
    assert.strictEqual(
      detector.detect(1, "\x1b]9;some message\x1b\\"),
      true,
    );
  });

  test("ignores OSC 9;4 progress sequences (NOT a bell)", () => {
    // iTerm2 progress-bar sub-protocol — Claude emits these during long tool calls.
    // Must NOT trigger a bell or every long operation false-flashes.
    assert.strictEqual(
      detector.detect(1, "\x1b]9;4;1;50\x07"),
      false,
    );
  });

  test("ignores OSC 9;4 progress with ST terminator", () => {
    assert.strictEqual(
      detector.detect(1, "\x1b]9;4;1;25\x1b\\"),
      false,
    );
  });

  test("detects kitty OSC 99 notification", () => {
    assert.strictEqual(
      detector.detect(1, "\x1b]99;d=1:p=title;Claude needs input\x07"),
      true,
    );
  });

  test("detects ghostty OSC 777 notification", () => {
    assert.strictEqual(
      detector.detect(1, "\x1b]777;notify;Claude Code;Awaiting input\x07"),
      true,
    );
  });

  test("OSC 9 mixed with regular output still triggers bell", () => {
    assert.strictEqual(
      detector.detect(1, "some output\n\x1b]9;Claude is waiting\x07more output\n"),
      true,
    );
  });

  test("BEL fires even when chunk also contains OSC 9 progress", () => {
    // Progress alone wouldn't fire; bare BEL still should.
    assert.strictEqual(
      detector.detect(1, "\x1b]9;4;1;75\x07hello\x07"),
      true,
    );
  });

  test("OSC 9 from a different tab is still detected", () => {
    assert.strictEqual(
      detector.detect(42, "\x1b]9;Claude is waiting for your input\x07"),
      true,
    );
  });

  test("conhost's injected OSC 0 title is not a bell (Windows startup)", () => {
    // Measured on Windows Server 2025: a ConPTY emits a preamble before the
    // child writes anything, and it ends with a BEL-terminated OSC 0 naming
    // the child's exe. A naive `indexOf("\x07")` therefore reports a bell on
    // EVERY fresh Windows session, deterministically, with no bell involved.
    // These are the actual bytes off the wire.
    const d = new BellDetector();
    const conhostPreamble =
      "\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H" +
      "\x1b]0;C:\\Windows\\System32\\cmd.exe\x07\x1b[?25h";

    assert.strictEqual(d.detect(1, conhostPreamble), false);
  });

  test("a real BEL still fires alongside conhost's injected title", () => {
    // The guard must not overcorrect into swallowing genuine bells that
    // arrive in the same chunk as the injected title.
    const d = new BellDetector();
    assert.strictEqual(
      d.detect(1, "\x1b]0;C:\\Windows\\System32\\cmd.exe\x07ding\x07"),
      true,
    );
  });

});
