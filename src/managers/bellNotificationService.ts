import * as vscode from "vscode";
import { Logger } from "../utils/logger";

type TimerHandle = ReturnType<typeof setTimeout>;

export interface BellNotificationHost {
  clearTimer(timer: TimerHandle): void;
  getBellIndicator(): string;
  getWebview(): vscode.Webview | undefined;
  now(): number;
  openTerminal(): Promise<void>;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  setTitleIndicator(value: string): void;
  showNotification(message: string, action: string): Thenable<string | undefined>;
}

export function createBellNotificationHost(
  getWebview: () => vscode.Webview | undefined,
  openTerminal: () => Promise<void>,
): BellNotificationHost {
  return {
    clearTimer: (timer) => clearTimeout(timer),
    getBellIndicator: () =>
      vscode.workspace
        .getConfiguration("alterminal")
        .get<string>("bellIndicator", "\u{1F514}"),
    getWebview,
    now: () => Date.now(),
    openTerminal,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    setTitleIndicator: (value) => {
      vscode.commands.executeCommand(
        "setContext",
        BellNotificationService.TITLE_CONTEXT_KEY,
        value,
      );
    },
    showNotification: (message, action) =>
      vscode.window.showInformationMessage(message, action),
  };
}

export class BellNotificationService {
  public static readonly TITLE_CONTEXT_KEY = "alterminal:bellIndicator";
  private static readonly BELL_CLEAR_GRACE_MS = 2000;
  private static readonly BELL_COOLDOWN_MS = 30_000;
  private static readonly BELL_DEBOUNCE_MS = 3000;

  private bellDebounceTimer: TimerHandle | null = null;
  private clearBellTimer: TimerHandle | null = null;
  private lastBellTime = 0;
  private readonly pendingBells = new Map<number, string>();
  private readonly unreadBellTabs = new Set<number>();
  private readonly bellNotifiedAt = new Map<number, number>();

  constructor(private readonly host: BellNotificationHost) {}

  public static registerTitleVariable(): void {
    vscode.commands.executeCommand(
      "setContext",
      BellNotificationService.TITLE_CONTEXT_KEY,
      "",
    );
    vscode.commands.executeCommand(
      "registerWindowTitleVariable",
      "bell",
      BellNotificationService.TITLE_CONTEXT_KEY,
    );
  }

  public handleBellSound(tabId: number, tabLabel: string): void {
    Logger.info(`Bell received: tabId=${tabId}, label=${tabLabel}`);

    const lastNotified = this.bellNotifiedAt.get(tabId) ?? 0;
    const inCooldown =
      lastNotified > 0 &&
      (this.host.now() - lastNotified) < BellNotificationService.BELL_COOLDOWN_MS;

    if (!inCooldown) {
      this.pendingBells.set(tabId, tabLabel || `Tab ${tabId}`);
    }

    this.unreadBellTabs.add(tabId);
    this.lastBellTime = this.host.now();

    if (this.clearBellTimer) {
      this.host.clearTimer(this.clearBellTimer);
      this.clearBellTimer = null;
    }

    this.updateTitleIndicator();

    if (this.bellDebounceTimer) {
      this.host.clearTimer(this.bellDebounceTimer);
    }

    this.bellDebounceTimer = this.host.setTimer(() => {
      this.bellDebounceTimer = null;
      this.showBellNotification();
    }, BellNotificationService.BELL_DEBOUNCE_MS);
  }

  public clearBellIndicator(): void {
    if (this.bellDebounceTimer) {
      this.host.clearTimer(this.bellDebounceTimer);
      this.bellDebounceTimer = null;
    }
    this.pendingBells.clear();

    if (this.unreadBellTabs.size === 0) return;

    const elapsed = this.host.now() - this.lastBellTime;
    if (elapsed < BellNotificationService.BELL_CLEAR_GRACE_MS) {
      if (this.clearBellTimer) return;
      this.clearBellTimer = this.host.setTimer(() => {
        this.clearBellTimer = null;
        this.unreadBellTabs.clear();
        this.bellNotifiedAt.clear();
        this.updateTitleIndicator();
      }, BellNotificationService.BELL_CLEAR_GRACE_MS - elapsed);
      return;
    }

    this.unreadBellTabs.clear();
    this.bellNotifiedAt.clear();
    this.updateTitleIndicator();
  }

  public clearBellForTab(tabId: number): void {
    this.pendingBells.delete(tabId);
    this.unreadBellTabs.delete(tabId);
    this.bellNotifiedAt.delete(tabId);
    this.updateTitleIndicator();
  }

  public handleTabClosed(tabId: number): void {
    this.pendingBells.delete(tabId);
    this.unreadBellTabs.delete(tabId);
    this.bellNotifiedAt.delete(tabId);
    this.updateTitleIndicator();
  }

  private updateTitleIndicator(): void {
    const icon = this.host.getBellIndicator();
    if (!icon) {
      this.host.setTitleIndicator("");
      return;
    }

    const count = this.unreadBellTabs.size;
    const value = count > 0 ? (count === 1 ? icon : `${icon}${count}`) : "";
    this.host.setTitleIndicator(value);
  }

  private showBellNotification(): void {
    const bells = new Map(this.pendingBells);
    this.pendingBells.clear();

    if (bells.size === 0) return;

    const now = this.host.now();
    for (const tabId of bells.keys()) {
      this.bellNotifiedAt.set(tabId, now);
    }

    const labels = Array.from(bells.values());
    const body =
      bells.size === 1 ? labels[0] : `${bells.size} terminals: ${labels.join(", ")}`;
    const lastTabId = Array.from(bells.keys()).pop();

    Logger.info(`Bell notification: ${body}`);

    this.host.showNotification(body, "Go to Terminal").then(async (selection) => {
      if (selection !== "Go to Terminal") return;
      this.clearBellIndicator();
      await this.host.openTerminal();
      this.host.setTimer(() => {
        const webview = this.host.getWebview();
        if (webview && lastTabId !== undefined) {
          webview.postMessage({
            command: "switchToTab",
            tabId: Number(lastTabId),
          });
        }
      }, 200);
    });
  }
}
