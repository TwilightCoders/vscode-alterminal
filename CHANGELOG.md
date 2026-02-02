# Changelog

All notable changes to the Alterminal extension will be documented in this file.

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
