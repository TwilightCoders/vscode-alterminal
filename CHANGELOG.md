# Changelog

All notable changes to the Alterminal extension will be documented in this file.

## [Unreleased]

### New Features

- **WebGPU renderer** (`alterminal.renderer: "webgpu"`): an optional GPU terminal renderer, built from scratch as a self-contained xterm addon — instanced glyph / rectangle / decoration passes over a shared `GPUDevice`, a shelf-packed glyph atlas with LRU eviction, and font-driven cell metrics. Lighter on renderer memory than the WebGL path. Opt-in; WebGL stays the default.

### Fixes

- **WebGPU: progress bars and colored backgrounds align.** Cell backgrounds now fill the block-glyph's vertical band rather than the full line-box cell, so block characters (`█` and partial blocks) and their backgrounds line up — and the font's line-gap stays as inter-line spacing instead of being painted.

### Technical

- Centralized versioning in `src/version.ts`; the dev build number is decoupled from the curated semver.

## [0.2.0-beta.1] — 2026-05-24

First beta. Big focus on the notification/bell system, tab UX, and a search bar.

### New Features

- **Cross-window bell notifications**: when a terminal in a *background* window needs you — Claude Code finishing a turn, any tool ringing the bell — a toast appears on whatever window you're currently focused on (even a different project), with an **Open Project** button that jumps to it. Routed through a shared store in the extension's global storage; only the focused window shows the toast, so there's no focus stealing and no stale notification waiting when you switch back.
- **Three-state tab indicators**: clean → a subtle **activity dot** (background output) → a **swinging bell** (attention / BEL). Bell-aware mode: once a tab rings a bell, ordinary stdout chatter (spinners, watch-mode rebuilds, REPL repaints) stops flashing the activity dot — the bell becomes that tab's signal — reverting after an idle timeout (`alterminal.bellAwareTimeoutMinutes`, default 60).
- **Agent end-of-turn detection**: detects OSC 9 / 99 / 777 notification escapes (iTerm2 / kitty / ghostty style) that Claude Code and similar agents emit when they finish and need input, surfacing them as bells. Progress sequences (`OSC 9;4`) are excluded so long tool calls don't false-flash. *(Requires the agent's notification channel to be enabled — see the Claude Code section in the README.)*
- **Tab close button**: an `×` on each tab, matching VS Code's editor tabs — visible on the active tab and on hover; the activity dot sits in its place when there's unread output.
- **Find in terminal** (`Cmd+F` / `Ctrl+F`): a floating search bar (xterm SearchAddon) with next/previous and a match count.
- **Drag-drop images into Claude Code**: dropping an image onto a tab running Claude Code now attaches it as an image (`[Image #N]`) by writing it to a temp file and injecting the path through a bracketed paste — rather than dumping a path that expires.
- **Full codicon picker**: set a tab's icon from the complete codicon set via a searchable grid (was a fixed 12-icon list).

### Fixes

- **In-tab bell icon now actually appears.** The extension host detected bells but never forwarded the event to the webview, so the per-tab bell icon never showed. It does now.
- **Bell no longer nags the window you're looking at.** The window-title `${bell}` indicator and toasts are suppressed while the window is focused and cleared the moment it regains focus — they only fire for windows you're away from.
- **Bell icon swings** (like a struck clapper) instead of pulsing.

### Technical / loompty compatibility

