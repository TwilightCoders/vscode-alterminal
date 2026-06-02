/**
 * Focus preservation across the async WebGPU renderer hot-swap.
 *
 * Unlike WebGL, a WebGPU device is acquired asynchronously, so the addon swaps
 * its renderer into xterm's render service one or more frames after activate().
 * If the user was typing — keyboard focus on xterm's `.xterm-helper-textarea` —
 * when the swap lands, the DOM churn of replacing the render layer can
 * transiently blur the textarea, long enough for VS Code's panel to route focus
 * to its own integrated terminal. That transient blur is the *source* the
 * top-level focus reclaim only reacts to after the fact.
 *
 * The addon closes it at the source with a one-shot capture-and-restore around
 * the swap: capture `document.activeElement` immediately before `setRenderer`,
 * and if it was the textarea, refocus the textarea immediately after — making
 * the hot-swap invisible and denying the integrated terminal the gap.
 *
 * This pure predicate isolates the "should we restore?" decision so it can be
 * unit-tested without a DOM. `activeBefore` is the captured active element;
 * `textarea` is the terminal's helper textarea (or null if not found).
 */
export function shouldRestoreFocus(
  activeBefore: unknown,
  textarea: unknown,
): boolean {
  return textarea != null && activeBefore === textarea;
}
