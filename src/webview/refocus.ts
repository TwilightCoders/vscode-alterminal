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
 *
 * Self-verifying retry: VS Code can re-fire its OWN focus (to the integrated
 * terminal) on a later frame, AFTER ours. When a `verifyFocused` check is
 * supplied, the reclaim verifies on the next frame that focus actually landed
 * on an xterm textarea and, if not, refocuses once more. Bounded to a single
 * retry so it can never become a focus-fighting loop.
 */
export interface Focusable {
  focus?: () => void;
}

/**
 * Whether keyboard focus currently rests on an xterm textarea — i.e. focus is
 * inside one of our terminals rather than stolen away. Pure over the passed
 * `activeElement` (e.g. `document.activeElement`) so the self-verify decision is
 * testable without a DOM.
 */
export function isXtermTextareaFocused(
  activeElement: { classList?: { contains(token: string): boolean } } | null | undefined,
): boolean {
  return !!activeElement?.classList?.contains?.("xterm-helper-textarea");
}

/**
 * Schedule a focus() on `active`. Returns true if a focus was scheduled,
 * false if there was nothing focusable (so callers/tests can assert the
 * final DOM step is reached rather than silently dropped).
 *
 * If `verifyFocused` is given, a single self-verifying retry is scheduled on the
 * frame after the focus: if focus didn't land, refocus once more.
 */
export function refocusActiveTerminal(
  active: Focusable | null | undefined,
  schedule: (cb: () => void) => void,
  verifyFocused?: () => boolean,
): boolean {
  if (!active || typeof active.focus !== "function") {
    return false;
  }
  const doFocus = () => {
    try {
      active.focus!();
    } catch {
      /* terminal may have been disposed between schedule and fire */
    }
  };
  schedule(() => {
    doFocus();
    if (verifyFocused) {
      schedule(() => {
        // Retry exactly once if focus didn't settle on our textarea.
        if (!verifyFocused()) {
          doFocus();
        }
      });
    }
  });
  return true;
}