- Hardened daemon control-frame correlation against unsolicited `user_data` broadcasts (loompty PROTOCOL §4.12): only genuine response types resolve a pending request, so a broadcast can't be mistaken for one.
- **Zero-downtime daemon restart.** "Restart PTY Daemon" now performs a true SCM_RIGHTS session handoff (loompty `--handoff-listen`, PROTOCOL §4.11/§6): a successor daemon is brought up listening on a handoff socket, the dying daemon hands it the live PTY master fds, and clients reconnect to the successor — live shells are preserved across the swap instead of being killed.
- **Auto-reconnect + reattach across all windows.** When the shared daemon is swapped, every window's control socket drops; each window independently treats the unexpected disconnect as the signal to reconnect to the canonical socket and `reattach` its sessions (resume-only, no scrollback replay). No cross-window coordination and nothing routed through VS Code — the dropped socket *is* the signal. Intentional disconnects (deactivate, the triggering window's own restart) are flagged and skipped.
- New `reattach` control message (resume, no replay) distinct from `attach` (full scrollback replay); `AttachMessage`/`ReattachMessage` carry `rows`/`cols` so the successor restores grid dimensions.
- **F5 dev launch rebuilds both projects.** The watch task only covered the extension tsconfig before, so webview changes silently didn't take effect; it now watches the extension and webview projects in parallel.

## [0.2.0-dev.21] — 2026-05-09

### Fixes (memory bloat)

- **Loomptyd refuses to start when one is already running**. Previously, every spawn unconditionally `unlink()`'d the existing socket and bound a new one — leaving the prior daemon orphaned but alive, holding all its sessions and scrollback. Repeated VS Code reloads accumulated zombie loomptyds, each retaining hundreds of MB. New `is_socket_responsive()` probe rejects re-starts on a live socket.
- **Loompty scrollback now caps total bytes (default 16 MiB)**, not just chunk count. The 10000-entry cap was meaningless when each entry could be 64KB; worst case was 640MB per session.
- **PtyManager hidden-buffer caps total bytes (16 MiB / tab)** instead of only chunk count. Replay path uses a single-pass `flush()` to avoid holding the concatenated string and chunk array simultaneously.

Together these can free multi-GB of extension-host and daemon memory for users who saw runaway RSS on fresh VS Code boots.

## [0.2.0-dev.20] — 2026-05-03

### New Features

- **`${bell}` and `${remote}` window title variables**: Add `${bell}` to your `window.title` to see an icon (and unread count) when background tabs ring; add `${remote}` for an uppercase remote-context label (`SSH`, `WSL`, `LOCAL`, ...).
- **Inherit VS Code's `terminal.integrated.*` settings**: Fonts, cursor, scrollback, smooth scrolling, word separators, contrast ratio, copy-on-selection — all flow through automatically. `alterminal.*` keys override only when explicitly set.
- **Custom settings editor**: Dedicated webview with inherited-value indicators, Alterminal-unique vs. Terminal Appearance sections, clickable `terminal.integrated.*` references that jump to VS Code's settings UI, and a description column.
- **`alterminal.suppressFocusStealingSequences` toggle**: Default on. Strips OSC sequences (633, 133, 7, 9, 1337, DEC ?1004) that make VS Code or other apps steal focus to their own terminal. Disable if your tooling depends on these sequences passing through.
- **Per-compile dev build counter**: Each compile increments a build number visible in the webview title strip and status bar (`Alterminal dev.N`).

### Fixes

- **Link underline wrapping**: When a path/URL line ended exactly at terminal width, xterm-link-provider concatenated the soft-wrapped continuation row, causing underlines to extend across two rows and false matches like `alterminal` + `Loading` → `alterminalLoading`. Multi-row library matches are now clipped to the first row.
- **OSC 9 notifications**: Filter widened from `9;9` only (ConEmu CWD) to any `9;<payload>`, catching Windows Terminal-style notifications that some tools (e.g. Claude Code) emit and VS Code reacts to.
- **Drop focus**: Dropping a file/folder onto a terminal now focuses that terminal so subsequent typing lands there.

### Technical

- **Migrated to loomptyd** (C++ PTY daemon from loompty): better PID isolation from VS Code's process tracking, hardened signal propagation, hot-restart with FD handoff so shells survive daemon restarts.
- **xterm Unicode addon** upgraded from `unicode11` to `unicode-graphemes`.
- **BellNotificationService extracted** into a dedicated class with its own tests.
- **Daemon integration + layer tests** (FrameDecoder, lockfile, shellEscape, spawn, persistence, reattach).
- **`scripts/daemon-status.sh`** diagnostic.
- **Skip loomptyd copy+re-sign** when source unchanged (faster builds).

