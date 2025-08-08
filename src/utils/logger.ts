/**
 * Debug Logger Utility
 * 
 * Provides conditional logging that only outputs in debug/development mode.
 * Prevents console spam in production builds.
 */

export class Logger {
    private static debugFilter: string[] | null = null;
    
    private static isDebugMode(): boolean {
        // Check if we're in VS Code extension development mode
        return process.env.NODE_ENV === 'development';
    }
    
    private static getDebugFilter(): string[] | null {
        // Extension side could use environment variable or config
        const filter = process.env.CLAUDE_DEBUG_FILTER;
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
        
        const messageStr = message.join(' ');
        
        // Check if message contains any of the filter emojis
        return this.debugFilter.some(emoji => messageStr.includes(emoji));
    }

    static debug(...args: any[]): void {
        if (this.shouldLog(args)) {
            console.log('🐛 DEBUG:', ...args);
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
    
    static getDebugFilter() {
        const filter = localStorage.getItem('claudePilot.debugFilter');
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