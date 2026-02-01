<img src="https://github.com/TwilightCoders/vscode-alterminal/raw/main/media/icon.png" alt="Alterminal Icon" width="200" height="200" style="float: right; margin-left: 20px;">

# Alterminal
Advanced multi-session terminal interface for VS Code with command automation, template-based tab titles, and persistent tab state. Designed as a focused alternative UX to the built-in terminal while remaining lightweight.

## Features

- **Tab state persistence**: Alterminal remembers your exact tab setup - which tabs existed, their names, what was active, and the visual buffer content.

- **Saved commands**: Save `npm run dev`, `docker-compose up`, or any command you run constantly. Launch with one click instead of searching history or retyping.

- **Template-based tab titles**: Automatically show what's running (e.g., "Terminal • node" or "Build • npm"). Customize the format or set custom names that stick.

A focused alternative for developers who run the same commands repeatedly and want their terminal setup to persist exactly as they left it.

## Usage

1. **Access Alterminal**: Click the terminal icon in the Activity Bar or use the Command Palette (`Ctrl+Shift+P` → "Show Alterminal")
2. **Position Anywhere**: Drag the panel to your preferred location - sidebar, secondary sidebar, or bottom panel
3. **Create Terminals**: Use the toolbar buttons to create new terminals or launch saved commands
4. **Save Commands**: Click the save button on any tab to save frequently used commands for quick access
5. **Drag & Drop**: Drop files directly into terminals - they'll be automatically handled based on file type

## Requirements

- VS Code 1.74.0 or higher
- No additional dependencies - Alterminal works with your system's default shell and any installed tools

## Installation

Install from the VS Code Marketplace (search for "Alterminal"). For manual install: download a release `.vsix` and use the VS Code command: Extensions: Install from VSIX....

## Contributing

Issues and pull requests welcome on GitHub.

### Planned Features

- **Tab Icons & Menus**: Customizable icons for different terminal types with dropdown menus for save/settings/close actions
- **Drag & Drop Tab Reordering**: Allow users to reorder terminal tabs by dragging them to new positions

