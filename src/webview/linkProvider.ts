// @ts-nocheck
import { ILinkProvider } from './interfaces.js';
import { Logger } from './logger.js';

/**
 * File Path Link Provider
 * 
 * Purpose:
 * - Handle file path link detection and interaction in terminals
 * - Provide clickable links for file paths in terminal output
 * - Support both modern registerLinkProvider and fallback registerLinkMatcher
 * - Integrate with VS Code file opening and workspace file cache
 * 
 * Responsibilities:
 * - Register link providers with xterm.js
 * - Detect file paths using regex patterns
 * - Validate file existence against workspace cache
 * - Handle link clicks and file opening
 * - Clean disposal of link providers and matchers
 * 
 * Key Features:
 * - Multiple regex patterns for comprehensive file path detection
 * - Workspace file cache integration for validation
 * - Fallback support for older xterm.js versions
 * - Performance-optimized link detection
 * - Clean resource management
 */

export class FilePathLinkProvider implements ILinkProvider {
    private terminal: any; // xterm.js terminal instance
    private vscode: any;
    private terminalId: string;
    
    // Link provider state
    private linkProviders: any[] = [];
    private linkMatcherIds: number[] = [];
    
    // Regex patterns for file path detection
    private readonly COMBINED_PATTERN = /(\b[\.~]?\/[^\s"'`]*(?:\s[^\s"'`]*)*|[a-z0-9_][^\s\/]*\.[a-z0-9]+|[a-zA-Z]:\\[^\s"'`]+)/gi;
    private readonly UNIVERSAL_PATTERN = /[^\s"'`]+/g;
    
    constructor(terminal: any, vscode: any, terminalId: string) {
        this.terminal = terminal;
        this.vscode = vscode;
        this.terminalId = terminalId;
    }
    
    // ILinkProvider interface
    initialize(): void {
        this.setupFilePathLinks();
    }
    
    dispose(): void {
        this.disposeFilePathLinks();
    }
    
    refreshLinks(): void {
        this.disposeFilePathLinks();
        this.setupFilePathLinks();
    }
    
    // Core link setup methods
    setupFilePathLinks(): void {
        Logger.debug('🔗 Setting up file path links (combined) for terminal', this.terminalId);
        
        if (!this.terminal) {
            Logger.warn('Cannot setup links: no terminal instance');
            return;
        }
        
        // Dispose existing links first
        this.disposeFilePathLinks();
        
        // Try modern registerLinkProvider first
        if (typeof this.terminal.registerLinkProvider === 'function') {
            this._setupWithLinkProvider();
        } else {
            // Fallback to registerLinkMatcher
            this._setupWithLinkMatcher();
        }
        
        Logger.debug('🔗 File path links setup complete');
    }
    
    disposeFilePathLinks(): void {
        // Dispose link providers (modern approach)
        if (this.linkProviders.length > 0) {
            this.linkProviders.forEach(({ provider, disposable }) => {
                try {
                    if (disposable && disposable.dispose) {
                        disposable.dispose();
                        Logger.debug('🔗 Disposed link provider');
                    }
                } catch (error) {
                    Logger.error('Error disposing link provider:', error);
                }
            });
            this.linkProviders = [];
        }
        
        // Dispose link matchers (fallback approach)
        if (this.linkMatcherIds.length > 0 && this.terminal && this.terminal.deregisterLinkMatcher) {
            this.linkMatcherIds.forEach(matcherId => {
                try {
                    this.terminal.deregisterLinkMatcher(matcherId);
                    Logger.debug('🔗 Deregistered link matcher:', matcherId);
                } catch (error) {
                    Logger.error('Error deregistering link matcher:', error);
                }
            });
            this.linkMatcherIds = [];
        }
    }
    
    // Private implementation methods
    private _setupWithLinkProvider(): void {
        const provider = {
            provideLinks: (bufferLineNumber: number, callback: Function) => {
                try {
                    const line = this.terminal.buffer.active.getLine(bufferLineNumber);
                    if (!line) {
                        callback(undefined);
                        return;
                    }
                    
                    const lineText = line.translateToString(true);
                    const links = this._detectLinksInLine(lineText, bufferLineNumber);
                    
                    callback(links.length ? links : undefined);
                } catch (error) {
                    Logger.error('Error in link provider:', error);
                    callback(undefined);
                }
            }
        };
        
        try {
            const disposable = this.terminal.registerLinkProvider(provider);
            this.linkProviders = [{ provider, disposable }];
            Logger.debug('🔗 Modern link provider registered');
        } catch (error) {
            Logger.error('Failed to register link provider, falling back to matcher:', error);
            this._setupWithLinkMatcher();
        }
    }
    
    private _setupWithLinkMatcher(): void {
        Logger.debug('🔗 Setting up file path links with registerLinkMatcher fallback');
        
        if (!this.terminal || typeof this.terminal.registerLinkMatcher !== 'function') {
            Logger.error('Terminal registerLinkMatcher not available');
            return;
        }
        
        // Register link matcher with combined pattern
        try {
            const matcherId = this.terminal.registerLinkMatcher(
                this.COMBINED_PATTERN,
                (event: MouseEvent, uri: string) => this._handleLinkClick(event, uri),
                {
                    validationCallback: (uri: string, callback: Function) => {
                        this._validateLink(uri, callback);
                    },
                    tooltipCallback: (event: MouseEvent, uri: string, location: any) => {
                        return `Click to open: ${uri}`;
                    },
                    priority: 1
                }
            );
            
            this.linkMatcherIds.push(matcherId);
            Logger.debug('🔗 Link matcher registered with ID:', matcherId);
            
        } catch (error) {
            Logger.error('Failed to register link matcher:', error);
        }
    }
    
    private _detectLinksInLine(lineText: string, lineNumber: number): any[] {
        const links: any[] = [];
        let match;
        
        // Reset regex for fresh matching
        this.COMBINED_PATTERN.lastIndex = 0;
        
        while ((match = this.COMBINED_PATTERN.exec(lineText)) !== null) {
            const matchText = match[0].trim();
            if (matchText.length < 2) continue;
            
            // Create link object
            const link = {
                range: {
                    start: { x: match.index + 1, y: lineNumber },
                    end: { x: match.index + match[0].length, y: lineNumber }
                },
                text: matchText,
                activate: (event: MouseEvent, text: string) => {
                    this._handleLinkClick(event, text);
                },
                hover: (event: MouseEvent, text: string) => {
                    // Optional hover handling
                },
                leave: (event: MouseEvent, text: string) => {
                    // Optional leave handling
                }
            };
            
            links.push(link);
        }
        
        return links;
    }
    
    private _handleLinkClick(event: MouseEvent, uri: string): void {
        event.preventDefault();
        
        Logger.debug('🔗 Link clicked:', uri);
        
        // Send to extension host for file opening
        this.vscode.postMessage({
            command: 'openFile',
            filePath: uri,
            terminalId: this.terminalId
        });
    }
    
    private _validateLink(uri: string, callback: Function): void {
        // Use workspace file cache for fast validation
        if (window.workspaceFileCache && window.workspaceFileCache.has(uri)) {
            callback(true);
            return;
        }
        
        // Basic validation for likely file paths
        const isLikelyFile = uri.includes('.') || uri.startsWith('/') || uri.startsWith('~');
        callback(isLikelyFile);
    }
    
    // Public methods for external control
    updateLinkProviders(): void {
        if (window.linkModeState) {
            // Refresh based on CMD/Ctrl state
            this.refreshLinks();
        }
    }
    
    setLinkMode(enabled: boolean): void {
        if (enabled) {
            this.setupFilePathLinks();
        } else {
            this.disposeFilePathLinks();
        }
    }
}