# Tab Title Template System

## Overview

Allow users to customize how tab titles are displayed using a token-based template system similar to shell PS1 prompts.

## Template Tokens

### Process Information

- `{p}` - Process name (e.g., `node`, `python`, `git`)
- `{pid}` - Process ID
- `{cmd}` - Full command line (when available)

### Terminal Information

- `{n}` - Tab name/label (user-defined)
- `{id}` - Tab ID number
- `{cwd}` - Current working directory basename
- `{path}` - Full current working directory path

### Time Information

- `{time}` - Current time (HH:MM)
- `{date}` - Current date (MM/DD)
- `{timestamp}` - Unix timestamp

### Status Information

- `{status}` - Process status (running, idle, etc.)
- `{exit}` - Last exit code (when process exits)

### Conditional Formatting

- `{p?text}` - Show "text" only if process is running
- `{p:default}` - Show "default" if no process, otherwise show process name
- `{p?{p}:shell}` - Show process name if running, otherwise "shell"

## Example Templates

### Basic Templates

```
"{n}"                    → "Claude Session"
"{n} • {p}"             → "Claude Session • node"
"{p} [{id}]"            → "node [1]"
"{cwd} ~ {p}"           → "myproject ~ python"
```

### Advanced Templates

```
"{n}{p? • {p}}"         → "Terminal" or "Terminal • git"
"{cwd} {p?({p})}"       → "frontend" or "frontend (npm)"
"{n} [{p:idle}]"        → "Session [node]" or "Session [idle]"
"{time} | {n} • {p}"    → "14:30 | API • node"
```

### Project-Specific Templates

```
"{cwd}{p? ~ {p}}"       → "my-app" or "my-app ~ node"
"[{id}] {p:terminal}"   → "[1] node" or "[1] terminal"
"{n} {p?🟢:⚪} {p}"     → "Session 🟢 node" or "Session ⚪ bash"
```

## Configuration

### VS Code Settings

```json
{
  "claudePilot.tabTitle.template": "{n}{p? • {p}}",
  "claudePilot.tabTitle.updateInterval": 1000,
  "claudePilot.tabTitle.maxLength": 50,
  "claudePilot.tabTitle.truncateMode": "middle"
}
```

### Per-Workspace Configuration

```json
{
  "claudePilot.tabTitle.template": "{cwd} ~ {p:shell}",
  "claudePilot.tabTitle.workspaceTemplate": true
}
```

## Implementation Architecture

### Template Engine

```typescript
interface TemplateToken {
  key: string;
  getValue: (context: TabContext) => string | null;
  condition?: (context: TabContext) => boolean;
}

interface TabContext {
  tabId: number;
  tabName: string;
  processName?: string;
  processId?: number;
  fullCommand?: string;
  workingDirectory?: string;
  lastExitCode?: number;
  timestamp: Date;
}

class TabTitleTemplateEngine {
  private tokens: Map<string, TemplateToken> = new Map();

  constructor() {
    this.registerBuiltinTokens();
  }

  render(template: string, context: TabContext): string {
    return this.parseTemplate(template, context);
  }

  private parseTemplate(template: string, context: TabContext): string {
    // Parse {token} and {token?text} and {token:default} patterns
    return template.replace(/\\{([^}]+)\\}/g, (match, content) => {
      return this.resolveToken(content, context);
    });
  }

  private resolveToken(content: string, context: TabContext): string {
    // Handle conditional: {p?text} or {p?text:default}
    if (content.includes("?")) {
      return this.resolveConditional(content, context);
    }

    // Handle default: {p:default}
    if (content.includes(":")) {
      return this.resolveDefault(content, context);
    }

    // Simple token: {p}
    const token = this.tokens.get(content);
    return token?.getValue(context) || `{${content}}`;
  }
}
```

### Built-in Tokens

```typescript
private registerBuiltinTokens(): void {
  this.tokens.set('p', {
    key: 'p',
    getValue: (ctx) => ctx.processName || null
  });

  this.tokens.set('pid', {
    key: 'pid',
    getValue: (ctx) => ctx.processId?.toString() || null
  });

  this.tokens.set('n', {
    key: 'n',
    getValue: (ctx) => ctx.tabName
  });

  this.tokens.set('id', {
    key: 'id',
    getValue: (ctx) => ctx.tabId.toString()
  });

  this.tokens.set('cwd', {
    key: 'cwd',
    getValue: (ctx) => {
      if (!ctx.workingDirectory) return null;
      return path.basename(ctx.workingDirectory);
    }
  });

  this.tokens.set('time', {
    key: 'time',
    getValue: (ctx) => {
      return ctx.timestamp.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
      });
    }
  });
}
```

### Integration with TabManager

```typescript
class TabManager {
  private templateEngine = new TabTitleTemplateEngine();

  updateTabTitleFromTemplate(tabId: number): void {
    const terminal = this.terminals.get(tabId);
    if (!terminal) return;

    const template = this.getTabTemplate();
    const context: TabContext = {
      tabId,
      tabName: terminal.baseLabel || terminal.label.split(" •")[0],
      processName: this.getCurrentProcessName(tabId),
      processId: this.getCurrentProcessId(tabId),
      workingDirectory: this.getCurrentWorkingDirectory(tabId),
      timestamp: new Date(),
    };

    const newTitle = this.templateEngine.render(template, context);
    this.updateTabLabel(tabId, newTitle);
  }

  private getTabTemplate(): string {
    const config = vscode.getState() || {};
    return config.tabTitleTemplate || "{n}{p? • {p}}";
  }
}
```

## User Experience

### Configuration UI

- VS Code settings editor integration
- Live preview of template rendering
- Template validation and error messages
- Common template presets/examples

### Command Palette

```
> Claude Pilot: Set Tab Title Template
> Claude Pilot: Reset Tab Title Template
> Claude Pilot: Preview Tab Title Template
> Claude Pilot: Copy Current Tab Template
```

### Context Menu

- Right-click tab → "Configure Title Template"
- Right-click tab → "Use as Title Template" (copy current format)

## Benefits

1. **User Control**: Users define exactly what they want to see
2. **Flexibility**: Works with any process, command, or context
3. **Performance**: No expensive system calls needed
4. **Consistency**: Same template applies to all tabs
5. **Simplicity**: Much simpler than trying to parse/map every possible command

## Examples in Practice

```
Template: "{n} {p?🔧:💤}"
Results:
- "API Server 🔧" (when npm is running)
- "API Server 💤" (when at shell prompt)

Template: "{cwd}{p? ~ {p}}"
Results:
- "my-project ~ node"
- "my-project ~ python"
- "my-project" (when at shell)

Template: "[{id}] {p:terminal}"
Results:
- "[1] node"
- "[2] git"
- "[3] terminal" (when at shell)
```

This system gives users complete control over their terminal tab appearance while being much simpler to implement and maintain than trying to extract full command lines from every possible process type.