## [0.2.0-dev.12] — 2026-03-30

### New Features

- **Daemon hot-restart with FD handoff**: `Alterminal: Restart PTY Daemon` command. New daemon inherits PTY master file descriptors via stdio inheritance, so shells survive daemon restarts without interruption.
- **OSC 52 clipboard support**: Programs can copy text to the system clipboard via `\x1b]52;c;<base64>\x07`. Works in tunnel mode.
- **Cross-line link detection**: URLs and file paths split across hard-wrapped lines (e.g., by Claude Code/Ink) are joined into a single clickable link.
- **Dev install workflow**: `npm run dev:install` auto-increments the build number, compiles, packages, and installs locally.

### Fixes

- **Stale PTY entries block spawn**: Daemon no longer rejects PTY creation when a dead entry exists for the same UUID. Dead entries are cleaned up automatically.
- **Session ID mismatch after reboot**: PTYs reattach across reboots when the session ID changes but the UUID persists. `listPtys` returns all PTYs regardless of session. `attachPty` reassigns session ownership.
- **Resize ghost artifacts**: Screen cleared on dimension change to prevent stale content from TUI apps.
- **Error logging**: Daemon spawn failures now log the actual error message instead of `{}`.

### Technical

- **Data pipeline extracted**: `filterVSCodeSequences`, `extractCwdFromOsc7`, `extractUserVars`, `replaceBelWithST` moved to standalone `dataPipeline.ts` module for testability.
- **3-tier test suite**: 127 tests across unit, integration, and real PTY tiers with MockWebview and PtyTestHarness helpers.
- **FocusGuard cleaned up**: Removed unnecessary event listeners, added 8 timing logic tests.

## [0.1.36]

### New Features

- **Unified Terminal Launcher**: Single `+` button replaces separate terminal and launch command buttons. Opens a QuickPick showing detected shells, saved commands, and ad-hoc command input in one place
- **Shell Detection**: Automatically detects installed shells from `/etc/shells` (Unix) or system PATH (Windows) and presents them in the launcher with the default shell marked
- **Cross-Window Bell Notifications**: Terminal bell events now appear as VS Code notifications in whichever window is focused, not just the originating window. Clicking "Go to Terminal" deep-links back to the originating window and switches to the correct Alterminal tab
- **Consolidated Toolbar**: Toolbar simplified to two icons — `+` (unified launcher) and wrench (Tools menu containing Settings, Refresh, and debug utilities)

### Improvements

- **Edit Saved Commands** now opens `settings.json` directly, scrolled to the `alterminal.savedCommands` key, instead of the Settings UI
- **Shell-specific tab labels**: Selecting a non-default shell in the launcher names the tab after the shell (e.g., "fish" instead of "Terminal")
- **Bell debouncing**: Rapid bell events within 3 seconds are consolidated into a single notification

### Technical

- PTY-side BEL detection strips OSC sequence terminators to avoid false bell triggers
- Bell events forwarded from webview to extension host with tab labels for richer notifications
- `shellPath` threaded through the full webview → messageHandler → tabManager → terminal → ptyManager pipeline
- Cross-window communication via `vscode://` URI routing with `/bell` and `/focus` handlers

## [0.1.32]

### Improvements

- **Test suite fixes**: Fixed test suite and added CommandManager unit tests
- **Saved command disambiguation**: Launch picker now disambiguates saved commands by label when multiple commands share the same command string
- **Template token resolution**: Distinguish null vs undefined in template token resolution for more predictable behavior

## [0.1.31]

### Improvements

- **Tab cursor style**: Use pointer cursor for tabs instead of grab cursor
- **Code cleanup**: Remove dead code and broken one-way message paths
- **Settings bridge fix**: Wire broken openSettings and saveCurrentCommand message bridges

## [0.1.30]

### New Features

