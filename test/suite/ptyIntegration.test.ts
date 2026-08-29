import * as assert from "assert";
import * as pty from "@lydell/node-pty";
import { PtyTestHarness } from "../helpers/ptyTestHarness";

/**
 * Tier 3: Real PTY integration tests.
 *
 * These spawn actual shell processes and feed their output through the
 * data pipeline harness. They verify end-to-end behavior: real escape
 * sequences from real programs → correct detection and filtering.
 *
 * These tests are slower (~1-3s each) due to process spawning.
 */
suite("PTY Integration", () => {
  let harness: PtyTestHarness;

  setup(() => {
    harness = new PtyTestHarness();
  });

  /**
   * Helper: spawn a shell, run a command, collect output through harness.
   * Returns a promise that resolves when the process exits.
   */
  function runInPty(
    command: string,
    tabId = 1,
  ): Promise<{ exitCode: number }> {
    return new Promise((resolve) => {
      const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
      const args = process.platform === "win32" ? ["/c", command] : ["-c", command];

      const proc = pty.spawn(shell, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERM: "xterm-256color",
          // Suppress shell integration scripts that may be injected
          ALTERMINAL_SHELL_INTEGRATION: "0",
        },
      });

      proc.onData((data: string) => {
        harness.feedData(tabId, data);
      });

      proc.onExit(({ exitCode }) => {
        resolve({ exitCode });
      });
    });
  }


  /**
   * Emit an EXACT byte sequence from a real PTY, on any platform.
   *
   * The escape-sequence tests below originally used shell `printf` and
   * `$(hostname)`, which cmd.exe does not have — on Windows they emitted
   * nothing and the assertions failed with "got 0 events", looking like
   * detection bugs when the detection logic was fine.
   *
   * Two things make this portable:
   *
   *  - **Every byte is passed as a NUMBER**, never as a quoted literal. Control
   *    characters and quotes never appear on a command line, so neither shell
   *    can mangle them (node-pty's Windows quoting silently corrupts args
   *    containing spaces or quotes, and a corrupted arg means the child never
   *    runs at all).
   *  - **The child is console-subsystem on both platforms.** On Windows that is
   *    powershell.exe — deliberately NOT `process.execPath`, which under the VS
   *    Code test host is Electron: a GUI-subsystem binary produces ZERO output
   *    when attached directly to a ConPTY (measured on Windows Server 2025),
   *    exiting cleanly, which is indistinguishable from a program that ran and
   *    printed nothing.
   */
  function emitFromPty(bytes: string, tabId = 1): Promise<{ exitCode: number }> {
    return new Promise((resolve) => {
      const codes = Array.from(bytes).map((c) => c.charCodeAt(0));
      let exe: string;
      let args: string[];

      if (process.platform === "win32") {
        exe = "powershell.exe";
        args = [
          "-NoProfile",
          "-Command",
          `[Console]::Out.Write([char[]](${codes.join(",")}) -join '')`,
        ];
      } else {
        exe = "/bin/sh";
        args = ["-c", `printf '${codes.map((n) => "\\" + n.toString(8).padStart(3, "0")).join("")}'`];
      }

      const proc = pty.spawn(exe, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: { ...process.env, TERM: "xterm-256color", ALTERMINAL_SHELL_INTEGRATION: "0" },
      });
      proc.onData((data: string) => harness.feedData(tabId, data));
      proc.onExit(({ exitCode }) => resolve({ exitCode }));
    });
  }

  test("should produce data messages from shell output", async function () {
    this.timeout(5000);
    await runInPty('echo "hello from pty"');

    const dataMessages = harness.mockView.messagesOfType("data");
    assert.ok(dataMessages.length > 0, "Should have received data messages");

    const allData = dataMessages.map((m) => m.data).join("");
    assert.ok(
      allData.includes("hello from pty"),
      `Output should contain expected text, got: ${JSON.stringify(allData.substring(0, 200))}`,
    );
  });

  test("should detect bell from echo command", async function () {
    this.timeout(5000);
    await emitFromPty("\x07");

    // The BEL character from echo -e '\a' should trigger bell detection
    assert.ok(
      harness.bellEvents.length > 0,
      `Should have detected bell, got ${harness.bellEvents.length} events`,
    );
  });

  test("should detect bell from printf command", async function () {
    this.timeout(5000);
    await emitFromPty("bel:\x07");

    assert.ok(
      harness.bellEvents.length > 0,
      `Should have detected bell from printf, got ${harness.bellEvents.length} events`,
    );
  });

  test("should extract CWD from OSC 7 emitted by printf", async function () {
    this.timeout(5000);
    const testPath = "/tmp";
    await emitFromPty(`\x1b]7;file://localhost${testPath}\x07`);

    assert.ok(
      harness.cwdChanges.length > 0,
      `Should have detected CWD change, got ${harness.cwdChanges.length}`,
    );
    assert.strictEqual(harness.cwdChanges[0].cwd, testPath);
  });

  test("should filter VS Code shell integration sequences", async function () {
    this.timeout(5000);
    // Emit OSC 633 (VS Code shell integration) — should be stripped
    await emitFromPty("\x1b]633;A\x07visible text\x1b]633;B\x07");

    const allData = harness.mockView
      .messagesOfType("data")
      .map((m) => m.data)
      .join("");

    assert.ok(
      allData.includes("visible text"),
      "Visible text should be forwarded",
    );
    assert.ok(
      !allData.includes("633"),
      `OSC 633 should be filtered, got: ${JSON.stringify(allData.substring(0, 200))}`,
    );
  });

  test("should handle process exit cleanly", async function () {
    this.timeout(5000);
    const result = await runInPty("exit 0");
    assert.strictEqual(result.exitCode, 0);
  });

  test("should handle multi-tab isolation with real PTYs", async function () {
    this.timeout(10000);

    // Run two PTY processes on different tabs
    await Promise.all([
      runInPty('echo "tab1"', 1),
      runInPty('echo "tab2"', 2),
    ]);

    const tab1Data = harness.mockView
      .messagesOfType("data")
      .filter((m) => m.tabId === 1)
      .map((m) => m.data)
      .join("");

    const tab2Data = harness.mockView
      .messagesOfType("data")
      .filter((m) => m.tabId === 2)
      .map((m) => m.data)
      .join("");

    assert.ok(tab1Data.includes("tab1"), "Tab 1 should have its output");
    assert.ok(tab2Data.includes("tab2"), "Tab 2 should have its output");
  });
});
