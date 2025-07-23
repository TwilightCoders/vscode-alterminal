# Planned Features

## Default Tab Groups Configuration

### Overview
Allow users to configure default tab groups that automatically open when VS Code starts or when a project/workspace is opened. This feature would provide project-specific terminal setups and consistent development environments across team members.

### Technical Feasibility
✅ **Fully Doable** - VS Code provides all necessary APIs:
- `vscode.workspace.onDidChangeWorkspaceFolders` - Workspace change events
- `vscode.window.onDidChangeActiveTextEditor` - Editor state changes
- `vscode.workspace.getConfiguration()` - Settings management
- Extension activation events (`onStartupFinished`, `onDidChangeWorkspaceFolders`)
- Persistent storage via `vscode.ExtensionContext.workspaceState` and `globalState`

### Configuration Levels

#### 1. User-Level Defaults (Global)
```json
{
  "claudePilot.defaultTabGroups.global": {
    "autoCreate": true,
    "tabs": [
      {
        "name": "Main Terminal",
        "command": null,
        "cwd": "${workspaceFolder}"
      },
      {
        "name": "Development Server",
        "command": "npm run dev",
        "cwd": "${workspaceFolder}",
        "autoRun": false
      }
    ]
  }
}
```

#### 2. Workspace-Level Configuration
```json
// .vscode/settings.json
{
  "claudePilot.defaultTabGroups.workspace": {
    "autoCreate": true,
    "tabs": [
      {
        "name": "API Server",
        "command": "npm run start:api",
        "cwd": "${workspaceFolder}/backend",
        "autoRun": true
      },
      {
        "name": "Frontend Dev",
        "command": "npm run dev",
        "cwd": "${workspaceFolder}/frontend",
        "autoRun": true
      },
      {
        "name": "Database",
        "command": "docker-compose up postgres",
        "cwd": "${workspaceFolder}",
        "autoRun": false
      }
    ]
  }
}
```

#### 3. Project-Level Templates (`.claudepilot/tabs.json`)
```json
{
  "version": "1.0",
  "name": "Full Stack Development",
  "description": "Complete development environment setup",
  "autoCreate": true,
  "tabs": [
    {
      "name": "Build Watcher",
      "command": "npm run build:watch",
      "cwd": "${workspaceFolder}",
      "autoRun": true,
      "environmentVariables": {
        "NODE_ENV": "development"
      }
    },
    {
      "name": "Test Runner",
      "command": "npm run test:watch",
      "cwd": "${workspaceFolder}",
      "autoRun": false
    },
    {
      "name": "Git Operations",
      "command": null,
      "cwd": "${workspaceFolder}"
    }
  ],
  "dependencies": [
    "node",
    "npm",
    "docker"
  ]
}
```

### Implementation Architecture

#### Core Components

1. **ConfigurationManager** (`src/config/tabGroupManager.ts`)
   ```typescript
   export class TabGroupConfigManager {
     async loadConfiguration(): Promise<TabGroupConfig>
     async saveConfiguration(config: TabGroupConfig): Promise<void>
     resolveConfiguration(): TabGroupConfig // Merge global + workspace + project
     validateConfiguration(config: TabGroupConfig): ValidationResult
   }
   ```

2. **Template System** (`src/templates/tabGroupTemplates.ts`)
   ```typescript
   export class TabGroupTemplateManager {
     async createFromTemplate(templateName: string): Promise<void>
     async saveAsTemplate(name: string, description: string): Promise<void>
     listAvailableTemplates(): TabGroupTemplate[]
     importTemplate(filePath: string): Promise<TabGroupTemplate>
   }
   ```

3. **Workspace Integration** (`src/workspace/workspaceManager.ts`)
   ```typescript
   export class WorkspaceTabManager {
     async onWorkspaceOpened(): Promise<void>
     async createDefaultTabs(): Promise<void>
     async detectProjectType(): Promise<ProjectType>
     resolveVariables(command: string, cwd: string): { command: string, cwd: string }
   }
   ```

