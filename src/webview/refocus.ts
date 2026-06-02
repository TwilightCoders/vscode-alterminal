/**
 * Refocus the active terminal's xterm textarea — the final, load-bearing step
 * of every focus-reclaim/restore path.
 *
 * History: the webview "focus" message handler was a no-op for the project's
 * entire life (it fetched the active terminal and discarded it), so neither the
 * FocusGuard reclaim nor the serializer's restore-focus could ever land
 * keyboard focus back on the textarea. WebGL masked this by holding focus
 * robustly; the WebGPU async renderer hot-swap widened the transient-blur
 * window and unmasked it as a mid-keystroke focus steal to VS Code's terminal.
 *
 * Deferred one frame via `schedule` (requestAnimationFrame in the webview) so
 * any concurrent panel-level focus transition settles first — frame/event
 * driven, no timer or magic-number delay.
 */
export interface Focusable {
  focus?: () => void;
}

/**
 * Schedule a focus() on `active`. Returns true if a focus was scheduled,
 * false if there was nothing focusable (so callers/tests can assert the
 * final DOM step is reached rather than silently dropped).
 */
export function refocusActiveTerminal(
  active: Focusable | null | undefined,
  schedule: (cb: () => void) => void,
): boolean {
  if (!active || typeof active.focus !== "function") {
    return false;
  }
  schedule(() => {
    try {
      active.focus!();
    } catch {
      /* terminal may have been disposed between schedule and fire */
    }
  });
  return true;
}
