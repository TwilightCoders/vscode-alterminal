// @ts-nocheck
/**
 * Webview Logger Utility
 *
 * Webview-specific version of logger that doesn't depend on Node.js process
 * Provides conditional logging that only outputs in debug/development mode.
 */

export class Logger {
  private static debugFilter: string[] | null = null;

  private static isDebugMode(): boolean {
    // Check localStorage for debug mode in webview context
    try {
      return (
        localStorage.getItem("alterminal.debug") === "true" ||
        localStorage.getItem("vscode.debug") === "true" ||
        (globalThis as any).isDevelopment === true
      );
    } catch {
      return false;
    }
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
    } catch {
      // Ignore localStorage errors
    }
  }
}
