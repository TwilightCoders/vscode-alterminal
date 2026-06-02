import * as assert from "assert";
import { refocusActiveTerminal } from "../../src/webview/refocus";

/**
 * Regression guard for the focus-steal root cause.
 *
 * The webview "focus" message handler was a no-op for the project's entire
 * life: it fetched the active terminal and THREW THE RESULT AWAY, never calling
 * .focus(). That is the final, load-bearing step of every focus-reclaim path
 * (FocusGuard's show(false) reclaim and the serializer's restore-focus), so
 * keyboard focus could never be re-landed on the xterm textarea after a
 * transient blur. WebGL masked it by holding focus robustly; the WebGPU async
 * renderer hot-swap widened the transient-blur window and unmasked it as the
 * "mid-keystroke focus jumps to VS Code's terminal" symptom.
 *
 * The original FocusGuard shipped with timing-logic tests but nothing asserted
 * the reclaim's final DOM step actually fires — which is exactly why the no-op
 * survived. These tests pin that contract.
 */
suite("refocusActiveTerminal", () => {
  test("schedules focus() on the active terminal (deferred, not synchronous)", () => {
    let focused = 0;
    const tasks: Array<() => void> = [];
    const ok = refocusActiveTerminal(
      { focus: () => { focused++; } },
      (cb) => tasks.push(cb),
    );
    assert.strictEqual(ok, true);
    assert.strictEqual(focused, 0, "must defer to the scheduled frame, not focus inline");
    tasks.forEach((t) => t());
    assert.strictEqual(focused, 1, "fires exactly once on the scheduled frame");
  });

  test("REGRESSION: the reclaim's final DOM step actually fires (not a discard no-op)", () => {
    let focused = false;
    refocusActiveTerminal({ focus: () => { focused = true; } }, (cb) => cb());
    assert.ok(focused, "the active terminal must be focused, not fetched-and-discarded");
  });

  test("no-op for a null active terminal (returns false, schedules nothing)", () => {
    let scheduled = 0;
    const ok = refocusActiveTerminal(null, () => { scheduled++; });
    assert.strictEqual(ok, false);
    assert.strictEqual(scheduled, 0);
  });

  test("no-op when the active terminal has no focus() method", () => {
    const ok = refocusActiveTerminal(
      {} as unknown as { focus?: () => void },
      () => { throw new Error("must not schedule"); },
    );
    assert.strictEqual(ok, false);
  });

  test("swallows a focus() that throws (terminal disposed between schedule and fire)", () => {
    const tasks: Array<() => void> = [];
    refocusActiveTerminal(
      { focus: () => { throw new Error("disposed"); } },
      (cb) => tasks.push(cb),
    );
    assert.doesNotThrow(() => tasks.forEach((t) => t()));
  });
});
