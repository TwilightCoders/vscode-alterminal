// Isomorphic Debouncer usable in both extension (Node) and webview (browser)
// Avoid explicit NodeJS.Timeout typing so bundlers don't inject node typings into the webview bundle.
export type DebounceOptions = {
  leading?: boolean;
  trailing?: boolean;
  maxWait?: number;
};
type Timer = ReturnType<typeof setTimeout> | null;
interface Entry {
  timer: Timer;
  lastInvoke: number;
  lastCall: number;
  maxTimer: Timer;
  fn: (...args: any[]) => any;
  opts: DebounceOptions;
  lastArgs: any[];
  leadingInvoked: boolean;
}

export class Debouncer {
  private static _entries = new Map<string, Entry>();

  private static _invoke(entry: Entry) {
    entry.timer = null;
    if (entry.maxTimer) {
      clearTimeout(entry.maxTimer as any);
      entry.maxTimer = null;
    }
    entry.lastInvoke = Date.now();
    entry.leadingInvoked = false;
    return entry.fn(...entry.lastArgs);
  }

  static debounce<T extends (...args: any[]) => any>(
    key: string,
    wait: number,
    fn: T,
    opts: DebounceOptions = {},
    ...args: Parameters<T>
  ) {
    let entry = this._entries.get(key);
    const now = Date.now();
    if (!entry) {
      entry = {
        timer: null,
        maxTimer: null,
        lastInvoke: 0,
        lastCall: 0,
        fn,
        opts: {
          leading: opts.leading ?? false,
          trailing: opts.trailing ?? true,
          maxWait: opts.maxWait,
        },
        lastArgs: args,
        leadingInvoked: false,
      };
      this._entries.set(key, entry);
    } else {
      entry.fn = fn;
      entry.lastArgs = args;
    }
    entry.lastCall = now;

    if (entry.opts.leading && !entry.leadingInvoked) {
      entry.leadingInvoked = true;
      entry.lastInvoke = now;
      fn(...args);
    }

    if (entry.timer) clearTimeout(entry.timer as any);
    const e = entry;
    entry.timer = setTimeout(() => {
      if (e.opts.trailing !== false) this._invoke(e);
    }, wait);

    if (entry.opts.maxWait && !entry.maxTimer) {
      entry.maxTimer = setTimeout(() => {
        if (e.timer) {
          clearTimeout(e.timer as any);
          e.timer = null;
        }
        this._invoke(e);
      }, entry.opts.maxWait);
    }
  }

  static flush(key: string) {
    const entry = this._entries.get(key);
    if (!entry) return;
    const hadPending = entry.timer !== null || entry.maxTimer !== null;
    if (entry.timer) {
      clearTimeout(entry.timer as any);
      entry.timer = null;
    }
    if (entry.maxTimer) {
      clearTimeout(entry.maxTimer as any);
      entry.maxTimer = null;
    }
    if (hadPending) {
      entry.fn(...entry.lastArgs);
      entry.lastInvoke = Date.now();
    }
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
