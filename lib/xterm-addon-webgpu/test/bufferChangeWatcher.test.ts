import * as assert from "node:assert/strict";
import { watchBufferChanges } from "../src/util/bufferChangeWatcher.js";

/**
 * Regression guard for stale-selection-after-alt-screen-switch.
 *
 * xterm's SelectionService only clears on vertical resize (see
 * SelectionService.ts:158 — "Clear selection when resizing vertically").
 * It does NOT clear when `buffer.active` flips between normal and alt
 * — so an absolute-coord selection captured in the normal buffer will
 * persist into vim/htop/less and paint the wrong cells.
 *
 * We watch xterm's `buffer.onBufferChange` ourselves and drop the
 * cached selection on each switch.
 */
describe("watchBufferChanges", () => {
  function makeFakeBufferNamespace() {
    const listeners: Array<(buf: unknown) => void> = [];
    let disposed = false;
    return {
      onBufferChange: (cb: (buf: unknown) => void) => {
        listeners.push(cb);
        return { dispose: () => { disposed = true; } };
      },
      fire: (buf: unknown) => { for (const cb of listeners) cb(buf); },
      isDisposed: () => disposed,
      listenerCount: () => listeners.length,
    };
  }

  it("invokes onSwitch each time the active buffer changes", () => {
    const fake = makeFakeBufferNamespace();
    let switched = 0;
    watchBufferChanges(fake as any, () => { switched++; });
    assert.equal(switched, 0, "no fire before any switch");
    fake.fire({});
    assert.equal(switched, 1, "fires on first switch (normal → alt)");
    fake.fire({});
    assert.equal(switched, 2, "fires again on subsequent switch (alt → normal)");
  });

  it("subscribes exactly once (no listener pile-up)", () => {
    const fake = makeFakeBufferNamespace();
    watchBufferChanges(fake as any, () => {});
    assert.equal(fake.listenerCount(), 1);
  });

  it("returns a disposable that unsubscribes", () => {
    const fake = makeFakeBufferNamespace();
    const sub = watchBufferChanges(fake as any, () => {});
    sub.dispose();
    assert.equal(fake.isDisposed(), true);
  });

  it("is a no-op when buffer.onBufferChange is missing (defensive)", () => {
    // Older xterm versions or non-standard mocks may not expose the event.
    // Don't crash; just don't subscribe.
    const sub = watchBufferChanges({} as any, () => { throw new Error("should not fire"); });
    assert.equal(typeof sub.dispose, "function");
    sub.dispose(); // safe even with no real subscription
  });
});
