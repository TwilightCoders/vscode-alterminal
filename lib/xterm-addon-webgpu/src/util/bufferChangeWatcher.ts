/**
 * Subscribe to xterm's `buffer.onBufferChange` (normal ↔ alt buffer
 * switch) and invoke a callback so the renderer can drop state tied to
 * the previous buffer.
 *
 * The motivating case: an active selection. xterm's SelectionService
 * only clears on vertical resize — switching `buffer.active` between
 * normal and alt does NOT clear it. So an absolute-coord selection
 * captured in the normal buffer would otherwise persist into vim/htop
 * and paint the wrong cells. Other buffer-tied caches (link underline
 * spans, cursor history, etc.) should drop on the same event.
 *
 * Defensive: if `buffer.onBufferChange` is missing (older xterm, mock
 * objects), returns a no-op disposable rather than throwing — the
 * renderer still works; it just doesn't auto-drop on switch.
 */
export interface IDisposable {
  dispose(): void;
}

export interface IBufferNamespaceLike {
  onBufferChange?: (cb: (buf: unknown) => void) => IDisposable;
}

const NOOP_DISPOSABLE: IDisposable = { dispose: () => { /* no-op */ } };

export function watchBufferChanges(
  bufferNamespace: IBufferNamespaceLike,
  onSwitch: () => void,
): IDisposable {
  if (typeof bufferNamespace?.onBufferChange !== "function") {
    return NOOP_DISPOSABLE;
  }
  return bufferNamespace.onBufferChange(() => onSwitch());
}
