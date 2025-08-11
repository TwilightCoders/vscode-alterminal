// Isomorphic Debouncer usable in both extension (Node) and webview (browser)
// Avoid explicit NodeJS.Timeout typing so bundlers don't inject node typings into the webview bundle.
export type DebounceOptions = { leading?: boolean; trailing?: boolean; maxWait?: number };
type Timer = ReturnType<typeof setTimeout> | null;
interface Entry { timer: Timer; lastInvoke: number; lastCall: number; maxTimer: Timer; fn: (...args:any[])=>any; opts: DebounceOptions; lastArgs: any[]; leadingInvoked: boolean; }

export class Debouncer {
  private static _entries = new Map<string, Entry>();

  static debounce<T extends (...args: any[]) => any>(key: string, wait: number, fn: T, opts: DebounceOptions = {}, ...args: Parameters<T>) {
    let entry = this._entries.get(key);
    const now = Date.now();
    if (!entry) {
      entry = { timer: null, maxTimer: null, lastInvoke: 0, lastCall: 0, fn, opts: { trailing: true, ...opts }, lastArgs: [], leadingInvoked: false };
      this._entries.set(key, entry);
    } else {
      entry.fn = fn;
      entry.opts = { trailing: true, ...entry.opts, ...opts };
    }
    entry.lastArgs = args;
    entry.lastCall = now;

    const invoke = () => {
      entry!.timer = null;
      entry!.maxTimer && clearTimeout(entry!.maxTimer);
      entry!.maxTimer = null;
      entry!.lastInvoke = Date.now();
      entry!.leadingInvoked = false;
      return entry!.fn(...entry!.lastArgs);
    };

    if (entry.opts.leading && !entry.leadingInvoked) {
      entry.leadingInvoked = true;
      entry.lastInvoke = now;
      fn(...args);
    }

    if (entry.timer) clearTimeout(entry.timer as any);
    entry.timer = setTimeout(() => {
      if (entry!.opts.trailing !== false) invoke();
    }, wait);

    if (entry.opts.maxWait && !entry.maxTimer) {
      entry.maxTimer = setTimeout(() => {
        if (entry!.timer) { clearTimeout(entry!.timer as any); entry!.timer = null; }
        invoke();
      }, entry.opts.maxWait);
    }
  }

  static flush(key: string) {
    const entry = this._entries.get(key);
    if (!entry) return;
    if (entry.timer) { clearTimeout(entry.timer as any); entry.timer = null; }
    if (entry.maxTimer) { clearTimeout(entry.maxTimer as any); entry.maxTimer = null; }
    entry.fn(...entry.lastArgs);
    entry.lastInvoke = Date.now();
    entry.leadingInvoked = false;
  }

  static cancel(key: string) {
    const entry = this._entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer as any);
    if (entry.maxTimer) clearTimeout(entry.maxTimer as any);
    this._entries.delete(key);
  }
}
