import * as assert from "assert";
import * as os from "os";
import { PtyManager } from "../../src/terminal/ptyManager";
import { MockWebview } from "../helpers/mockWebview";

/**
 * Regression for the daemon-absent → direct-mode fallback bug (the work-mac
 * "renders a prompt but takes no input" incident).
 *
 * Reproduces the exact EXTENSION-side condition: `ptyDaemon.enabled` but the
 * daemon never connected (so the manager is in direct mode), and a tab is
 * created carrying a daemon UUID — as a restored session would. Asserts that
 * keystrokes written via `writeToPty` actually reach the spawned pty and echo
 * back through the data channel.
 *
 * If this passes, the extension's direct path is sound and the fallback bug is
 * webview-side (restore wiring). If it fails, the bug is here.
 */
suite("Direct-mode PTY input (daemon absent)", () => {
  let mgr: PtyManager;
  let view: MockWebview;
  const TAB = 1;

  setup(() => {
    mgr = new PtyManager();
    view = new MockWebview();
    // setAlterminal subscribes to onDidChangeVisibility — stub it.
    (view as unknown as { onDidChangeVisibility: () => { dispose(): void } }).onDidChangeVisibility =
      () => ({ dispose() {} });
    mgr.setAlterminal(view as never);
    // Deliberately NO setDaemonClient(...) — `_daemonClient` stays null, which
    // is exactly the state after "Failed to spawn PTY daemon → using direct
    // mode".
  });

  teardown(() => {
    try {
      mgr.disposePtyProcess(TAB);
    } catch {
      /* ignore */
    }
  });

  test("writeToPty reaches a direct-mode pty created with a (restored) daemon UUID", async function () {
    this.timeout(15000);

    // Restore a tab that previously lived in the daemon: it carries a UUID, but
    // the daemon is gone, so this must fall back to a fresh direct spawn.
    mgr.createPtyProcess(
      TAB,
      "default",
      undefined,
      80,
      24,
      os.homedir(),
      undefined,
      "restored-uuid-abc123",
    );

    // Wait for the shell to come up (it emits prompt output), then let it settle.
    await waitFor(
      () => view.messagesOfType("data").length > 0,
      8000,
      "shell never produced any output (direct spawn failed)",
    );
    await delay(400);

    const marker = `REPRO_${Date.now()}`;
    view.reset();
    mgr.writeToPty(`echo ${marker}\r`, TAB);

    // The pty must echo the typed command (and its output) back to us.
    await waitFor(
      () =>
        view
          .messagesOfType("data")
          .map((m) => m.data)
          .join("")
          .includes(marker),
      8000,
      "input never reached the pty — no echo of the typed marker (reproduces the bug)",
    );

    const out = view
      .messagesOfType("data")
      .map((m) => m.data)
      .join("");
    assert.ok(
      out.includes(marker),
      `expected the pty to echo the typed marker, got: ${JSON.stringify(out.slice(0, 200))}`,
    );
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number, msg: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${msg}`);
    await delay(50);
  }
}
