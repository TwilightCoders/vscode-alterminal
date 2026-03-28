import * as assert from "assert";
import { PtyTestHarness } from "../helpers/ptyTestHarness";

suite("Data Pipeline Integration", () => {
  let harness: PtyTestHarness;

  setup(() => {
    harness = new PtyTestHarness();
  });

  suite("Plain text forwarding", () => {
    test("should forward plain text as data message", () => {
      harness.feedData(1, "hello world\r\n");

      const dataMessages = harness.mockView.messagesOfType("data");
      assert.strictEqual(dataMessages.length, 1);
      assert.strictEqual(dataMessages[0].data, "hello world\r\n");
      assert.strictEqual(dataMessages[0].tabId, 1);
    });

    test("should forward ANSI color sequences unchanged", () => {
      const data = "\x1b[31mred\x1b[0m normal";
      harness.feedData(1, data);

      const msg = harness.mockView.lastOfType("data");
      assert.strictEqual(msg.data, data);
    });

    test("should not produce bell or CWD events for plain text", () => {
      harness.feedData(1, "just text");
      assert.strictEqual(harness.bellEvents.length, 0);
      assert.strictEqual(harness.cwdChanges.length, 0);
    });
  });

  suite("Bell detection through pipeline", () => {
    test("should detect bare BEL and produce bell message", () => {
      harness.feedData(1, "\x07");

      assert.strictEqual(harness.bellEvents.length, 1);
      assert.strictEqual(harness.bellEvents[0], 1);

      const bellMsg = harness.mockView.lastOfType("bell");
      assert.ok(bellMsg);
      assert.strictEqual(bellMsg.tabId, 1);
    });

    test("should replace BEL with ST in forwarded data", () => {
      harness.feedData(1, "before\x07after");

      const dataMsg = harness.mockView.lastOfType("data");
      assert.ok(dataMsg);
      assert.strictEqual(dataMsg.data, "before\x1b\\after");
      assert.ok(!dataMsg.data.includes("\x07"));
    });

    test("should not trigger bell for OSC terminator BEL", () => {
      harness.feedData(1, "\x1b]0;My Title\x07");

      assert.strictEqual(harness.bellEvents.length, 0);
    });

    test("should detect bell mixed with OSC sequences", () => {
      // OSC 633 (filtered) + bare BEL
      harness.feedData(1, "\x1b]633;A\x07\x07");

      assert.strictEqual(harness.bellEvents.length, 1);
    });
  });

  suite("CWD extraction through pipeline", () => {
    test("should extract CWD from OSC 7 and produce cwdChange message", () => {
      harness.feedData(1, "\x1b]7;file://host/Users/volte/project\x07");

      assert.strictEqual(harness.cwdChanges.length, 1);
      assert.strictEqual(harness.cwdChanges[0].cwd, "/Users/volte/project");

      const cwdMsg = harness.mockView.lastOfType("cwdChange");
      assert.ok(cwdMsg);
      assert.strictEqual(cwdMsg.cwd, "/Users/volte/project");
    });

    test("should filter OSC 7 from forwarded data", () => {
      harness.feedData(1, "prompt\x1b]7;file://host/path\x07");

      const dataMsg = harness.mockView.lastOfType("data");
      assert.ok(dataMsg);
      assert.strictEqual(dataMsg.data, "prompt");
    });
  });

  suite("User variable extraction through pipeline", () => {
    test("should extract SetUserVar and produce message", () => {
      harness.feedData(1, "\x1b]1337;SetUserVar=foo=YmFy\x07");

      assert.strictEqual(harness.userVarChanges.length, 1);
      assert.strictEqual(harness.userVarChanges[0].vars.get("foo"), "bar");

      const varMsg = harness.mockView.lastOfType("userVarChange");
      assert.ok(varMsg);
    });

    test("should filter OSC 1337 from forwarded data", () => {
      harness.feedData(1, "text\x1b]1337;SetUserVar=x=eA==\x07more");

      const dataMsg = harness.mockView.lastOfType("data");
      assert.ok(dataMsg);
      assert.strictEqual(dataMsg.data, "textmore");
    });
  });

  suite("VS Code sequence filtering through pipeline", () => {
    test("should strip OSC 633 but forward surrounding text", () => {
      harness.feedData(1, "prompt\x1b]633;A\x07$ ");

      const dataMsg = harness.mockView.lastOfType("data");
      assert.ok(dataMsg);
      assert.strictEqual(dataMsg.data, "prompt$ ");
    });

    test("should strip DEC ?1004 focus reporting", () => {
      harness.feedData(1, "text\x1b[?1004hmore");

      const dataMsg = harness.mockView.lastOfType("data");
      assert.ok(dataMsg);
      assert.strictEqual(dataMsg.data, "textmore");
    });

    test("should not forward empty data after filtering", () => {
      harness.feedData(1, "\x1b]633;A\x07");

      const dataMessages = harness.mockView.messagesOfType("data");
      assert.strictEqual(dataMessages.length, 0);
    });
  });

  suite("Multi-tab isolation", () => {
    test("should track tabs independently", () => {
      harness.feedData(1, "tab1 output");
      harness.feedData(2, "tab2 output");

      const dataMessages = harness.mockView.messagesOfType("data");
      assert.strictEqual(dataMessages.length, 2);
      assert.strictEqual(dataMessages[0].tabId, 1);
      assert.strictEqual(dataMessages[0].data, "tab1 output");
      assert.strictEqual(dataMessages[1].tabId, 2);
      assert.strictEqual(dataMessages[1].data, "tab2 output");
    });

    test("should detect bells per-tab", () => {
      harness.feedData(1, "\x07");
      harness.feedData(2, "\x07");

      assert.deepStrictEqual(harness.bellEvents, [1, 2]);
    });

    test("should handle split OSC across chunks per-tab", () => {
      // Tab 1: split OSC (body in chunk 1)
      harness.feedData(1, "\x1b]7;file://host/path");
      // Tab 2: plain text with BEL
      harness.feedData(2, "\x07");
      // Tab 1: OSC terminator (chunk 2) — BEL is OSC terminator, not bell
      harness.feedData(1, "\x07");

      // Tab 1 should detect CWD but NOT bell
      // Tab 2 should detect bell
      assert.strictEqual(harness.cwdChanges.length, 0); // OSC 7 split across chunks — harness doesn't buffer
      assert.deepStrictEqual(harness.bellEvents, [2]); // Only tab 2 had a real bell
    });
  });

  suite("Hidden webview buffering", () => {
    test("should not forward data when webview is hidden", () => {
      harness.mockView.visible = false;
      harness.feedData(1, "hidden output");

      const dataMessages = harness.mockView.messagesOfType("data");
      assert.strictEqual(dataMessages.length, 0);
    });

    test("should still detect bells when webview is hidden", () => {
      harness.mockView.visible = false;
      harness.feedData(1, "\x07");

      assert.strictEqual(harness.bellEvents.length, 1);
    });

    test("should still extract CWD when webview is hidden", () => {
      harness.mockView.visible = false;
      harness.feedData(1, "\x1b]7;file://host/path\x07");

      assert.strictEqual(harness.cwdChanges.length, 1);
    });
  });

  suite("Complex real-world scenarios", () => {
    test("shell prompt with CWD, integration sequences, and command output", () => {
      // Simulate: shell reports CWD + integration markers, then user sees prompt
      harness.feedData(1,
        "\x1b]7;file://mac/Users/volte/project\x07" +
        "\x1b]633;A\x07" +
        "volte@mac ~/project $ " +
        "\x1b]633;B\x07",
      );

      // CWD should be extracted
      assert.strictEqual(harness.cwdChanges.length, 1);
      assert.strictEqual(harness.cwdChanges[0].cwd, "/Users/volte/project");

      // Data should have integration sequences stripped
      const dataMsg = harness.mockView.lastOfType("data");
      assert.ok(dataMsg);
      assert.strictEqual(dataMsg.data, "volte@mac ~/project $ ");

      // No bell
      assert.strictEqual(harness.bellEvents.length, 0);
    });

    test("program output with embedded bell", () => {
      harness.feedData(1, "Build failed!\x07\r\nSee errors above.\r\n");

      assert.strictEqual(harness.bellEvents.length, 1);

      const dataMsg = harness.mockView.lastOfType("data");
      assert.ok(dataMsg);
      // BEL replaced with ST
      assert.ok(dataMsg.data.includes("Build failed!\x1b\\"));
      assert.ok(dataMsg.data.includes("See errors above."));
    });
  });
});