- **Interactive tokens**: `{i:prompt}` in saved commands prompts the user at launch time — use in `cwd` for a folder picker or in `command` for an input box
- **Per-command CWD**: Saved commands now support a `cwd` property so each command can launch in a specific directory

## [0.1.29]

### Bug Fixes

- **Webview module loading**: Separate ES6 build output for webview modules to avoid overwriting extension host's CommonJS output
- **Shell integration**: Bundled lightweight shell hooks for zsh, bash, and fish for event-driven CWD tracking

## [0.1.28]

### New Features

- **Clear Selection on Copy Setting**: New `alterminal.clearSelectionOnCopy` option to keep text selected after copying (defaults to true for existing behavior)
- **Panel Border**: Left border divider matching VS Code's built-in terminal panel appearance

### Bug Fixes

- **CWD Persistence on Reload**: Terminal tabs now restore to the correct working directory after window reload via lightweight shell integration hooks (zsh, bash, fish) that emit OSC 7 on directory change
- **CWD Not Updating in Tabs**: Fixed metadata extraction being skipped when PTY data consisted entirely of escape sequences
- **Double Paste**: Removed dead `clipboardPaste` handler that was the second write path causing paste duplication in remote/tunnel instances

### Performance

- **Reduced Typing Lag**: Consolidated per-keystroke regex operations, added fast-path bypass for plain text output, debounced title formatting to prevent IPC storms
- **Lower Timer Churn**: Eliminated per-keystroke timer creation and dispatch overhead
- **Hot Path Optimization**: Unified escape sequence filtering into a single regex pass, added Debouncer utility, deferred serialization

### Hardening

- **PTY Environment**: Strip `VSCODE_*`/`ELECTRON_*` env vars and VS Code's ASKPASS helpers to prevent focus stealing. Filter OSC 133 (FinalTerm) and OSC 9;9 (ConEmu) sequences
- **Data-First Forwarding**: PTY data is forwarded to the webview before metadata extraction to reduce perceived latency
- **Shell Integration**: Bundled lightweight shell hooks for zsh (ZDOTDIR), bash (PROMPT_COMMAND), and fish (--init-command) with async OS-level fallback for unsupported shells

### Build

- **Separate Webview Output**: Webview ES6 modules now compile to `out-webview/` to avoid overwriting the extension host's CommonJS output, fixing module loading failures

## [0.1.27]

### Bug Fixes

- **Separated Buffer Storage**: Terminal metadata saved to clean JSON state, buffers stored individually by UUID. Fixes editable debug state and legacy migration
- **Saved Command Overwrite**: Fixed race condition where saved commands could be overwritten

## [0.1.26]

### New Features

- **Clipboard Support**: Copy/paste now works reliably in all contexts including remote/VNC, routed through `vscode.env.clipboard` instead of browser APIs
- **Per-Tab Title Templates**: Each tab stores its own title template. Double-click a tab to edit its raw template (e.g. `{base}{p? • {p}}`). The global setting is the default for new tabs; per-tab overrides persist across sessions
- **User Variable Tokens**: Programs can set variables via OSC 1337 SetUserVar, accessible in title templates as `{$varname}`

### Bug Fixes

- **Fixed Template Engine**: Rewrote template engine to use balanced-brace parsing instead of iterative regex. Nested tokens like `{p? • {p}}` now render correctly instead of showing raw template text
- **Fixed Bell Notifications**: Bell icon now only triggers on actual BEL characters (`\x07`), not on any terminal output. Previously, any substantial output on an inactive tab would show the bell
- **Tightened Link Detection**: Bare relative paths no longer match trailing slashes (which caused xterm-link-provider to miscalculate link regions and bleed underlines across lines)

## [0.1.25]

### New Features

