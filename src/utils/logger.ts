/**
 * Debug Logger Utility
 * 
 * Provides conditional logging that only outputs in debug/development mode.
 * Prevents console spam in production builds.
 */

export class Logger {
    private static isDebugMode(): boolean {
        // Check if we're in VS Code extension development mode
        return process.env.NODE_ENV === 'development';
    }

    static debug(...args: any[]): void {
        if (this.isDebugMode()) {
            console.log('[DEBUG]', ...args);
        }
    }

    static info(...args: any[]): void {
        if (this.isDebugMode()) {
            console.info('[INFO]', ...args);
        }
    }

    static warn(...args: any[]): void {
        // Always show warnings
        console.warn('[WARN]', ...args);
    }

    static error(...args: any[]): void {
        // Always show errors
        console.error('[ERROR]', ...args);
    }

    static trace(message: string, ...args: any[]): void {
        if (this.isDebugMode()) {
            console.log(`[TRACE] ${message}`, ...args);
        }
    }
}

// For webview context (JavaScript)
export const createWebviewLogger = () => `
class Logger {
    static isDebugMode() {
        // Check for debug mode in webview context
        return window.location?.search?.includes('debug=true') || 
               localStorage.getItem('claudePilot.debug') === 'true';
    }

    static debug(...args) {
        if (this.isDebugMode()) {
            console.log('[DEBUG]', ...args);
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