#### Variable Resolution
Support for common VS Code variables:
- `${workspaceFolder}` - Root workspace directory
- `${workspaceFolderBasename}` - Workspace folder name
- `${file}` - Current file path
- `${relativeFile}` - Current file relative to workspace
- `${fileBasename}` - Current file name
- `${env:VARIABLE}` - Environment variables
- Custom variables: `${claudePilot:projectName}`

### User Experience Features

#### VS Code Command Palette Integration
```
> Claude Pilot: Configure Default Tab Groups
> Claude Pilot: Save Current Tabs as Template
> Claude Pilot: Load Tab Group Template
> Claude Pilot: Reset to Default Tab Groups
> Claude Pilot: Import Tab Group Configuration
```

#### Settings UI Integration
- Contribute to VS Code settings editor with custom UI
- Visual tab group editor with drag-drop reordering
- Command picker with autocomplete
- Live preview of resolved variables

#### Automatic Project Detection
Smart defaults based on project structure:
```typescript
const projectDetectors = {
  'node': () => fs.existsSync('package.json'),
  'python': () => fs.existsSync('requirements.txt') || fs.existsSync('pyproject.toml'),
  'rust': () => fs.existsSync('Cargo.toml'),
  'go': () => fs.existsSync('go.mod'),
  'docker': () => fs.existsSync('Dockerfile') || fs.existsSync('docker-compose.yml')
};
```

### Configuration Schema

```typescript
interface TabGroupConfig {
  version: string;
  name?: string;
  description?: string;
  autoCreate: boolean;
  activationEvents?: string[]; // When to trigger auto-creation
  tabs: TabConfiguration[];
  dependencies?: string[]; // Required tools/commands
  environmentVariables?: Record<string, string>;
}

interface TabConfiguration {
  name: string;
  command?: string | null;
  cwd: string;
  autoRun: boolean;
  delay?: number; // Delay before auto-running (ms)
  environmentVariables?: Record<string, string>;
  shell?: string; // Override default shell
  icon?: string; // Tab icon
  color?: string; // Tab color theme
}
```

### Implementation Phases

#### Phase 1: Core Infrastructure
- Basic configuration loading and saving
- Variable resolution system
- Workspace event integration
- Simple tab group creation

#### Phase 2: Template System
- Template creation and management
- Import/export functionality
- Project type detection
- Built-in templates for common frameworks

#### Phase 3: Advanced Features
- Settings UI integration
- Command palette commands
- Dependency checking
- Advanced variable resolution

#### Phase 4: Team Collaboration
- Shared template repositories
- Team-wide configuration sync
- Configuration validation and linting
- Documentation generation

### Technical Implementation Details

#### Extension Activation
```typescript
// src/extension.ts
export async function activate(context: vscode.ExtensionContext) {
  const workspaceManager = new WorkspaceTabManager(context);
  
  // Auto-create tabs on workspace open
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(
      () => workspaceManager.onWorkspaceOpened()
    )
  );
  
  // Auto-create on extension startup if workspace already open
  if (vscode.workspace.workspaceFolders?.length) {
    await workspaceManager.onWorkspaceOpened();
  }
}
```

#### Configuration Resolution Priority
1. Project-level (`.claudepilot/tabs.json`) - Highest priority
2. Workspace-level (`.vscode/settings.json`)
3. User-level (VS Code settings) - Lowest priority

#### Persistence Strategy
- User settings: VS Code user settings
- Workspace settings: `.vscode/settings.json`
- Project templates: `.claudepilot/tabs.json` (version controlled)
- Runtime state: Extension workspace state

### Security Considerations

- **Command validation**: Whitelist/blacklist for auto-running commands
- **Path sanitization**: Prevent directory traversal attacks
- **User confirmation**: Prompt before running auto-run commands from untrusted sources
- **Environment isolation**: Sandbox for command execution

### Future Enhancements

- **Remote development support**: SSH/container-aware configurations
- **Integration with other extensions**: Detect and integrate with popular dev tools
- **Performance optimization**: Lazy loading and caching
- **Analytics and insights**: Track usage patterns for better defaults
- **AI-powered suggestions**: Smart tab group recommendations based on project analysis

This feature would significantly improve developer productivity by eliminating the manual setup of terminal environments for each project session.