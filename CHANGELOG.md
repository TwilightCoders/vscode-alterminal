# Changelog

All notable changes to the Alterminal extension will be documented in this file.

## [0.2.20]

### Bug Fixes

- **Fixed tab disappearing when switching between panel views**: Added `retainContextWhenHidden` option to webview provider registration
- **Impact**: Alterminal tab now stays visible in the tab bar regardless of which other panel tabs are active

## [0.2.19]

### Bug Fixes

- **Fixed terminal output loss when switching tabs**: PTY output is now buffered when the panel is not visible
- **Automatic buffer replay**: When switching back to Alterminal, all buffered output is sent to the terminal
- **Impact**: No more lost output when switching between Alterminal and other panel tabs (Terminal, Debug Console, etc.)

## [0.2.18]

### Bug Fixes - CRITICAL for Remote-SSH/WSL Users

- **Fixed Extension Activation on Remote-SSH/WSL**: Now includes node-pty binaries for all platforms (linux-x64, linux-arm64, win32-x64, darwin-arm64) in the extension package
- **Root cause**: Extension was only packaged with macOS binaries, causing activation failures when connecting to Linux servers via Remote-SSH or using WSL
- **Impact**: Remote-SSH and WSL users will no longer see "@lydell/node-pty binary not found" errors

## [0.2.17]

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

## [0.2.16]

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

## [0.2.15]

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

## [0.2.14]

### Bug Fixes

- **Fixed Link Click Sandbox Error**: Override `window.confirm()` in webview to prevent sandbox errors when xterm.js attempts to show confirmation dialogs. Links now activate cleanly with Cmd/Ctrl+Click without errors.
- **Fixed State Restoration on Panel Reopen**: Terminal state now properly restores when closing and reopening the Alterminal panel. Added `resetRestoreTrigger()` to clear restoration guard on panel visibility changes.

## [0.2.13]

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

## [0.2.12]

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

## [0.2.11]

### Performance Improvements

- **Debounced Backup State Saves**: Backup state now saved with 500ms debounce (1000ms max wait) instead of on every update, dramatically reducing disk I/O and improving performance for users with multiple projects/terminals
- **Removed Debug Logging**: Cleaned up all debug logs from extension host code to reduce overhead and console noise

### Bug Fixes

- **Fixed HTTPS Link Sandbox Error**: Added `preventDefault()` to link activation to avoid "allow-modals" sandbox errors when clicking HTTPS links

## [0.2.10]

### Improvements

- **Enhanced Link Detection**: Now matches git references (e.g., `origin/master`, `upstream/main`) similar to VS Code built-in terminal
- **More Comprehensive Pattern Matching**: Improved regex to catch more path-like patterns while maintaining accuracy
- **Updated Tests**: Added tests for git branch/remote references (24 tests total, all passing)

## [0.2.9]

### Bug Fixes

- **Fixed Link Detection Regression**: Path matching now correctly handles directories like `~/.rbenv/shims/ruby` as complete paths instead of splitting them
- **Improved Regex Accuracy**: Link detection no longer treats hidden directories (e.g., `.rbenv`) as file extensions

### Testing

- **Added Comprehensive Test Suite**: 22 tests covering file paths, directories, URLs, and edge cases to prevent future regressions
- All link detection scenarios now have automated test coverage

## [0.2.8]

### Technical Improvements

- **Code Cleanup**: Removed ~230 lines of dead code including unused workspace file cache system, test commands, and debug statements
- **Reduced Bundle Size**: Cleaner codebase with better maintainability

## [0.2.7]

### Improvements

- **Enhanced Link System**: Removed duplicate WebLinksAddon, now using unified custom link provider for all file paths and URLs
- **Better Cursor Feedback**: Cursor remains text cursor for selection until Command/Ctrl is pressed, then changes to pointer for clicking links
- **Workspace-Relative Paths**: Paths without prefix (e.g., `src/webview/file.ts`) now correctly resolve relative to workspace root
- **Updated Description**: Clarified extension description to better communicate its purpose as a feature-rich terminal alternative

### Bug Fixes

- Links now require Command/Ctrl modifier key to activate, preventing accidental clicks during text selection
- HTTP/HTTPS URLs now properly detected and open in browser (works in production mode)

## [0.2.6]

### Bug Fixes

- **Fixed File Path Link Detection**: Correctly matches complete file paths like "source/file.js" instead of partial paths like "/file.js"
- **Added Directory Link Support**: Directories can now be clicked to reveal in VS Code explorer (e.g., `/Users/name/project`, `~/workspace`)
- **Improved Link Opening**: Directories now open in explorer instead of attempting to open as text documents

### Technical Improvements

- Simplified regex pattern for more reliable path matching
- Removed duplicate link handling code (unused linkProvider.ts)
- Added file/directory detection with appropriate VS Code commands

## [0.2.5]

### Bug Fixes

- **Fixed Workspace File Cache Crash**: Disabled workspace file scanning that caused crashes when opening large workspaces (e.g., home directory). The file cache was only used for legacy link validation and is no longer needed with the modern link provider implementation.
- **Fixed Clickable File Path Links**: File paths in terminal output are now fully functional - Command+click (Mac) or Ctrl+click (Windows/Linux) opens files in VS Code editor.
- **Added Link Hover Feedback**: Cursor changes to pointer when hovering over file paths while holding Command/Ctrl, providing clear visual feedback that links are clickable.

### Technical Improvements

- Implemented modern xterm.js link provider API matching WebLinksAddon's coordinate system for accurate link positioning
- Removed expensive workspace file scanning that could hang the extension on large projects
- Added CMD/Ctrl key state tracking with visual cursor feedback for better UX

## [0.2.4]

### New Features

- **Tab Icon Customization**: Right-click any tab and choose "Set Icon" to customize with icons like server, database, rocket, etc. - your choice persists across sessions
- **Buffer Inspection**: Right-click any tab and choose "Show Buffer" to view the raw terminal content in a text editor - perfect for debugging or copying output
- **Improved Debug State Viewer**: Debug state now opens in an editor (not a modal) with buffer content stripped for clarity - use "Show Buffer" on individual tabs to inspect content

### Improvements

- **No Save Prompts**: Debug files (state and buffers) now write to OS temp directory - close them without save prompts, OS handles cleanup
- **Better Async Handling**: Fixed message handling for buffer retrieval with proper timeout and error handling

## [0.2.3]

### New Features

- **Tab Reordering**: Drag and drop tabs to reorder them - your preferred arrangement persists across sessions
- **Always Show Tabs Setting**: New `alterminal.alwaysShowTabs` option to keep the tab bar visible even with a single terminal
- **Enhanced Drag Indicators**: Prominent visual feedback shows exactly where tabs will drop during reordering

### Improvements

- **Simplified Configuration**: Streamlined saved commands schema for better performance
- **Cleaner Debug Menu**: Removed unused debug commands for a more focused interface
- **Visual Polish**: Subtle grey borders around tabs for better definition

## [0.2.0]

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
