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
 * - Handle shell readiness detection and command execution
 * - Process file drops and convert them to appropriate terminal input
 * - Manage PTY resizing, data flow, and process cleanup
 * 
 * Key Features:
 * - Automatic shell detection (bash/zsh on Unix, cmd on Windows)
 * - Smart shell readiness detection based on data flow timing
 * - Configurable auto-command execution
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
import { Logger } from '../utils/logger';

export class PtyManager {
    private _ptyProcesses = new Map<number, pty.IPty>();
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
     * Encapsulates PTY operations and parameter extraction
     */
    public async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'createPty':
                this.createPtyProcess(message.tabId, message.terminalType, message.customCommand);
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
            case 'newTab':
                this.createPtyProcess(message.tabId, message.terminalType);
                break;
            case 'closeTab':
                this.disposePtyProcess(message.tabId);
                break;
            default:
                // Return false to indicate this manager can't handle the message
                return;
        }
    }

    /**
     * Check if this manager can handle a specific message command
     */
    public canHandle(command: string): boolean {
        const ptyCommands = ['createPty', 'disposePty', 'data', 'resize', 'sendFilePath', 'sendFileData', 'newTab', 'closeTab'];
        return ptyCommands.includes(command);
    }


    public createPtyProcess(tabId: number, terminalType: string = 'default', customCommand?: string): void {
        // Only create new PTY process if one doesn't exist for this tab
        if (!this._ptyProcesses.has(tabId)) {
            // Store terminal type for this tab
            this._terminalTypes.set(tabId, terminalType);
            
            // Determine what command/shell to spawn based on terminal type
            const userShell = process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || '/bin/bash';
            let command: string;
            let args: string[];
            
            const config = vscode.workspace.getConfiguration('alterminal');
            const startingCommand = config.get<string>('startingCommand', '');
            
            switch (terminalType) {
                case 'command':
                    // Use custom command if provided, otherwise fall back to configured starting command
                    if (customCommand) {
                        const parts = customCommand.split(' ');
                        command = parts[0];
                        args = parts.slice(1);
                        Logger.debug(`Using custom command: ${command} with args:`, args);
                    } else if (startingCommand) {
                        const parts = startingCommand.split(' ');
                        command = parts[0];
                        args = parts.slice(1);
                    } else {
                        command = userShell;
                        args = process.platform === 'win32' ? [] : ['-l', '-i'];
                    }
                    break;
                    
                case 'shell':
                    // Always plain shell (no auto command)
                    command = userShell;
                    if (process.platform === 'win32') {
                        args = [];
                    } else {
                        args = ['-l', '-i'];
                    }
                    Logger.debug(`Using shell (login+interactive): ${command} with args:`, args);
                    break;
                    
                case 'default':
                default:
                    // Use configured starting command or default to shell
                    if (startingCommand) {
                        const parts = startingCommand.split(' ');
                        command = parts[0];
                        args = parts.slice(1);
                        Logger.debug(`Spawning configured command: ${command} with args:`, args);
                    } else {
                        // Plain shell
                        command = userShell;
                        if (process.platform === 'win32') {
                            args = [];
                        } else {
                            args = ['-l', '-i'];
                        }
                        Logger.debug(`No starting command configured, using shell: ${command} with args:`, args);
                    }
                    break;
            }
            
            Logger.debug(`About to spawn PTY with command: "${command}", args:`, args, `for terminal type: ${terminalType}`);
            
        const ptyProcess = pty.spawn(command, args, {
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
            PATH: process.env.PATH || '',
            // Preserve user PS1; do NOT override (overrides can expose raw control chars)
            SHELL: userShell
                } as { [key: string]: string }
            });

            ptyProcess.onData((data) => {
                this._webviewView?.webview.postMessage({
                    command: 'data',
                    data: data,
                    tabId: tabId
                });
            });
            
            ptyProcess.onExit(() => {
                Logger.debug(`PTY process for tab ${tabId} exited`);
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
        // Clean up process monitoring timer
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
        this._currentProcessNames.delete(tabId);
        this._terminalTypes.delete(tabId);
    }

    public async sendFileData(fileData: string, fileName: string, fileType: string, tabId: number): Promise<void> {
        try {
            const os = require('os');
            const path = require('path');
            const fs = require('fs').promises;
            
            const tempDir = os.tmpdir();
            const tempFileName = `alterminal-${Date.now()}-${fileName}`;
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
            Logger.error('Error writing file to temp:', error);
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

    /**
     * Check if we have any running PTY processes (indicates warm boot)
     */
    public hasRunningProcesses(): boolean {
        const hasProcesses = this._ptyProcesses.size > 0;
        console.log('🔧 PtyManager.hasRunningProcesses():', {
            processCount: this._ptyProcesses.size,
            hasProcesses,
            processKeys: Array.from(this._ptyProcesses.keys())
        });
        return hasProcesses;
    }

    /**
     * Get information about running PTY processes
     */
    public getRunningProcessInfo(): Array<{tabId: number, terminalType: string, processName: string}> {
        const info = [];
        for (const [tabId, ptyProcess] of this._ptyProcesses.entries()) {
            info.push({
                tabId,
                terminalType: this._terminalTypes.get(tabId) || 'unknown',
                processName: this._currentProcessNames.get(tabId) || 'shell'
            });
        }
        console.log('🔧 PtyManager.getRunningProcessInfo():', info);
        return info;
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
    
}
