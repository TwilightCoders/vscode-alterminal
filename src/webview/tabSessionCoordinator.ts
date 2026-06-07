import { TerminalInstance } from "./terminal.js";
import { Logger } from "./logger.js";
import type { WebviewToExtMessage } from "../shared/messages.js";

export interface TabSessionCoordinatorHost {
  vscode: any;
  terminalTheme: any;
  getThemeColor: (cssVar: string, fallback: string) => string;
  terminals: Map<number, any>;
  titleManagers: Map<number, any>;
  activeTabId: number | null;
  nextTabId: number;
  requestFormattedTitle(tabId: number, opts?: { processName?: string; oscTitle?: string; workingDirectory?: string }): void;
  createTerminalContainer(tabId: number): HTMLElement | null;
  wireBellHandler(terminal: TerminalInstance): void;
  createTabElement(tabId: number, label: string): void;
  switchToTab(tabId: number): void;
  updateTabBarVisibility(): void;
  initialize(): void;
  dispose(): void;
  resetLaunchSlot(): void;
  clearInitTimeout(): void;
  getHistoryBannerShownEver(): boolean;
  setHistoryBannerShownEver(val: boolean): void;
}

/**
 * Owns the restore/save lifecycle so TabManager can stay focused on tab
 * interactions and terminal coordination.
 */
export class TabSessionCoordinator {
  constructor(private readonly host: TabSessionCoordinatorHost) {}

  saveAllStates() {
    Logger.debug(
      "TabManager.saveAllStates() - Current terminals:",
      this.host.terminals.size,
    );
    const terminals: any[] = [];
    const priorContentById = new Map<number, string>();

    try {
      const priorState = vscode.getState && vscode.getState();
      if (
        priorState &&
        priorState.fullTabState &&
        Array.isArray(priorState.fullTabState.terminals)
      ) {
        for (const t of priorState.fullTabState.terminals) {
          priorContentById.set(t.id, t.buffer || "");
        }
      }
    } catch (e) {
      Logger.warn("Could not read prior state for preservation:", e);
    }

    const tabElements = document.querySelectorAll<HTMLElement>(".tab");
    const tabIdsInOrder = Array.from(tabElements)
      .map((tab) => parseInt(tab.dataset.tabId ?? "0", 10))
      .filter((id) => !isNaN(id));

    for (const id of tabIdsInOrder) {
      const terminal = this.host.terminals.get(id);
      if (!terminal) continue;

      const terminalData = terminal.getState();

      if (!terminal.launchCommand && !terminalData.buffer && priorContentById.has(id)) {
        const preserved = priorContentById.get(id);
        if (preserved && preserved.length > 0) {
          Logger.debug(
            `🛟 Preserving prior snapshot for terminal ${id} (len=${preserved.length}) due to empty serialize()`,
          );
          terminalData.buffer = preserved;
        }
      }

      const titleManager = this.host.titleManagers.get(id);
      if (titleManager && titleManager.icon) {
        terminalData.icon = titleManager.icon;
      }

      terminals.push(terminalData);
    }

    return {
      terminals,
      activeTabId: this.host.activeTabId,
      timestamp: Date.now(),
    };
  }

  createDefaultState() {
    return {
      terminals: [
        {
          id: 1,
          label: "Terminal",
          buffer: "",
          terminalType: "default",
        },
      ],
      activeTabId: 1,
      timestamp: Date.now(),
    };
  }

  restoreFromState(savedState: any, isColdBoot = false): void {
    Logger.debug("TabSessionCoordinator.restoreFromState() called with:", {
      hasState: !!savedState,
      terminalCount: savedState?.terminals?.length,
    });

    if (!savedState?.terminals?.length) {
      Logger.warn("No valid saved state, manufacturing default state");
      savedState = this.createDefaultState();
    }

    this.clearExistingState();

    for (const terminalData of savedState.terminals) {
      this.restoreSingleTerminal(terminalData, isColdBoot);
    }

    this.activateRestoredTab(savedState.activeTabId);
    this.finalizeRestore(savedState);
  }

