/**
 * Webview Logger Utility
 *
 * Webview-specific version of logger that doesn't depend on Node.js process
 * Provides conditional logging that only outputs in debug/development mode.
 */

export class Logger {
  private static debugFilter: string[] | null = null;
  // Memoized debug mode cache (undefined = not yet computed)
  private static _debugMode: boolean | undefined;

  // External configuration hook so other code (e.g., TabManager message handler) can set dev mode once
  static configureDevMode(enabled: boolean) {
    this._debugMode = enabled;
    try { (globalThis as any).__ALTERMINAL_DEV_MODE = enabled; } catch { /* ignore */ }
  }

  private static isDebugMode(): boolean {
    if (this._debugMode == undefined) {
      try {
        // Prefer explicit global flag populated by configureDevMode
        if ((globalThis as any).__ALTERMINAL_DEV_MODE !== undefined) {
          this._debugMode = !!(globalThis as any).__ALTERMINAL_DEV_MODE;
        } else {
          this._debugMode =
            localStorage.getItem("alterminal.debug") === "true" ||
            localStorage.getItem("vscode.debug") === "true" ||
            (globalThis as any).isDevelopment === true;
        }
      } catch { this._debugMode = false; }
    }
    return this._debugMode;
  }

  static isDebugModeEnabled(): boolean {
    return this.isDebugMode();
  }

  private static getDebugFilter(): string[] | null {
    // Check localStorage for debug filter
    try {
      const filter = localStorage.getItem("alterminal.debugFilter");
      if (!filter) return null;

      const parsed = JSON.parse(filter);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return null;
    }
  }

  private static shouldLog(message: any[]): boolean {
    if (!this.isDebugMode()) return false;

    const filter = this.debugFilter ?? this.getDebugFilter();
    if (!filter) return true;

    // Check if message contains any of the filter emojis
    const messageText = message.join(" ");
    return filter.some((emoji) => messageText.includes(emoji));
  }

  static setDebugFilter(filter: string[] | null): void {
    this.debugFilter = filter;
    try {
      if (filter) {
        localStorage.setItem("alterminal.debugFilter", JSON.stringify(filter));
      } else {
        localStorage.removeItem("alterminal.debugFilter");
      }
    } catch {
      // Ignore localStorage errors
    }
  }

  static debug(...args: any[]): void {
    if (this.shouldLog(args)) {
      console.log("[DEBUG]", ...args);
    }
  }

  static info(...args: any[]): void {
    if (this.shouldLog(args)) {
      console.info("[INFO]", ...args);
    }
  }

  static warn(...args: any[]): void {
    if (this.shouldLog(args)) {
      console.warn("[WARN]", ...args);
    }
  }

  static error(...args: any[]): void {
    if (this.shouldLog(args)) {
      console.error("[ERROR]", ...args);
    }
  }

  static log(...args: any[]): void {
    if (this.shouldLog(args)) {
      console.log(...args);
    }
  }

  // Force debug mode for testing
  static forceDebugMode(enabled: boolean): void {
    try {
      localStorage.setItem("alterminal.debug", enabled.toString());
      // Update cached value immediately so subsequent calls reflect change
      this._debugMode = enabled;
    } catch {
      // Ignore localStorage errors
    }
  }

  // Allow external explicit invalidation if environment changes outside forceDebugMode
  static invalidateDebugModeCache(): void {
    this._debugMode = undefined;
  }
}
