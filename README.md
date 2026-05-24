<img src="https://github.com/TwilightCoders/vscode-alterminal/raw/main/media/icon.png" alt="Alterminal Icon" width="200" height="200" style="float: right; margin-left: 20px;">

# Alterminal
Feature-rich terminal alternative for VS Code - use standalone or alongside the built-in terminal. Persistent tabs, clickable file paths, command automation, and more.

## Features

- **Clickable file paths and URLs**: Command/Ctrl+click any file path or URL in terminal output to open files in the editor, reveal directories in the explorer, or open links in your browser.

- **Tab state persistence**: Alterminal remembers your exact tab setup - which tabs existed, their names, what was active, and the visual buffer content.

- **Drag & drop tab reordering**: Easily reorganize your terminal tabs by dragging them to new positions - your preferred order persists across sessions.

- **Saved commands**: Save `npm run dev`, `docker-compose up`, or any command you run constantly. Launch with one click instead of searching history or retyping.

- **Template-based tab titles**: Automatically show what's running (e.g., "Terminal • node" or "Build • npm"). Customize the format or set custom names that stick.

- **Tab icon customization**: Right-click any tab to set a custom icon (server, database, rocket, etc.) that persists across sessions.

- **Buffer inspection**: Right-click any tab to view its raw terminal content in an editor - useful for debugging or copying output.

- **Activity & bell indicators**: Background tabs show a subtle dot when they produce output, and a swinging bell when something needs your attention (a terminal bell, or an agent finishing its turn). Tabs that ring bells stop flashing the dot for routine output, so spinners and progress chatter don't nag you.

- **Cross-window notifications**: When a terminal in another window finishes — including Claude Code completing a turn — a toast appears on whichever window you're currently working in, with an **Open Project** button to jump straight to it. You're notified about the projects you're *not* looking at, never the one you are.

- **Find in terminal**: `Cmd+F` / `Ctrl+F` opens a search bar over the active terminal with next/previous navigation and a match count.

- **Drag-drop images into agents**: Drop an image onto a tab running Claude Code and it's attached as an actual image (`[Image #N]`), not a path that expires.

A focused alternative for developers who run the same commands repeatedly and want their terminal setup to persist exactly as they left it.

## Usage

1. **Access Alterminal**: Click the terminal icon in the Activity Bar or use the Command Palette (`Ctrl+Shift+P` → "Show Alterminal")
2. **Position Anywhere**: Drag the panel to your preferred location - sidebar, secondary sidebar, or bottom panel
3. **Create Terminals**: Use the toolbar buttons to create new terminals or launch saved commands
4. **Save Commands**: Click the save button on any tab to save frequently used commands for quick access
5. **Customize Tabs**: Right-click any tab to rename, set a custom icon, view its buffer, or close it (or click the `×`)
6. **Drag & Drop**: Drop files directly into terminals or reorder tabs by dragging them
7. **Search**: Press `Cmd+F` / `Ctrl+F` to find text in the active terminal

## Claude Code integration

Alterminal surfaces a bell — per-tab, in the window title (`${bell}`), and as a cross-window toast — when Claude Code finishes a turn and is waiting for your input. Claude only emits that signal if you opt in, because it's off for unrecognized terminals by default. Add to `~/.claude/settings.json`:

```jsonc
{
  "preferredNotifChannel": "iterm2",     // or "kitty" / "ghostty" — Alterminal detects all three
  "inputNeededNotifEnabled": true
}
```

Then restart your Claude Code session (it reads settings at launch). Without these, Claude stays silent in `auto` mode and no end-of-turn bell fires. Dropping an image onto a Claude tab attaches it directly — no extra setup.

To see the title bell, add `${bell}` to your VS Code `window.title` setting (and `${remote}` for an `SSH`/`WSL`/`LOCAL` label).

## Requirements

- VS Code 1.108.0 or higher
- macOS or Linux. No additional dependencies — Alterminal works with your system's default shell and any installed tools.

## Installation

Install from the VS Code Marketplace (search for "Alterminal"). For manual install: download a release `.vsix` and use the VS Code command: Extensions: Install from VSIX....

## Contributing

Issues and pull requests welcome on GitHub.

