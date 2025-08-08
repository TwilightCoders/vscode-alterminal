<img src="media/icon.png" alt="Claude Pilot Icon" width="200" height="200" style="float: right; padding-left: 20px;">

# Claude Pilot
A Claude Code terminal view for VS Code that can be moved to different VS Code regions.

## Features

- **Moveable Terminal**: Drag and drop the Claude terminal between the primary sidebar, secondary sidebar, and bottom panel
- **Persistent Sessions**: Terminal sessions persist between VS Code restarts
- **Activity Bar Integration**: Quick access via the robot icon in the Activity Bar
- **Status Bar Button**: Launch Claude from the status bar
- **Editor Integration**: Access Claude via the editor toolbar
- **Drag & Drop Support**: Drop files and text directly into the terminal

> Architecture / roadmap: See `docs/ARCHITECTURE_REVIEW_2025-08-08.md` for current technical debt, performance plan, and future direction (evolving toward a general-purpose smart terminal with profile-based auto commands, not Claude-specific).

## Usage

1. Click the robot icon in the Activity Bar to open Claude Pilot
2. Drag the panel to your preferred location (sidebar, secondary sidebar, or bottom panel)
3. Use the terminal just like the built-in Claude Code terminal
4. Sessions persist automatically between VS Code sessions

## Requirements

- VS Code 1.74.0 or higher
- [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code) by Anthropic
- Claude Code CLI installed and available in your `PATH`

## Installation

Install from the VS Code Marketplace or install the `.vsix` file directly.

## Contributing

Issues and pull requests welcome on GitHub.

### Known Issues & Future Work

#### Known Issues
- **Terminal state persistence**: When the Claude Pilot view is closed and reopened, the terminal appears blank until user interaction (though the underlying PTY session persists). A visual redraw mechanism is needed to restore the display state.
- **Cursor positioning**: Cursor may appear offset from correct position after resizing terminal. Force resize to redraw fixes it temporarily.

#### Planned Features
- **Drag & Drop Tab Reordering**: Allow users to reorder terminal tabs by dragging them to new positions
- **Customizable Tab Titles**: Template-based tab titles with tokens for process names, directories, and timestamps
- **Vertical Tab Layout**: Option for vertical tab arrangement in wide panels
- **Enhanced Process Detection**: Better integration with shell processes for dynamic tab labeling

## Release Notes

### v0.2.0

#### New Features
- **Drag & Drop Support**: Drop files directly into the terminal - all file types are handled automatically
- **Clickable Links**: URLs and file paths are now clickable - file paths open directly in VS Code editor
- **Version Display**: Shows current extension version in terminal corner

#### Performance & Reliability Improvements  
- **WebGL Rendering**: Hardware-accelerated terminal rendering for better performance
- **Better Theme Integration**: Improved background color matching with VS Code themes

#### Under the Hood
- Modular architecture with separate PTY manager and template utilities
- Comprehensive test suite (16 automated tests)
- Enhanced event handling for better VS Code compatibility

### v0.1.0

Initial release with core functionality:
- Moveable terminal view
- Session persistence
- Activity Bar integration
