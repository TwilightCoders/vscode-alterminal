/**
 * PTY Process Manager
 * 
 * Purpose:
 * - Factory and manager for individual PTY processes
 * - Handles shell initialization, command execution, and process lifecycle
 * - Provides clean API for PTY operations without tab management concerns
 * 
 * Responsibilities:
 * - Spawn and manage individual PTY processes with proper environment
 * - Handle shell readiness detection and automatic Claude command execution
 * - Process file drops and convert them to appropriate terminal input
 * - Manage PTY resizing, data flow, and process cleanup
 * 
 * Key Features:
 * - Automatic shell detection (bash/zsh on Unix, cmd on Windows)
 * - Smart shell readiness detection based on data flow timing
 * - Configurable auto-command execution (claude, claude --continue, etc.)
 * - File path handling with proper shell escaping
 * - Clean process-focused API without tab awareness
 * 
 * Shell Lifecycle:
 * 1. Spawn shell with login flags and proper environment
 * 2. Monitor data flow to detect when shell is ready
 * 3. Execute configured auto-command after shell settles
 * 4. Handle ongoing I/O and resizing
 * 5. Clean up on disposal
 * 
 * Notes:
 * - Uses @lydell/node-pty for cross-platform PTY support
 * - Shell readiness detection prevents commands from being lost
 * - File path escaping is crucial for shell safety
 * - Tab management is handled by TabManager, not PtyManager
 */

import * as vscode from 'vscode';
import * as pty from '@lydell/node-pty';
import { exec } from 'child_process';
import { readFile } from 'fs/promises';

export class PtyManager {
    private _ptyProcesses = new Map<number, pty.IPty>();
    private _shellReadyStates = new Map<number, boolean>();
    private _lastDataTimes = new Map<number, number>();
    private _readyTimers = new Map<number, NodeJS.Timeout>();
    private _processMonitorTimers = new Map<number, NodeJS.Timeout>();
    private _currentProcessNames = new Map<number, string>();
    private _terminalTypes = new Map<number, string>();
    private _webviewView?: vscode.WebviewView;

    private _scrollback: number = 1000;

    constructor() {
        // No callbacks needed - will use webview directly
    }

    public setScrollback(scrollback: number) {
        this._scrollback = scrollback;
    }

    public setWebviewView(webviewView: vscode.WebviewView) {
        this._webviewView = webviewView;
    }

