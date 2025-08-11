// @ts-nocheck
/**
 * TypeScript Interfaces for Terminal Architecture
 * 
 * Purpose:
 * - Define clean contracts for terminal components
 * - Enable composition over inheritance
 * - Provide type safety and intellisense
 * - Support dependency injection and testing
 */

// Core event system interface
export interface IEventEmitter {
    on(event: string, handler: Function): () => void;
    off(event: string, handler: Function): void;
    emit(event: string, payload?: any): void;
}

// Base provider interface
export interface IProvider {
    initialize(): void | Promise<void>;
    dispose(): void;
}

// Lifecycle management interface
export interface ILifecycleManager extends IProvider, IEventEmitter {
    readonly isInitialized: boolean;
    readonly isReady: boolean;
    readonly isDisposed: boolean;
    
    markReady(): void;
    waitForReady(): Promise<void>;
    
    // Lifecycle events: 'initialized', 'ready', 'disposed'
}

// Link detection and handling interface
export interface ILinkProvider extends IProvider {
    setupFilePathLinks(): void;
    disposeFilePathLinks(): void;
    refreshLinks(): void;
}

// Terminal mode tracking interface  
export interface IModeProvider extends IProvider {
    setMode(bit: number, enabled: boolean): void;
    hasMode(bit: number): boolean;
    parseAndTrackModes(data: string): void;
    stripModeSequences(data: string): string;
    
    // Mode constants
    readonly MODES: {
        readonly INSERT: number;
        readonly APPLICATION_CURSOR: number;
        readonly APPLICATION_KEYPAD: number;
        readonly AUTOWRAP: number;
        readonly ORIGIN: number;
        readonly REVERSE_VIDEO: number;
    };
}

// Terminal title and icon management
export interface ITitleManager extends IProvider {
    title: string;
    icon: string;
    
    rename(newTitle: string): void;
    setIcon(iconClass: string): void;
    startTitleEdit(): void;
    createTitleElement(label?: string): DocumentFragment;
    
    // Title change events
    onTitleChanged?: (title: string) => void;
}

// Notification system interface
export interface INotificationProvider extends IProvider {
    hasNotification: boolean;
    showNotification(): void;
    hideNotification(): void;
    
    // Notification events
    onNotificationChanged?: (hasNotification: boolean) => void;
}

// Terminal configuration options
export interface ITerminalOptions {
    readonly id: string;
    title?: string;
    icon?: string;
    terminalType: 'shell' | 'command' | 'default';
    command?: string;          // launch command (unified)
    autoStartPty?: boolean;
}


// Terminal state for serialization
export interface ITerminalState {
    id: string;
    title: string;
    icon: string;
    isActive: boolean;
    hasNotification: boolean;
    terminalType: string;
    buffer?: string;        // canonical serialized content
    modes?: number;         // bitmask of tracked modes
    command?: string;       // launch command if command tab
    terminalState?: any;    // reserved for future xterm.js structural state
    // Deprecated migration fields (will be removed in a future version)
    rawContent?: string;    // legacy content key
    serializedContent?: string; // very old content key
    terminalModes?: number; // legacy modes key
}


// Event payload types for type safety
export interface ITerminalStateChangedEvent {
    type: 'titleChanged' | 'iconChanged' | 'notificationChanged' | 'activeChanged';
    terminalId: string;
    oldValue?: any;
    newValue?: any;
}

export interface ILifecycleEvent {
    type: 'initialized' | 'ready' | 'disposed';
    terminalId: string;
    timestamp: number;
}

// Utility type for constructor dependency injection
export type ProviderMap = {
    lifecycle?: ILifecycleManager;
    link?: ILinkProvider;
    mode?: IModeProvider;
    title?: ITitleManager;
    notification?: INotificationProvider;
};
