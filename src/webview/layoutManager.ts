/**
 * Layout Manager
 *
 * Purpose:
 * - Handles responsive layout detection and switching
 * - Manages window event handlers for resize, focus, visibility
 * - Controls tab bar orientation (horizontal vs vertical)
 *
 * Responsibilities:
 * - Set up and dispose ResizeObserver for container
 * - Handle window resize, focus, blur, and beforeunload events
 * - Switch between horizontal and vertical tab layouts
 * - Coordinate terminal refitting on layout changes
 *
 * Key Features:
 * - Auto-layout mode based on aspect ratio
 * - Clean event handler registration and disposal
 * - Loading screen show/hide control
 */

import { Logger } from "./logger.js";

/**
 * Callbacks interface for LayoutManager
 */
export interface LayoutManagerCallbacks {
  getActiveTerminal: () => any;
  saveToLocalState: () => void;
  scheduleSaveState: (reason: string) => void;
}

export class LayoutManager {
  private _callbacks: LayoutManagerCallbacks;
  private _resizeObserver: ResizeObserver | null = null;
  private _windowResizeHandler: (() => void) | null = null;
  private _windowFocusHandler: (() => void) | null = null;
  private _windowBlurHandler: (() => void) | null = null;
  private _documentVisibilityHandler: (() => void) | null = null;
  private _windowBeforeUnloadHandler: (() => void) | null = null;
  private _layoutPreference: string = "auto";

  constructor(callbacks: LayoutManagerCallbacks) {
    this._callbacks = callbacks;
  }

  /**
   * Initialize responsive layout detection
   */
  setupResponsiveLayout(): void {
    const container = document.getElementById("container");
    if (!container) return;

    // ResizeObserver for responsive tab layout
    this._resizeObserver = new ResizeObserver((entries) => {
      this.updateTabLayout(entries[0].contentRect);
    });

    this._resizeObserver.observe(container);

    // Apply initial layout
    requestAnimationFrame(() => {
      const rect = container.getBoundingClientRect();
      this.updateTabLayout(rect);
    });
  }

  /**
   * Set up window event handlers
   */
  setupWindowEventHandlers(): void {
    // Window resize handler
    this._windowResizeHandler = () => {
      const activeTerminal = this._callbacks.getActiveTerminal();
      if (activeTerminal) {
        activeTerminal.fit();
      }
    };
    window.addEventListener("resize", this._windowResizeHandler);

    // Window focus handler - refit terminal when window regains focus
    this._windowFocusHandler = () => {
      Logger.info("🔍 [FOCUS DEBUG] Window gained focus");
      const activeTerminal = this._callbacks.getActiveTerminal();
      if (activeTerminal) {
        activeTerminal.fit();
        activeTerminal.focus();
        Logger.info("🔍 [FOCUS DEBUG] Refocused active terminal");
      }
    };
    window.addEventListener("focus", this._windowFocusHandler);

    // Window blur handler - track when window loses focus
    this._windowBlurHandler = () => {
      Logger.info("🔍 [FOCUS DEBUG] Window lost focus (blur event)");

      // Log which element has focus now
      const activeElement = document.activeElement;
      if (activeElement) {
        Logger.info(`🔍 [FOCUS DEBUG] Active element after blur: ${activeElement.tagName} ${activeElement.className || ''} ${activeElement.id || ''}`);
      } else {
        Logger.info("🔍 [FOCUS DEBUG] No active element after blur");
      }
    };
    window.addEventListener("blur", this._windowBlurHandler);

    // Document visibility handler - track when tab becomes hidden/visible
    this._documentVisibilityHandler = () => {
      if (document.hidden) {
        Logger.info("🔍 [FOCUS DEBUG] Document became hidden (switched away from tab)");
      } else {
        Logger.info("🔍 [FOCUS DEBUG] Document became visible (switched back to tab)");

        // When becoming visible again (e.g., switching back from another workspace),
        // we need to refresh the terminal display to prevent blank screen
        requestAnimationFrame(() => {
          const activeTerminal = this._callbacks.getActiveTerminal();
          if (activeTerminal && activeTerminal.terminal) {
            Logger.debug("🔄 Refreshing terminal after visibility change");

            // Refresh the terminal display (redraw all rows)
            activeTerminal.terminal.refresh(0, activeTerminal.terminal.rows - 1);

            // Refit to ensure proper sizing
            activeTerminal.fit();

            // Focus the terminal
            activeTerminal.focus();
          }
        });
      }
    };
    document.addEventListener("visibilitychange", this._documentVisibilityHandler);

    // Before unload - save state
    this._windowBeforeUnloadHandler = () => {
      try {
        this._callbacks.saveToLocalState();
      } catch (e) {
        Logger.warn("Failed to save state on beforeunload:", e);
      }
    };
    window.addEventListener("beforeunload", this._windowBeforeUnloadHandler);
  }

  /**
   * Update tab layout based on configuration and container size
   */
  updateTabLayout(rect: DOMRectReadOnly | DOMRect): void {
    const container = document.getElementById("container");
    if (!container) return;

    const { width, height } = rect;
    const aspectRatio = width / height;

    let useVerticalTabs = false;

    switch (this._layoutPreference) {
      case "vertical":
        useVerticalTabs = true;
        break;
      case "horizontal":
        useVerticalTabs = false;
        break;
      case "auto":
      default:
        // Switch to vertical tabs if width > height * 1.5
        useVerticalTabs = aspectRatio > 1.5;
        break;
    }

    // Apply the layout
    if (useVerticalTabs) {
      container.classList.add("vertical-tabs");
    } else {
      container.classList.remove("vertical-tabs");
    }

    // Refit active terminal after layout change
    requestAnimationFrame(() => {
      const activeTerminal = this._callbacks.getActiveTerminal();
      if (activeTerminal) activeTerminal.fit();
    });
  }

  /**
   * Set layout preference
   */
  setLayoutPreference(preference: string): void {
    this._layoutPreference = preference;
    // Trigger layout update
    const container = document.getElementById("container");
    if (container) {
      const rect = container.getBoundingClientRect();
      this.updateTabLayout(rect);
    }
  }

  /**
   * Get current layout preference
   */
  getLayoutPreference(): string {
    return this._layoutPreference;
  }

  /**
   * Show the main interface and hide loading screen
   */
  showInterface(): void {
    const loadingDiv = document.getElementById("loading-screen");
    const container = document.getElementById("container");

    if (loadingDiv) {
      loadingDiv.style.display = "none";
    }

    if (container) {
      container.style.display = "flex";
    }

    Logger.debug("🎬 Interface shown");
  }

  /**
   * Cleanup event listeners
   */
  dispose(): void {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    if (this._windowResizeHandler) {
      window.removeEventListener("resize", this._windowResizeHandler);
      this._windowResizeHandler = null;
    }

    if (this._windowFocusHandler) {
      window.removeEventListener("focus", this._windowFocusHandler);
      this._windowFocusHandler = null;
    }

    if (this._windowBlurHandler) {
      window.removeEventListener("blur", this._windowBlurHandler);
      this._windowBlurHandler = null;
    }

    if (this._documentVisibilityHandler) {
      document.removeEventListener("visibilitychange", this._documentVisibilityHandler);
      this._documentVisibilityHandler = null;
    }

    if (this._windowBeforeUnloadHandler) {
      window.removeEventListener("beforeunload", this._windowBeforeUnloadHandler);
      this._windowBeforeUnloadHandler = null;
    }
  }
}
