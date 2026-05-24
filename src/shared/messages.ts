/**
 * Shared message protocol — discriminated unions for postMessage traffic
 * between the extension host and the webview. Both sides import from
 * here so a typo in a command name or shape becomes a compile error.
 *
 * Conventions:
 * - `command` is the discriminator. Use a string literal type.
 * - The fields after `command` are the payload.
 * - Keep payloads flat where reasonable; nest only when there's natural
 *   sub-structure (e.g. `config` for `updateConfig`).
 *
 * Coverage is intentionally partial — this protocol grew organically and
 * not every legacy message has been migrated. Add new commands here as
 * you wire them. The `any`-fallback `LegacyMessage` exists so the
 * handler functions can still accept arbitrary inputs during migration.
 */

// ────────────────────────────────────────────────────────────────────
// Extension host → webview
// ────────────────────────────────────────────────────────────────────

export type ExtToWebviewMessage =
  // PTY data stream + bell signal
  | { command: "data"; tabId: number; data: string }
  | { command: "bell"; tabId: number }
  | { command: "cwdChange"; tabId: number; cwd: string }
  | { command: "userVarChange"; tabId: number; vars: Record<string, string> }
  | { command: "processChange"; tabId: number; processName: string }
  // Tab/PTY lifecycle
  | { command: "createNewTab"; terminalType?: string; launchCommand?: string; cwd?: string; shellPath?: string }
  | { command: "switchToTab"; tabId: number }
  // Configuration + state
  | { command: "updateConfig"; config: WebviewConfig }
  | { command: "restoreState"; state: unknown; cold?: boolean }
  | { command: "initializeEmpty"; cold?: boolean }
  | { command: "stateResponse"; state: unknown }
  | { command: "savedCommandsList"; commands: SavedCommand[] }
  | { command: "commandSavedResponse"; launchCommand: string; isSaved: boolean }
  | { command: "formatTabTitleResponse"; tabId: number; title: string }
  // UI signals
  | { command: "focus" }
  | { command: "refresh" }
  | { command: "refreshActive" }
  | { command: "triggerResize" }
  | { command: "reset" }
  | { command: "redraw" }
  | { command: "reconnect" }
  | { command: "requestState" }
  | { command: "collectPerformance" }
  | { command: "setDebugFilter"; filter: unknown }
  | { command: "setDeveloperMode"; enabled: boolean }
  | { command: "openIconPicker"; tabId: number }
  | { command: "debugPasteImageBytes"; tabId: number; pngBase64: string };

// ────────────────────────────────────────────────────────────────────
// Webview → extension host
// ────────────────────────────────────────────────────────────────────

export type WebviewToExtMessage =
  // PTY control
  | { command: "createPty"; tabId: number; cols: number; rows: number; cwd?: string; shellPath?: string; launchCommand?: string }
  | { command: "disposePty"; tabId: number }
  | { command: "resize"; tabId: number; cols: number; rows: number }
  | { command: "data"; tabId: number; data: string }
  | { command: "clearBuffer"; tabId: number }
  | { command: "sendFilePath"; tabId: number; filePath: string }
  | { command: "sendFileData"; tabId: number; fileData: string; fileName: string; fileType: string; fileSize: number }
  | { command: "fileDrop"; tabId: number; fileName: string; fileType: string; fileSize: number; fileData: string }
  // Tab control / coordination
  | { command: "switchTab"; tabId: number }
  | { command: "newTab"; terminalType?: string }
  | { command: "closeTab"; tabId: number }
  | { command: "renameTab"; tabId: number; newName: string }
  | { command: "saveCommand"; tabId: number; launchCommand: string; tabLabel: string; iconClass?: string }
  | { command: "saveCurrentCommand"; tabId: number }
  | { command: "checkCommandSaved"; launchCommand: string }
  | { command: "checkProcesses"; tabId: number }
  | { command: "checkProcessesResponse"; tabId: number; processes: Array<{ pid: number; name: string }> }
  | { command: "formatTabTitle"; tabId: number; opts: Record<string, unknown> }
  | { command: "processChange"; tabId: number; processName: string }
  // Window/panel signals
  | { command: "ready" }
  | { command: "webviewReady" }
  | { command: "panelFocused" }
  | { command: "bell"; tabId: number; tabLabel?: string }
  | { command: "bellDiagnostic"; tabId: number; source: string }
  | { command: "performanceReport"; data: PerformanceData }
  | { command: "clipboardCopy"; text: string }
  // External actions
  | { command: "openFile"; filePath: string; terminalId: number }
  | { command: "openUrl"; url: string }
  | { command: "openSettings" }
  | { command: "openSetting"; key: string }
  | { command: "openJson"; path: string }
  // State persistence
  | { command: "state"; state: unknown }
  | { command: "metadataUpdate"; tabId: number; metadata: Record<string, unknown> }
  | { command: "bufferUpdate"; tabId: number; chunk: string }
  | { command: "bufferDelete"; tabId: number }
  | { command: "bufferContent"; tabId: number; content: string }
  | { command: "getTabBuffer"; tabId: number };

// Catch-all for in-flight migration — handler code can keep accepting
// arbitrary objects while we incrementally tighten the union.
export type AnyMessage = { command: string; [key: string]: unknown };

// ────────────────────────────────────────────────────────────────────
// Payload types referenced by the unions above
// ────────────────────────────────────────────────────────────────────

export interface WebviewConfig {
  alwaysShowTabs: boolean;
  clearSelectionOnCopy: boolean;
  scrollback: number;
  bellAwareTimeoutMinutes: number;
  terminalAppearance: TerminalAppearance;
}

export interface TerminalAppearance {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontWeightBold?: string;
  lineHeight?: number;
  letterSpacing?: number;
  cursorStyle?: string;
  cursorBlinking?: boolean;
  copyOnSelection?: boolean;
  smoothScrolling?: boolean;
  minimumContrastRatio?: number;
  wordSeparators?: string;
}

export interface SavedCommand {
  command: string;
  label?: string;
  count?: number;
  iconClass?: string;
}

export interface PerformanceData {
  count: number;
  samples: Array<{ id: number; initToOpen: number; openToActive: number | null }>;
  avgInit?: number;
  avgOpenToActive?: number;
}

// ────────────────────────────────────────────────────────────────────
// Helper: narrow a message by its `command` discriminator.
// ────────────────────────────────────────────────────────────────────

export type ExtractByCommand<T extends { command: string }, K extends T["command"]> =
  Extract<T, { command: K }>;
