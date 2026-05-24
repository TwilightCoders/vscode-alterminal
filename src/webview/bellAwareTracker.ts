/**
 * BellAwareTracker
 *
 * Per-tab "this tab speaks bell" mode. When a tab emits its first BEL,
 * we trust the bell as that tab's canonical attention signal and stop
 * surfacing the background-activity dot for ordinary stdout chunks —
 * Claude Code's spinner, watch-mode rebuilds, REPL repaints, etc. would
 * otherwise flash the dot constantly.
 *
 * Each bell resets an idle timer. If no bell arrives within
 * `timeoutMinutes`, the tab demotes back to normal stdout-marks-activity
 * behavior — handles the case where a long-running tool exits and the
 * shell takes over.
 */
export class BellAwareTracker {
  private readonly bellAware = new Set<number>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private timeoutMs: number;

  constructor(timeoutMinutes: number = 60) {
    this.timeoutMs = Math.max(0, timeoutMinutes) * 60_000;
  }

  setTimeoutMinutes(minutes: number): void {
    this.timeoutMs = Math.max(0, minutes) * 60_000;
  }

  /** Mark this tab as a bell-speaker and (re)start its idle timer. */
  recordBell(tabId: number): void {
    if (this.timeoutMs === 0) return;
    this.bellAware.add(tabId);
    const existing = this.timers.get(tabId);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.bellAware.delete(tabId);
      this.timers.delete(tabId);
    }, this.timeoutMs);
    this.timers.set(tabId, handle);
  }

  isBellAware(tabId: number): boolean {
    return this.bellAware.has(tabId);
  }

  /** Tab closed — drop state and cancel any pending demotion. */
  clearTab(tabId: number): void {
    const timer = this.timers.get(tabId);
    if (timer) clearTimeout(timer);
    this.timers.delete(tabId);
    this.bellAware.delete(tabId);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.bellAware.clear();
  }
}