- **Command Template Variables**: Saved commands now support `{workspace}`, `{workspacePath}`, `{user}`, `{platform}`, `{env.VAR}` so a single saved command adapts per-workspace at launch time
- **Per-Terminal CWD Tracking**: Parse OSC 7 escape sequences to track working directory per terminal. Terminals reopen in the correct directory on restore
- **CWD Title Tokens**: `{cwd}` and `{path}` tokens now work in tab title templates. Added `{cwdN}` syntax for last N path components (e.g. `{cwd2}` for `parent/leaf`)
- **OSC Title Token**: `{title}` token exposes the terminal-reported title (via OSC 0/2 escape sequences). Opt-in via templates like `{base}{title? - {title}}`

### Code Quality

- Extracted shared `TemplateEngine` from `TabTitleProvider` for reuse across tab titles and command templates
- Removed dead code: unused terminal methods, wasteful save-on-every-message, stale fields

## [0.1.24]

### Architecture

- **Fixed Event Listener Leaks**: Properly track and dispose event handlers in dragDropHandler, tabManager, init, terminal, and ptyManager
- **Modernized Link Detection**: Updated xterm-link-provider 1.3.1 to 2.0.0, replacing ~90 lines of manual coordinate math with LinkProvider
- **Flattened Manager Wrappers**: Inlined TerminalController and NotificationManager into their parent classes, removing unnecessary indirection

### Bug Fixes

- Fixed shell escaping in `sendFilePath` (POSIX quote escaping)

## [0.1.23]

### Bug Fixes

- **Fixed missing platform binaries**: Added all platform-specific node-pty binaries to .vscodeignore to ensure they're included in published package (fixes "Cannot find module '@lydell/node-pty'" error on all platforms)

## [0.1.22]

### Bug Fixes

- **Fixed blank terminal after workspace switch**: Terminal now properly refreshes and redraws when switching between VS Code workspaces, preventing blank display until typing
- **Added focus debugging**: Comprehensive logging to track webview focus changes for troubleshooting focus-related issues

## [0.1.21]

### Bug Fixes

- **Fixed missing node-pty binaries**: Re-packaged with all platform binaries (v0.2.20 was broken)

## [0.1.20]

### Bug Fixes

- **Fixed tab disappearing when switching between panel views**: Added `retainContextWhenHidden` option to webview provider registration
- **Impact**: Alterminal tab now stays visible in the tab bar regardless of which other panel tabs are active

## [0.1.19]

### Bug Fixes

- **Fixed terminal output loss when switching tabs**: PTY output is now buffered when the panel is not visible
- **Automatic buffer replay**: When switching back to Alterminal, all buffered output is sent to the terminal
- **Impact**: No more lost output when switching between Alterminal and other panel tabs (Terminal, Debug Console, etc.)

## [0.1.18]

### Bug Fixes - CRITICAL for Remote-SSH/WSL Users

- **Fixed Extension Activation on Remote-SSH/WSL**: Now includes node-pty binaries for all platforms (linux-x64, linux-arm64, win32-x64, darwin-arm64) in the extension package
- **Root cause**: Extension was only packaged with macOS binaries, causing activation failures when connecting to Linux servers via Remote-SSH or using WSL
- **Impact**: Remote-SSH and WSL users will no longer see "@lydell/node-pty binary not found" errors

## [0.1.17]

### Bug Fixes - CRITICAL for Windows Users

- **Fixed Windows Shell Initialization**: Terminals now properly initialize on Windows with full PATH and environment variables
  - Root cause: Was using `cmd.exe` with empty args, which doesn't load user's PATH properly
  - Solution: Now uses PowerShell by default on Windows (properly loads environment from registry)
  - Fallback hierarchy: VS Code config → PowerShell Core (pwsh) → Windows PowerShell → cmd.exe
  - Added proper shell argument handling for PowerShell vs cmd.exe
- **Fixed "Command Not Found" Errors on Windows**: Commands like `git`, `npm`, `python` etc. now work properly
- **Fixed Empty Terminal on First Launch**: Terminals now load correctly on Windows fresh installs

### Impact

- Windows users will no longer experience "command not found" for standard commands
- Terminals will properly initialize on first launch
- Better shell environment inheritance on Windows

