import { ILifecycleManager, IEventEmitter } from "./interfaces.js";
import { Logger } from "./logger.js";

/**
 * Terminal Lifecycle Manager
 *
 * Purpose:
 * - Manage terminal initialization, readiness, and disposal lifecycle
 * - Provide event-driven lifecycle state changes
 * - Handle boot detection and stable state management
 * - Coordinate provider initialization timing
 *
 * Responsibilities:
 * - Track initialization and ready states
 * - Detect terminal boot completion (stable prompt)
 * - Manage lifecycle promises (whenOpened, whenBootReady)
 * - Emit lifecycle events for other providers
 * - Handle cleanup and disposal
 *
 * Key Features:
 * - Promise-based async lifecycle management
 * - Boot detection with timeout fallback
 * - Event-driven provider coordination
 * - Clean disposal with resource cleanup
 */

export class TerminalLifecycleManager implements ILifecycleManager {
  private _isInitialized = false;
  private _isReady = false;
  private _isDisposed = false;

  // Boot state tracking
  private _booting = true; // legacy flag retained (always cleared with markBootReady)
  private _bootReady = false; // immediate readiness model

  // Lifecycle promises
  private _openedResolve?: () => void;
  private _bootReadyResolve?: () => void;
  public readonly whenOpened: Promise<void>;
  public readonly whenBootReady: Promise<void>;

  // Event system
  private _listeners = new Map<string, Set<Function>>();

  // Legacy prompt detection regex (unused after simplification) kept for potential future heuristics
  // private _promptRegex = /[$#%>]\s*$/;

  constructor(
    private terminal: any,
    private vscode: any,
    private terminalId: string,
  ) {
    // Initialize lifecycle promises
    this.whenOpened = new Promise((resolve) => {
      this._openedResolve = resolve;
    });

    this.whenBootReady = new Promise((resolve) => {
      this._bootReadyResolve = resolve;
    });
  }

  // ILifecycleManager interface
  get isInitialized(): boolean {
    return this._isInitialized;
  }

  get isReady(): boolean {
    return this._isReady && this._bootReady;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  async initialize(): Promise<void> {
    if (this._isInitialized) return;

    try {
      this._isInitialized = true;
      this.emit("initialized", {
        type: "initialized",
        terminalId: this.terminalId,
        timestamp: Date.now(),
      });

      // Immediate boot-ready model to allow early serialization
      this.markBootReady();

      Logger.debug(
        `🔄 LifecycleManager initialized for terminal ${this.terminalId}`,
      );
    } catch (error) {
      Logger.error(
        `Failed to initialize lifecycle manager for terminal ${this.terminalId}:`,
        error,
      );
      throw error;
    }
  }

  markReady(): void {
    if (!this._isReady) {
      this._isReady = true;
      this.emit("ready", {
        type: "ready",
        terminalId: this.terminalId,
        timestamp: Date.now(),
      });

      Logger.debug(
        `✅ LifecycleManager marked ready for terminal ${this.terminalId}`,
      );
    }
  }

  async waitForReady(): Promise<void> {
    if (this.isReady) return;

    return new Promise((resolve) => {
      const unsubscribe = this.on("ready", () => {
        unsubscribe();
        resolve();
      });
    });
  }

  // Boot state management (extracted from TerminalInstance)
  markOpened(): void {
    if (this._openedResolve) {
      this._openedResolve();
      this._openedResolve = undefined;
    }
    this.emit("opened");
  }

  markBootReady(): void {
    if (!this._bootReady) {
      this._bootReady = true;
      this._booting = false;

      if (this._bootReadyResolve) {
        this._bootReadyResolve();
        this._bootReadyResolve = undefined;
      }

      this.emit("bootReady");

      // Also trigger general ready state
      this.markReady();

      Logger.debug(`🚀 Boot ready for terminal ${this.terminalId}`);
    }
  }

  // Legacy boot detection & snapshot hooks removed (immediate readiness adopted)

  // IEventEmitter interface
  on(event: string, handler: Function): () => void {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event)!.add(handler);

    return () => this.off(event, handler);
  }

  off(event: string, handler: Function): void {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(handler);
    }
  }

  emit(event: string, payload?: any): void {
    const set = this._listeners.get(event);
    if (set) {
      for (const fn of Array.from(set)) {
        try {
          fn(payload);
        } catch (error) {
          Logger.warn(`Error in lifecycle event handler for ${event}:`, error);
        }
      }
    }
  }

  dispose(): void {
    if (this._isDisposed) return;

    try {
      // Clear any pending timers
      // No timers to clear in simplified model

      // Mark as disposed
      this._isDisposed = true;

      this.emit("disposed", {
        type: "disposed",
        terminalId: this.terminalId,
        timestamp: Date.now(),
      });

      // Clear all event listeners after emitting
      this._listeners.clear();

      Logger.debug(
        `🗑️ LifecycleManager disposed for terminal ${this.terminalId}`,
      );
    } catch (error) {
      Logger.error(
        `Error disposing lifecycle manager for terminal ${this.terminalId}:`,
        error,
      );
    }
  }
}
