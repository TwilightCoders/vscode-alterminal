/**
 * Type definitions for Claude Pilot webview components
 */

export interface TabData {
    id: number;
    terminal: any; // Terminal instance from xterm.js
    fitAddon: any; // FitAddon instance
    serializeAddon: any; // SerializeAddon instance
    label: string;
    serializedState: string | null;
    hasContent: boolean;
}

export interface TabState {
    tabs: Array<{
        id: number;
        label: string;
        serializedState: string | null;
        hasContent: boolean;
    }>;
    activeTabId: number;
}

export interface VSCodeMessage {
    command: string;
    [key: string]: any;
}

export interface TabMessage extends VSCodeMessage {
    tabId?: number;
}

export interface ResizeMessage extends TabMessage {
    command: 'resize';
    cols: number;
    rows: number;
}

export interface DataMessage extends TabMessage {
    command: 'data';
    data: string;
}

export interface FileDropMessage extends TabMessage {
    command: 'fileDrop';
    fileName: string;
    fileType: string;
    fileSize: number;
    fileData: string;
}

export interface TabControlMessage extends VSCodeMessage {
    command: 'newTab' | 'switchTab' | 'closeTab';
    tabId: number;
}