## [0.1.16]

### Performance Improvements

- **Removed MutationObserver Overhead**: Eliminated document.body MutationObserver that was causing performance storms during heavy terminal output. ResizeObserver already handles container size changes properly.
- **Memory Leak Fixes**:
  - Fixed visibilitychange event listener not being cleaned up on terminal disposal
  - Added proper ResizeObserver cleanup in dispose()
- **Optimized Process Name Monitoring**: Converted from constant 1-second polling to hybrid event-driven approach:
  - Checks process name on data events (when commands execute)
  - Reduced fallback polling from 1s → 5s interval
  - ~80% reduction in polling overhead
- **Eliminated ResizeObserver Duplication**: Only observe terminal container (not parent), preventing duplicate observers
- **Cached DOM Queries**: Container reference cached to avoid repeated `getElementById()` calls on every keypress
- **Debounced Terminal Activation**: Consolidated cascading fit() calls during terminal activation into single debounced call

### Expected User Impact

- Significantly reduced lag during heavy terminal output (like Claude responses)
- Image drops now complete successfully during active sessions
- Lower CPU usage with multiple terminals
- Eliminated memory leaks during long sessions
- Smoother keyboard interactions

## [0.1.15]

### Architecture

- **Webview Refactoring - Manager Extraction**: Further decomposed `tabManager.ts` into focused manager classes:
  - **LayoutManager** (201 lines): Responsive layout detection, window event handling, tab bar orientation switching
  - **TabUIManager** (559 lines): Tab bar UI rendering, interactions, drag-drop reordering, dropdown menus
  - **MessageHandler** (397 lines): Message routing from extension host to appropriate callbacks
  - **KeyboardManager** (164 lines): Keyboard shortcut handling and passthrough
- **Benefits**: Reduced tabManager.ts from 1811 → 1203 lines (-34%), improved separation of concerns, easier testing and maintenance

### Bug Fixes

- **Fixed Panel Reopen Issues**: Panel close/reopen now properly preserves terminal state without recreating PTYs:
  - Terminal buffer content fully preserved across panel visibility changes
  - No duplicate initialization messages on panel reopen
  - Tab titles render correctly without template placeholder artifacts
- **Fixed Tab Title Rendering on Restore**: Skip `formatTabTitle` request during state restoration to use saved labels directly, preventing double-formatting and template placeholder issues

## [0.1.14]

### Bug Fixes

- **Fixed Link Click Sandbox Error**: Override `window.confirm()` in webview to prevent sandbox errors when xterm.js attempts to show confirmation dialogs. Links now activate cleanly with Cmd/Ctrl+Click without errors.
- **Fixed State Restoration on Panel Reopen**: Terminal state now properly restores when closing and reopening the Alterminal panel. Added `resetRestoreTrigger()` to clear restoration guard on panel visibility changes.

## [0.1.13]

### Architecture

- **Major Refactoring - SOLID Decomposition**: Decomposed 943-line `AlterminalProvider` god object into 9 focused manager classes following SOLID principles:
  - **StateManager**: State persistence and restoration
  - **ConfigurationWatcher**: Configuration monitoring
  - **NotificationManager**: UI notifications and alerts
  - **CommandLauncher**: Command selection and launching UI
  - **FileOperationHandler**: File drops, path resolution, file/URL opening
  - **TabContextMenuHandler**: Tab context menu actions
  - **WebViewLifecycleManager**: Webview creation and lifecycle events
  - **MessageDispatcher**: Routes messages from webview to handlers
  - **TerminalController**: High-level terminal operations
- **Benefits**: Single Responsibility per class, improved testability, better maintainability, clearer separation of concerns, easier to extend without modifying existing code

### Code Quality

