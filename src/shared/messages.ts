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
  | { command: "checkProcessesResponse"; tabId: number; processes: Array<{ pid: number; name: string }> }
  // Configuration + state
  | { command: "updateConfig"; config: WebviewConfig }
  | { command: "restoreState"; state: unknown; cold?: boolean; liveDaemonUuids?: string[] }
  | { command: "initializeEmpty"; cold?: boolean }
  | { command: "stateResponse"; state: unknown }
  // The webview reads `commands` as a flat list of command strings.
  | { command: "savedCommandsList"; commands: string[] }
  | { command: "commandSavedResponse"; launchCommand: string; isSaved: boolean }
  | { command: "formatTabTitleResponse"; tabId: number; title: string }
  // Tab control echoed back to the webview (sent by context-menu / command handlers)
  | { command: "renameTab"; tabId: number }
  | { command: "closeTab"; tabId: number }
  | { command: "setTabIcon"; tabId: number; icon: string }
  | { command: "getTabBuffer"; tabId: number }
  | { command: "saveCurrentCommand" }
  | { command: "updateFileCache"; files?: string[] }
  | { command: "fileExistsResponse"; filePath: string; exists: boolean }
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
  | { command: "debugPasteImageBytes"; tabId?: number; pngBase64?: string };

// ────────────────────────────────────────────────────────────────────
// Webview → extension host
// ────────────────────────────────────────────────────────────────────

export type WebviewToExtMessage =
  // PTY control
  | { command: "createPty"; tabId: number; cols: number; rows: number; cwd?: string; shellPath?: string; launchCommand?: string; terminalType?: string; uuid?: string }
  | { command: "disposePty"; tabId: number }
  | { command: "resize"; tabId: number; cols: number; rows: number }
  | { command: "data"; tabId: number; data: string }
  | { command: "clearBuffer"; tabId: number }
  | { command: "sendFilePath"; tabId: number; filePath: string }
  | { command: "sendFileData"; tabId: number; fileData: string; fileName: string; fileType: string }
  | { command: "fileDrop"; tabId: number; fileName: string; fileType: string; fileSize: number; fileData: string }
  // Tab control / coordination
  | { command: "switchTab"; tabId: number }
  | { command: "newTab"; terminalType?: string }
  // Closes a tab; the host routes this to PtyManager to dispose the PTY.
  | { command: "closeTab"; tabId: number }
  | { command: "saveCommand"; tabId: number; launchCommand: string; tabLabel: string; iconClass?: string }
  | { command: "checkCommandSaved"; launchCommand: string }
  | { command: "checkProcesses"; tabId: number }
  // Sent with the full render context; the host reads each field individually.
  | { command: "formatTabTitle"; tabId: number; tabName?: string; baseTabName?: string; template?: string; processName?: string; processId?: number; oscTitle?: string; fullCommand?: string; workingDirectory?: string; lastExitCode?: number; userVars?: Record<string, string> }
  // Window/panel signals
  | { command: "webviewReady" }
  | { command: "panelFocused" }
  | { command: "bellDiagnostic"; tabId: number; source: string }
  | { command: "playBellSound"; tabId: number; tabLabel?: string }
  | { command: "performanceReport"; data: PerformanceData }
  | { command: "clipboardCopy"; text: string }
  | { command: "debugLog"; [key: string]: unknown }
  // Cross-direction signals (registered as no-op host handlers; really handled in the webview)
  | { command: "setDebugFilter"; filter: unknown }
  | { command: "setDeveloperMode"; enabled: boolean }
  // External actions
  | { command: "openFile"; filePath: string; terminalId: number }
  | { command: "openUrl"; url: string }
  | { command: "openSettings" }
  // Emitted by the webview's error-overlay "Refresh Terminal" button.
  // Currently has no host handler (logged as unhandled) but is a real
  // outbound message, so it lives in the union for honesty.
  | { command: "refresh" }
  // State persistence
  | { command: "metadataUpdate"; state: Record<string, unknown> }
  | { command: "bufferUpdate"; buffers: Record<string, string> }
  | { command: "bufferDelete"; uuid: string }
  | { command: "bufferContent"; tabId: number; buffer: string }
  | { command: "stateUpdate"; state: unknown }
  | { command: "stateResponse"; state: unknown };

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
  lineSpacing?: number;
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
