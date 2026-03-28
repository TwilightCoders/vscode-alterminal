import * as assert from "assert";

/**
 * FocusGuard logic tests.
 *
 * FocusGuard imports vscode, so we can't import it directly in plain Mocha.
 * Instead we test the core timing logic by reimplementing it here. The
 * actual FocusGuard uses these same constants and the same elapsed-time
 * check. This validates the algorithm; the VS Code event wiring is covered
 * by extension integration tests.
 */

const INTERACTION_WINDOW_MS = 2000;

/**
 * Minimal reimplementation of FocusGuard's reclaim decision.
 * Returns true if focus should be reclaimed, false if allowed.
 */
function shouldReclaimFocus(
  lastInteraction: number,
  now: number,
  hasView: boolean,
): boolean {
  if (!hasView) return false;
  const elapsed = now - lastInteraction;
  return elapsed <= INTERACTION_WINDOW_MS;
}

suite("FocusGuard Logic", () => {
  suite("Interaction window", () => {
    test("should reclaim when interaction was recent (within 2s)", () => {
      const now = Date.now();
      assert.strictEqual(shouldReclaimFocus(now - 100, now, true), true);
    });

    test("should reclaim at exactly the window boundary", () => {
      const now = Date.now();
      assert.strictEqual(
        shouldReclaimFocus(now - INTERACTION_WINDOW_MS, now, true),
        true,
      );
    });

    test("should allow through when interaction was long ago (>2s)", () => {
      const now = Date.now();
      assert.strictEqual(
        shouldReclaimFocus(now - INTERACTION_WINDOW_MS - 1, now, true),
        false,
      );
    });

    test("should allow through when no interaction ever recorded", () => {
      const now = Date.now();
      assert.strictEqual(shouldReclaimFocus(0, now, true), false);
    });

    test("should not reclaim when no view attached", () => {
      const now = Date.now();
      assert.strictEqual(shouldReclaimFocus(now - 100, now, false), false);
    });
  });

  suite("Timing edge cases", () => {
    test("should handle simultaneous interaction and activation", () => {
      const now = Date.now();
      // elapsed = 0ms — should reclaim
      assert.strictEqual(shouldReclaimFocus(now, now, true), true);
    });

    test("should handle rapid repeated activations", () => {
      const now = Date.now();
      const lastInteraction = now - 500;

      // Multiple activations within window should all return true
      assert.strictEqual(shouldReclaimFocus(lastInteraction, now, true), true);
      assert.strictEqual(shouldReclaimFocus(lastInteraction, now + 100, true), true);
      assert.strictEqual(shouldReclaimFocus(lastInteraction, now + 500, true), true);
    });

    test("should transition from reclaim to allow as time passes", () => {
      const interactionTime = 1000;

      // Within window — reclaim
      assert.strictEqual(
        shouldReclaimFocus(interactionTime, interactionTime + 1000, true),
        true,
      );

      // At boundary — reclaim
      assert.strictEqual(
        shouldReclaimFocus(interactionTime, interactionTime + INTERACTION_WINDOW_MS, true),
        true,
      );

      // Past boundary — allow
      assert.strictEqual(
        shouldReclaimFocus(interactionTime, interactionTime + INTERACTION_WINDOW_MS + 1, true),
        false,
      );
    });
  });
});
