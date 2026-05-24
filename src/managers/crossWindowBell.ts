import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Logger } from "../utils/logger";

/**
 * Cross-window bell coordination.
 *
 * VS Code's notification API is window-local: an extension host can only
 * draw a toast in its own window. To surface "project A's terminal needs
 * input" while the user is working in project B, we route through a
 * shared file in the extension's globalStorage (one location shared by
 * every window of the extension):
 *
 *   - An UNFOCUSED window whose terminal bells appends an event to the
 *     shared file (it never shows a local toast — the user isn't there).
 *   - Every window watches the file. When it changes, only the FOCUSED
 *     window renders a native toast (for events it hasn't seen and didn't
 *     originate). The toast lands where the user actually is, with no
 *     cross-window focus stealing (each window draws its own toast).
 *
 * Events carry a timestamp and are pruned by TTL so a window that gains
 * focus later doesn't replay a backlog.
 */

export interface CrossWindowBellEvent {
  id: string;
  originId: string;
  project: string;
  body: string;
  ts: number;
  /**
   * Navigation target as a URI string — the originating window's
   * `.code-workspace` file if it has one, else its first folder. Opening
   * this focuses the existing window instead of spawning a duplicate.
   */
  navTarget?: string;
}

interface BellStore {
  events: CrossWindowBellEvent[];
}

const EVENT_TTL_MS = 15_000;
const MAX_EVENTS = 25;
const STORE_FILENAME = "cross-window-bells.json";

/** Append an event and prune by TTL + count. Pure — unit tested. */
export function appendEvent(
  events: CrossWindowBellEvent[],
  ev: CrossWindowBellEvent,
  now: number,
  ttlMs: number = EVENT_TTL_MS,
  maxEvents: number = MAX_EVENTS,
): CrossWindowBellEvent[] {
  const fresh = [...events, ev].filter((e) => now - e.ts <= ttlMs);
  return fresh.slice(-maxEvents);
}

/**
 * Events worth showing in THIS window: newer than the last one we
 * processed, and not originated by us. Pure — unit tested.
 */
export function selectUnseen(
  events: CrossWindowBellEvent[],
  lastSeenTs: number,
  myOriginId: string,
): CrossWindowBellEvent[] {
  return events.filter((e) => e.ts > lastSeenTs && e.originId !== myOriginId);
}

export class CrossWindowBellCoordinator {
  private lastSeenTs: number;
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(
    private readonly storeFilePath: string,
    private readonly originId: string,
    private readonly project: string,
    private readonly navTarget: string | undefined,
    private readonly isFocused: () => boolean,
    private readonly showToast: (event: CrossWindowBellEvent) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    // Start "caught up" so we never replay events that predate this window.
    this.lastSeenTs = this.now();
  }

  start(): void {
    try {
      fs.mkdirSync(path.dirname(this.storeFilePath), { recursive: true });
      if (!fs.existsSync(this.storeFilePath)) {
        this.writeStore({ events: [] });
      }
    } catch (e) {
      Logger.warn("[cross-window-bell] could not initialize store:", e);
    }

    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(path.dirname(this.storeFilePath)),
      path.basename(this.storeFilePath),
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange(() => this.onStoreChanged());
    this.watcher.onDidCreate(() => this.onStoreChanged());
  }

  /** Record a bell from THIS (unfocused) window for other windows to see. */
  publish(body: string): void {
    const ev: CrossWindowBellEvent = {
      id: crypto.randomUUID(),
      originId: this.originId,
      project: this.project,
      body,
      ts: this.now(),
      navTarget: this.navTarget,
    };
    const store = this.readStore();
    store.events = appendEvent(store.events, ev, this.now());
    this.writeStore(store);
  }

  private onStoreChanged(): void {
    const store = this.readStore();
    const unseen = selectUnseen(store.events, this.lastSeenTs, this.originId);
    // Advance the cursor regardless of focus so we never replay a backlog
    // when this window later gains focus.
    for (const e of store.events) {
      if (e.ts > this.lastSeenTs) this.lastSeenTs = e.ts;
    }
    if (!this.isFocused() || unseen.length === 0) return;
    for (const e of unseen) {
      this.showToast(e);
    }
  }

  private readStore(): BellStore {
    try {
      const raw = fs.readFileSync(this.storeFilePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.events)) return parsed as BellStore;
    } catch {
      // Missing or malformed — treat as empty.
    }
    return { events: [] };
  }

  private writeStore(store: BellStore): void {
    try {
      fs.writeFileSync(this.storeFilePath, JSON.stringify(store), "utf8");
    } catch (e) {
      Logger.warn("[cross-window-bell] write failed:", e);
    }
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }
}

/**
 * Build the coordinator for a window. `project` is the workspace folder
 * name (what the user recognizes). The store lives in globalStorage so
 * every window shares it.
 */
export function createCrossWindowBellCoordinator(
  context: vscode.ExtensionContext,
): CrossWindowBellCoordinator {
  const storeFilePath = path.join(context.globalStorageUri.fsPath, STORE_FILENAME);
  const originId = crypto.randomUUID();

  // Navigation target: prefer the .code-workspace file (so windows opened
  // from a workspace file are focused, not duplicated as a bare folder),
  // else the first folder. Display name uses workspace.name when set.
  const workspaceFile = vscode.workspace.workspaceFile;
  const folder = vscode.workspace.workspaceFolders?.[0];
  const navUri =
    workspaceFile && workspaceFile.scheme === "file"
      ? workspaceFile
      : folder?.uri;
  const navTarget = navUri?.toString();
  const project = vscode.workspace.name ?? folder?.name ?? "Alterminal";

  const showToast = (event: CrossWindowBellEvent) => {
    const message = `${event.project} — ${event.body}`;
    const action = event.navTarget ? "Open Project" : undefined;
    const items = action ? [action] : [];
    vscode.window.showInformationMessage(message, ...items).then((selection) => {
      if (selection === action && event.navTarget) {
        // Focuses the existing window for that workspace/folder. For a
        // .code-workspace URI this matches the workspace window instead of
        // opening the bare folder as a duplicate.
        vscode.commands.executeCommand(
          "vscode.openFolder",
          vscode.Uri.parse(event.navTarget),
          { forceNewWindow: false },
        );
      }
    });
  };

  return new CrossWindowBellCoordinator(
    storeFilePath,
    originId,
    project,
    navTarget,
    () => vscode.window.state.focused,
    showToast,
  );
}