- **Full TypeScript Type Safety**: Removed `@ts-nocheck` pragma from all 9 webview files (terminal.ts, tabManager.ts, tabTitleManager.ts, contextMenu.ts, interfaces.ts, logger.ts, init.ts, inputHandler.ts, dragDropHandler.ts, lifecycleManager.ts) and fixed 100+ type errors. Zero TypeScript compilation errors.
- **Improved Error Handling**: Replaced 30+ silent catch blocks with proper error logging using Logger.error/warn, improving debugging and error visibility

### Bug Fixes

- **Fixed State Restoration**: Corrected state restoration flow to properly initialize terminals on first load and restore saved state on subsequent loads
- **Fixed Serializer Context Binding**: Fixed `this` context loss in serializer's handleMessage method by wrapping in arrow function

## [0.1.12]

### Performance Improvements

- **Dirty Tracking for State Saves**: Implemented smart caching that only serializes terminals that have changed, reducing serialization overhead by ~90% during active use. Critical for users with multiple projects and many terminals open simultaneously.
- **Constants Centralized**: Extracted all magic numbers (debounce timings, dimensions, limits) to `src/constants.ts` for better maintainability and configurability.

### Bug Fixes

- **Memory Leak Fixes**:
  - MutationObserver now properly disconnected on terminal disposal
  - Window event listeners (resize, focus, blur, beforeunload) now properly removed in TabManager.dispose()
  - Prevents memory growth during long sessions with multiple terminals

### Code Quality

- **Removed Ghost Cursor Workarounds**: Eliminated all ghost cursor polling/fixing code since the issue was resolved fundamentally by properly handling terminal escape sequences. Removes unnecessary DOM queries and interval timers.

## [0.1.11]

### Performance Improvements

- **Debounced Backup State Saves**: Backup state now saved with 500ms debounce (1000ms max wait) instead of on every update, dramatically reducing disk I/O and improving performance for users with multiple projects/terminals
- **Removed Debug Logging**: Cleaned up all debug logs from extension host code to reduce overhead and console noise

### Bug Fixes

- **Fixed HTTPS Link Sandbox Error**: Added `preventDefault()` to link activation to avoid "allow-modals" sandbox errors when clicking HTTPS links

## [0.1.10]

### Improvements

- **Enhanced Link Detection**: Now matches git references (e.g., `origin/master`, `upstream/main`) similar to VS Code built-in terminal
- **More Comprehensive Pattern Matching**: Improved regex to catch more path-like patterns while maintaining accuracy
- **Updated Tests**: Added tests for git branch/remote references (24 tests total, all passing)

## [0.1.9]

### Bug Fixes

- **Fixed Link Detection Regression**: Path matching now correctly handles directories like `~/.rbenv/shims/ruby` as complete paths instead of splitting them
- **Improved Regex Accuracy**: Link detection no longer treats hidden directories (e.g., `.rbenv`) as file extensions

### Testing

- **Added Comprehensive Test Suite**: 22 tests covering file paths, directories, URLs, and edge cases to prevent future regressions
- All link detection scenarios now have automated test coverage

## [0.1.8]

### Technical Improvements

- **Code Cleanup**: Removed ~230 lines of dead code including unused workspace file cache system, test commands, and debug statements
- **Reduced Bundle Size**: Cleaner codebase with better maintainability

## [0.1.7]

### Improvements

- **Enhanced Link System**: Removed duplicate WebLinksAddon, now using unified custom link provider for all file paths and URLs
- **Better Cursor Feedback**: Cursor remains text cursor for selection until Command/Ctrl is pressed, then changes to pointer for clicking links
- **Workspace-Relative Paths**: Paths without prefix (e.g., `src/webview/file.ts`) now correctly resolve relative to workspace root
- **Updated Description**: Clarified extension description to better communicate its purpose as a feature-rich terminal alternative

### Bug Fixes

- Links now require Command/Ctrl modifier key to activate, preventing accidental clicks during text selection
- HTTP/HTTPS URLs now properly detected and open in browser (works in production mode)

## [0.1.6]

### Bug Fixes