    /**
     * Handle messages intended for the PTY manager
     */
    public async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'createPty':
                this.createPtyProcess(message.tabId, message.terminalType);
                break;
            case 'disposePty':
                this.disposePtyProcess(message.tabId);
                break;
            case 'data':
                // Sanitize terminal input - prevent potential code injection
                const sanitizedData = typeof message.data === 'string' ? message.data : '';
                this.writeToPty(sanitizedData, message.tabId);
                break;
            case 'resize':
                this.resizePty(message.cols, message.rows, message.tabId);
                break;
            case 'sendFilePath':
                // Validate file path input
                const sanitizedPath = typeof message.filePath === 'string' ? message.filePath : '';
                const validTabId = typeof message.tabId === 'number' ? message.tabId : 0;
                if (sanitizedPath && validTabId > 0) {
                    this.sendFilePath(sanitizedPath, validTabId);
                }
                break;
            case 'sendFileData':
                await this.sendFileData(message.fileData, message.fileName, message.fileType, message.tabId);
                break;
        }
    }

    public createPtyProcess(tabId: number, terminalType: string = 'claude'): void {
        // Use user's default shell with login and interactive flags
        const shell = process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || '/bin/bash';
        const shellArgs = process.platform === 'win32' ? [] : ['-l', '-i'];
        
        // Only create new PTY process if one doesn't exist for this tab
        if (!this._ptyProcesses.has(tabId)) {
            // Store terminal type for this tab
            this._terminalTypes.set(tabId, terminalType);
            
            // Reset shell ready state for new terminal
            this._shellReadyStates.set(tabId, false);
            this._lastDataTimes.set(tabId, 0);
            if (this._readyTimers.has(tabId)) {
                clearTimeout(this._readyTimers.get(tabId)!);
                this._readyTimers.delete(tabId);
            }
            
            const ptyProcess = pty.spawn(shell, shellArgs, {
                name: 'xterm-256color',
                cols: 80,
                rows: 30,
                cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || process.env.USERPROFILE || process.cwd(),
                env: {
                    ...process.env,
                    TERM: 'xterm-256color',
                    COLORTERM: 'truecolor',
                    TERM_PROGRAM: 'vscode',
                    TERM_PROGRAM_VERSION: vscode.version,
                    VSCODE_PID: process.pid.toString(),
                    // Ensure PATH includes common zsh completion locations
                    PATH: process.env.PATH || '',
                    // Force interactive shell features
                    PS1: process.env.PS1 || '$ ',
                    // Ensure shell knows it's interactive
                    SHELL: shell
                } as { [key: string]: string }
            });

            ptyProcess.onData((data) => {
                this._webviewView?.webview.postMessage({
                    command: 'data',
                    data: data,
                    tabId: tabId
                });
                
                // Track when data was last received for this tab
                this._lastDataTimes.set(tabId, Date.now());
                
                // If shell isn't ready yet, start/restart the ready timer
                if (!this._shellReadyStates.get(tabId)) {
                    this._scheduleReadyCheck(tabId);
                }
            });
            
            ptyProcess.onExit(() => {
                console.log(`PTY process for tab ${tabId} exited`);
                this._cleanupProcess(tabId);
            });

            this._ptyProcesses.set(tabId, ptyProcess);
            
            // Start monitoring the process name for this tab
            this._startProcessMonitoring(tabId);
        }
    }

    public writeToPty(data: string, tabId: number): void {
        this._ptyProcesses.get(tabId)?.write(data);
    }

    public resizePty(cols: number, rows: number, tabId: number): void {
        this._ptyProcesses.get(tabId)?.resize(cols, rows);
    }

    public sendFilePath(filePath: string, tabId: number): void {
        // Escape single quotes for shell safety
        const escapedPath = filePath.replace(/'/g, "\\'");
        this._ptyProcesses.get(tabId)?.write(`'${escapedPath}' `);
    }

    public disposePtyProcess(tabId: number): void {
        this._cleanupProcess(tabId);
    }

    private _cleanupProcess(tabId: number): void {
        // Clean up timers
        if (this._readyTimers.has(tabId)) {
            clearTimeout(this._readyTimers.get(tabId)!);
            this._readyTimers.delete(tabId);
        }
        
        if (this._processMonitorTimers.has(tabId)) {
            clearInterval(this._processMonitorTimers.get(tabId)!);
            this._processMonitorTimers.delete(tabId);
        }
        
        // Kill PTY process
        const ptyProcess = this._ptyProcesses.get(tabId);
        if (ptyProcess) {
            ptyProcess.kill();
            this._ptyProcesses.delete(tabId);
        }
        
        // Clean up state
        this._shellReadyStates.delete(tabId);
        this._lastDataTimes.delete(tabId);
        this._currentProcessNames.delete(tabId);
        this._terminalTypes.delete(tabId);
    }

    public async sendFileData(fileData: string, fileName: string, fileType: string, tabId: number): Promise<void> {
        try {
            const os = require('os');
            const path = require('path');
            const fs = require('fs').promises;
            
            const tempDir = os.tmpdir();
            const tempFileName = `claude-pilot-${Date.now()}-${fileName}`;
            const tempFilePath = path.join(tempDir, tempFileName);
            
            // Handle different data formats
            let buffer: Buffer;
            if (fileData.startsWith('data:')) {
                // Data URL format (images, binary files)
                const base64Data = fileData.split(',')[1];
                buffer = Buffer.from(base64Data, 'base64');
            } else {
                // Plain text content
                buffer = Buffer.from(fileData, 'utf8');
            }
            
            await fs.writeFile(tempFilePath, buffer);
            await fs.chmod(tempFilePath, 0o644);
            
            // Send the temp file path
            this._ptyProcesses.get(tabId)?.write(`'${tempFilePath}' `);
            
        } catch (error) {
            console.error('Error writing file to temp:', error);
            this._ptyProcesses.get(tabId)?.write(`"${fileName}" `);
        }
    }

    public dispose(): void {
        // Clean up all PTY processes and timers
        const tabIds = Array.from(this._ptyProcesses.keys());
        for (const tabId of tabIds) {
            this._cleanupProcess(tabId);
        }
    }

    private _scheduleReadyCheck(tabId: number): void {
        // Clear any existing timer for this tab
        if (this._readyTimers.has(tabId)) {
            clearTimeout(this._readyTimers.get(tabId)!);
        }
        
        // Set a timer to check if shell is ready after data stops flowing
        const timer = setTimeout(() => {
            // Check if enough time has passed since last data for this tab
            const lastDataTime = this._lastDataTimes.get(tabId) || 0;
            const timeSinceLastData = Date.now() - lastDataTime;
            const isShellReady = this._shellReadyStates.get(tabId) || false;
            
            if (timeSinceLastData >= 1000 && !isShellReady) {
                this._shellReadyStates.set(tabId, true);
                
                // Determine command based on terminal type
                const terminalType = this._terminalTypes.get(tabId) || 'claude';
                let commandToExecute: string | null = null;
                
                switch (terminalType) {
                    case 'claude':
                        const config = vscode.workspace.getConfiguration('claudePilot');
                        commandToExecute = config.get<string>('startingCommand', 'claude');
                        break;
                    case 'continue':
                        commandToExecute = 'claude --continue';
                        break;
                    case 'shell':
                        commandToExecute = null; // No command for shell terminal
                        break;
                    default:
                        commandToExecute = 'claude';
                        break;
                }
                
                // Execute the command (if not null)
                if (commandToExecute && commandToExecute !== 'none') {
                    this._ptyProcesses.get(tabId)?.write(`${commandToExecute}\r`);
                }
            }
        }, 1500); // Wait 1.5 seconds for shell to settle
        
        this._readyTimers.set(tabId, timer);
    }
    
    /**
     * Start monitoring the current process name for a tab
     */
    private _startProcessMonitoring(tabId: number): void {
        const ptyProcess = this._ptyProcesses.get(tabId);
        if (!ptyProcess) return;
        
        // Get initial process name
        const initialProcess = ptyProcess.process || 'shell';
        this._currentProcessNames.set(tabId, initialProcess);
        
        // Poll for process changes every 1 second
        const timer = setInterval(() => {
            const currentProcess = ptyProcess.process || 'shell';
            const previousProcess = this._currentProcessNames.get(tabId);
            
            if (currentProcess !== previousProcess) {
                this._currentProcessNames.set(tabId, currentProcess);
                this._webviewView?.webview.postMessage({
                    command: 'processChange',
                    processName: currentProcess,
                    tabId: tabId
                });
            }
        }, 1000);
        
        this._processMonitorTimers.set(tabId, timer);
    }
    
    /**
     * Get the current process name for a tab
     */
    public getCurrentProcess(tabId: number): string | undefined {
        const ptyProcess = this._ptyProcesses.get(tabId);
        return ptyProcess?.process || this._currentProcessNames.get(tabId);
    }
}