  saveToLocalState(): void {
    try {
      if (this.host.terminals.size === 0) {
        Logger.debug("🛡️ Clearing persisted webview state - no terminals remain");
        this.clearWebviewState();
        return;
      }

      const fullState = this.saveAllStates();
      Logger.debug(
        "TabManager saving state synchronously:",
        fullState ? `${fullState.terminals?.length} terminals` : "no state",
      );

      const prior = vscode.getState() || {};
      vscode.setState({
        ...prior,
        fullTabState: fullState,
        timestamp: Date.now(),
        historyBannerShownOnce:
          prior.historyBannerShownOnce || this.host.getHistoryBannerShownEver() || false,
      });

      try {
        const metadata = {
          terminals: fullState.terminals.map((t: any) => {
            const { buffer, ...meta } = t;
            return meta;
          }),
          activeTabId: fullState.activeTabId,
          timestamp: fullState.timestamp,
        };
        this.host.vscode.postMessage({
          command: "metadataUpdate",
          state: metadata,
        } satisfies WebviewToExtMessage);

        const buffers: Record<string, string> = {};
        for (const t of fullState.terminals) {
          if (t.uuid && t.buffer) {
            buffers[t.uuid] = t.buffer;
          }
        }
        if (Object.keys(buffers).length > 0) {
          this.host.vscode.postMessage({
            command: "bufferUpdate",
            buffers,
          } satisfies WebviewToExtMessage);
        }
      } catch (msgError) {
        Logger.warn(
          "⚠️ Could not send state to extension (probably shutting down):",
          msgError,
        );
      }
    } catch (error) {
      Logger.error("Failed to save state:", error);
    }
  }

  private clearExistingState(): void {
    if (this.host.terminals.size > 0) {
      this.host.dispose();
    }
    this.host.terminals.clear();
    this.host.activeTabId = null;

    const tabBar = document.getElementById("tab-bar");
    if (tabBar) {
      tabBar.querySelectorAll(".tab").forEach((tab) => tab.remove());
    }

    this.host.resetLaunchSlot();
  }

  private restoreSingleTerminal(terminalData: any, isColdBoot: boolean): void {
    const terminal = new TerminalInstance(
      terminalData.id,
      terminalData.label,
      this.host.vscode,
      this.host.terminalTheme,
      this.host.getThemeColor,
      terminalData.terminalType || "default",
      { autoStartPty: false, uuid: terminalData.uuid },
    );

    const container = this.host.createTerminalContainer(terminalData.id);
    terminal.attachToContainer(container);

    if (isColdBoot && !terminalData.launchCommand && terminalData.buffer) {
      terminalData.buffer +=
        "\n\n\x1b[47m\x1b[30m * \x1b[0m\x1b[48;5;69m\x1b[30m History restored \x1b[0m\n\n";
    }

    terminal.restoreFromState(terminalData);

    if (terminal.whenOpened && typeof terminal.whenOpened.then === "function") {
      terminal.whenOpened.then(() => {
        try { terminal.startDeferredPtyIfNeeded(); }
        catch (e) { Logger.error("Deferred PTY start error:", e); }
        try {
          const snap = terminal.serialize();
          if (snap?.length) {
            Logger.debug(`Anchored snapshot post-open for terminal ${terminal.id} (chars=${snap.length})`);
          }
        } catch (e) { Logger.warn("Failed to update tab context:", e); }
      });
    } else {
      try { terminal.startDeferredPtyIfNeeded(); }
      catch (e) { Logger.error("Deferred PTY start error (no whenOpened):", e); }
    }

    if (terminalData.id >= this.host.nextTabId) {
      this.host.nextTabId = terminalData.id + 1;
    }

    this.host.terminals.set(terminalData.id, terminal);
    this.host.wireBellHandler(terminal);
    this.host.createTabElement(
      terminalData.id,
      terminalData.label || "Terminal",
    );
    this.host.requestFormattedTitle(terminalData.id);
  }

  private activateRestoredTab(savedActiveTabId: number | null): void {
    const targetId = savedActiveTabId && this.host.terminals.has(savedActiveTabId)
      ? savedActiveTabId
      : Array.from(this.host.terminals.keys())[0];

    if (targetId) {
      const allOpenPromises = Array.from(this.host.terminals.values())
        .map((t) => t.whenOpened.catch(() => {}));
      Promise.all(allOpenPromises).then(() => {
        this.host.switchToTab(targetId);
      });
    }
  }

  private finalizeRestore(savedState: any): void {
    this.host.initialize();
    this.host.clearInitTimeout();

    this.saveToLocalState();
    Logger.debug(
      "Restore complete -",
      this.host.terminals.size,
      "terminals, active tab:",
      this.host.activeTabId,
    );
  }

  private clearWebviewState(): void {
    const prior = vscode.getState() || {};
    vscode.setState({
      ...prior,
      fullTabState: null,
      timestamp: Date.now(),
    });
  }
}