- **Fixed File Path Link Detection**: Correctly matches complete file paths like "source/file.js" instead of partial paths like "/file.js"
- **Added Directory Link Support**: Directories can now be clicked to reveal in VS Code explorer (e.g., `/Users/name/project`, `~/workspace`)
- **Improved Link Opening**: Directories now open in explorer instead of attempting to open as text documents

### Technical Improvements

- Simplified regex pattern for more reliable path matching
- Removed duplicate link handling code (unused linkProvider.ts)
- Added file/directory detection with appropriate VS Code commands

## [0.1.5]

### Bug Fixes

- **Fixed Workspace File Cache Crash**: Disabled workspace file scanning that caused crashes when opening large workspaces (e.g., home directory). The file cache was only used for legacy link validation and is no longer needed with the modern link provider implementation.
- **Fixed Clickable File Path Links**: File paths in terminal output are now fully functional - Command+click (Mac) or Ctrl+click (Windows/Linux) opens files in VS Code editor.
- **Added Link Hover Feedback**: Cursor changes to pointer when hovering over file paths while holding Command/Ctrl, providing clear visual feedback that links are clickable.

### Technical Improvements

- Implemented modern xterm.js link provider API matching WebLinksAddon's coordinate system for accurate link positioning
- Removed expensive workspace file scanning that could hang the extension on large projects
- Added CMD/Ctrl key state tracking with visual cursor feedback for better UX

## [0.1.4]

### New Features

- **Tab Icon Customization**: Right-click any tab and choose "Set Icon" to customize with icons like server, database, rocket, etc. - your choice persists across sessions
- **Buffer Inspection**: Right-click any tab and choose "Show Buffer" to view the raw terminal content in a text editor - perfect for debugging or copying output
- **Improved Debug State Viewer**: Debug state now opens in an editor (not a modal) with buffer content stripped for clarity - use "Show Buffer" on individual tabs to inspect content

### Improvements

- **No Save Prompts**: Debug files (state and buffers) now write to OS temp directory - close them without save prompts, OS handles cleanup
- **Better Async Handling**: Fixed message handling for buffer retrieval with proper timeout and error handling

## [0.1.3]

### New Features

- **Tab Reordering**: Drag and drop tabs to reorder them - your preferred arrangement persists across sessions
- **Always Show Tabs Setting**: New `alterminal.alwaysShowTabs` option to keep the tab bar visible even with a single terminal
- **Enhanced Drag Indicators**: Prominent visual feedback shows exactly where tabs will drop during reordering

### Improvements

- **Simplified Configuration**: Streamlined saved commands schema for better performance
- **Cleaner Debug Menu**: Removed unused debug commands for a more focused interface
- **Visual Polish**: Subtle grey borders around tabs for better definition

## [0.1.1]

### New Features

- **Drag & Drop Support**: Drop files directly into terminals with automatic handling
- **Clickable Links**: URLs and file paths are now clickable - file paths open directly in VS Code editor
- **Multi-Tab Interface**: Organize multiple terminal sessions with intelligent tab management
- **Hardware Acceleration**: WebGL-powered rendering for smooth performance

### Performance & Reliability Improvements

- **Better Theme Integration**: Seamless background color matching with VS Code themes
- **Modular Architecture**: Clean separation of concerns with dedicated managers for different features
- **Comprehensive Testing**: Automated test suite ensuring reliability

## [0.1.0]

### New Features

- **Command Automation**: Save and launch frequently used commands with one click
- **Smart Tab Management**: Enhanced tab titles with process detection and customizable templates
- **Improved Background Handling**: Perfect transparency integration with VS Code themes
- **Flexible Panel Positioning**: Drag Alterminal between sidebar, secondary sidebar, and bottom panel
- **Session Persistence**: Terminal sessions persist across VS Code restarts
- **Activity Bar Integration**: Quick access via terminal icon in Activity Bar

### Bug Fixes

- Fixed canvas background transparency issues
- Resolved text rendering problems with dark themes
- Improved terminal state restoration after VS Code restart
