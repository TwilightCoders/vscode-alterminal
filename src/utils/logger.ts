/**
 * Debug Logger Utility
 *
 * Provides conditional logging that only outputs in debug/development mode.
 * Prevents console spam in production builds.
 *
 * In all modes, warn/error go to a dedicated "Alterminal" output channel
 * (visible in the Output panel dropdown). In dev mode, debug/info/trace
 * also appear there.
 */

import * as vscode from "vscode";

export class Logger {
  private static debugFilter: string[] | null = null;
  private static devMode: boolean | null = null; // explicit runtime flag
  private static configured = false;
  private static _channel: vscode.LogOutputChannel | undefined;

  /** Configure logger with explicit dev/prod mode (call once at activation). */
  static configure(isDev: boolean) {
    this.devMode = isDev;
    this.configured = true;
    this._channel = vscode.window.createOutputChannel("Alterminal", { log: true });
    if (!isDev) {
      // Hard-disable noisy levels for perf; keep warn/error always.
      // Reassign only if not already no-op to avoid breaking references.
      // Use function expressions to preserve 'this' independence.
      if (this.debug !== this._noop) this.debug = this._noop;
      if (this.info !== this._noop) this.info = this._noop;
      if (this.trace !== this._traceNoopWrapper) this.trace = this._traceNoopWrapper as any;
    }
  }

  private static _noop = (..._args: any[]) => {};
  private static _traceNoopWrapper = (_message: string, ..._args: any[]) => {};

  private static _formatArgs(args: any[]): string {
    return args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  }

  private static isDebugMode(): boolean {
  // Prefer explicit runtime flag if configured
  if (this.devMode !== null) return this.devMode;
  // Fallback to environment variable heuristic
  return process.env.NODE_ENV === "development";
  }

  private static getDebugFilter(): string[] | null {
    // Extension side could use environment variable or config
    // Support legacy env var (CLAUDE_DEBUG_FILTER) plus new ALTERMINAL_DEBUG_FILTER
    const filter =
      process.env.ALTERMINAL_DEBUG_FILTER || process.env.CLAUDE_DEBUG_FILTER;
    if (!filter) return null;

    try {
      const parsed = JSON.parse(filter);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Treat as combined emoji string
      return filter.match(/[\u{1F300}-\u{1F9FF}]/gu) || null;
    }
  }

  private static shouldLog(message: any[]): boolean {
    if (!this.isDebugMode()) return false;

    if (this.debugFilter === null) {
      this.debugFilter = this.getDebugFilter();
    }

    if (!this.debugFilter) return true; // No filter = show all

    const messageStr = message.join(" ");

    // Check if message contains any of the filter emojis
    return this.debugFilter.some((emoji) => messageStr.includes(emoji));
  }

  static debug(...args: any[]): void {
    if (this.shouldLog(args)) {
      this._channel?.debug(this._formatArgs(args));
    }
  }

  static info(...args: any[]): void {
    if (this.isDebugMode()) {
      this._channel?.info(this._formatArgs(args));
    }
  }

  static warn(...args: any[]): void {
    this._channel?.warn(this._formatArgs(args));
  }

  static error(...args: any[]): void {
    this._channel?.error(this._formatArgs(args));
  }

  static trace(message: string, ...args: any[]): void {
    if (this.isDebugMode()) {
      this._channel?.trace(`${message} ${this._formatArgs(args)}`);
    }
  }

  /** Public cheap guard for hot-path caller side wrapping */
  static isDebugEnabled(): boolean { return this.isDebugMode(); }

  /** Dispose the output channel (call on extension deactivate). */
  static dispose(): void {
    this._channel?.dispose();
    this._channel = undefined;
  }
}

// For webview context (JavaScript)
export const createWebviewLogger = () => `
class Logger {
    static isDebugMode() {
        // Check for debug mode in webview context
        return window.location?.search?.includes('debug=true') || 
               localStorage.getItem('alterminal.debug') === 'true';
    }
    
    static getDebugFilter() {
        const filter = localStorage.getItem('alterminal.debugFilter');
        if (!filter) return null;
        
        try {
            // Support both array format ["🐛", "🔧"] and combined format "🐛🔧"
            const parsed = JSON.parse(filter);
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
            // If not JSON, treat as combined emoji string
            return filter.match(/[\\u{1F300}-\\u{1F9FF}]/gu) || null;
        }
    }
    
    static shouldLog(message) {
        if (!this.isDebugMode()) return false;
        
        const filter = this.getDebugFilter();
        if (!filter) return true; // No filter = show all
        
        const messageStr = Array.isArray(message) ? message.join(' ') : String(message);
        
        // Check if message contains any of the filter emojis
        return filter.some(emoji => messageStr.includes(emoji));
    }

    static debug(...args) {
        if (this.shouldLog(args)) {
            console.log('🐛 DEBUG:', ...args);
        }
    }

    static info(...args) {
        if (this.isDebugMode()) {
            console.info('[INFO]', ...args);
        }
    }

    static warn(...args) {
        console.warn('[WARN]', ...args);
    }

    static error(...args) {
        console.error('[ERROR]', ...args);
    }

    static trace(message, ...args) {
        if (this.isDebugMode()) {
            console.log(\`[TRACE] \${message}\`, ...args);
        }
    }
}
`;
