import * as vscode from "vscode";
import { Logger } from "../utils/logger";

/**
 * Settings Editor — custom webview panel for Alterminal configuration.
 *
 * Built to handle what VS Code's built-in Settings UI can't: showing
 * inherited values. Each inherited setting displays its effective
 * resolved value from `terminal.integrated.*` with a clear visual
 * distinction between "explicitly overridden" and "inheriting".
 */

interface SettingDescriptor {
  key: string;                // alterminal setting key (relative to alterminal.)
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  enumValues?: string[];
  inheritsFrom?: string;      // terminal.integrated.<key>, if this is an inherited setting
  description?: string;
}

interface SettingValue {
  key: string;
  explicit: unknown | null;   // user-set value (globalValue/workspaceValue), or null if unset
  effective: unknown;          // what the extension actually uses right now
  inheritedFrom?: string;
  inheritedValue?: unknown;
}

// Groupings mirror the package.json configuration sections.
const SETTINGS: Array<{ title: string; items: SettingDescriptor[] }> = [
  {
    title: "Alterminal",
    items: [
      { key: "ptyDaemon.enabled", label: "PTY daemon (experimental)", type: "boolean",
        description: "Keep terminal processes alive across window reloads. PTY processes are managed by a background daemon that persists independently of the VS Code extension host." },
      { key: "alwaysShowTabs", label: "Always show tabs", type: "boolean",
        description: "Always show the tab bar, even when there is only one terminal tab." },
      { key: "tabLayout", label: "Tab layout", type: "enum", enumValues: ["auto", "horizontal", "vertical"],
        description: "Tab bar orientation. 'Auto' switches between horizontal and vertical based on panel size." },
      { key: "clearSelectionOnCopy", label: "Clear selection on copy", type: "boolean",
        description: "Clear the text selection after copying to the clipboard. Disable to keep text selected after Cmd/Ctrl+C." },
      { key: "bellIndicator", label: "Bell indicator (window title)", type: "string",
        description: "Text shown in the window title when a background terminal has unread bell activity. Add ${bell} to your window.title to enable. Leave empty to disable." },
    ],
  },
  {
    title: "Terminal Appearance (inherits from terminal.integrated.*)",
    items: [
      { key: "terminal.scrollback", label: "Scrollback lines", type: "number", inheritsFrom: "scrollback",
        description: "Number of lines to keep in the scrollback buffer. Higher values use more memory but preserve more history." },
      { key: "fontFamily", label: "Font family", type: "string", inheritsFrom: "fontFamily",
        description: "CSS font-family stack. Supports multiple fallbacks: \"Fira Code, Menlo, monospace\"." },
      { key: "fontSize", label: "Font size", type: "number", inheritsFrom: "fontSize",
        description: "Font size in pixels." },
      { key: "fontWeight", label: "Font weight", type: "enum",
        enumValues: ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"],
        inheritsFrom: "fontWeight",
        description: "Font weight for regular (non-bold) text." },
      { key: "fontWeightBold", label: "Font weight (bold)", type: "enum",
        enumValues: ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"],
        inheritsFrom: "fontWeightBold",
        description: "Font weight for bold text." },
      { key: "lineHeight", label: "Line height", type: "number", inheritsFrom: "lineHeight",
        description: "Line height as a multiplier of font size. 1.0 is exact; 1.2 gives each line 20% more vertical space." },
      { key: "letterSpacing", label: "Letter spacing", type: "number", inheritsFrom: "letterSpacing",
        description: "Extra horizontal space between characters in pixels. 0 is default." },
      { key: "lineSpacing", label: "Line spacing", type: "number",
        description: "Extra space between lines in pixels, added below each line without changing the line height (cursor/selection keep their size). Distinct from line height, which is a font-size multiplier. Requires the WebGPU renderer." },
      { key: "cursorStyle", label: "Cursor style", type: "enum",
        enumValues: ["block", "line", "underline"], inheritsFrom: "cursorStyle",
        description: "Cursor shape: solid block, vertical line, or underline." },
      { key: "cursorBlinking", label: "Cursor blinking", type: "boolean", inheritsFrom: "cursorBlinking",
        description: "Blink the cursor. Disable if you find it distracting." },
      { key: "copyOnSelection", label: "Copy on selection", type: "boolean", inheritsFrom: "copyOnSelection",
        description: "Automatically copy to the clipboard when you select text — no Cmd/Ctrl+C needed." },
      { key: "smoothScrolling", label: "Smooth scrolling", type: "boolean", inheritsFrom: "smoothScrolling",
        description: "Animate scroll movements with interpolation instead of jumping." },
      { key: "minimumContrastRatio", label: "Minimum contrast ratio", type: "number", inheritsFrom: "minimumContrastRatio",
        description: "Minimum WCAG contrast ratio between text and background. Colors are adjusted when a combination falls below this threshold. 1 = no adjustment, 4.5 = WCAG AA." },
      { key: "wordSeparators", label: "Word separators", type: "string", inheritsFrom: "wordSeparators",
        description: "Characters that divide words for double-click selection. Whitespace is always a separator." },
    ],
  },
];

export class SettingsEditor {
  private _panel: vscode.WebviewPanel | null = null;
  private _disposables: vscode.Disposable[] = [];

  constructor() {}

  public open(): void {
    if (this._panel) {
      this._panel.reveal();
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      "alterminalSettings",
      "Alterminal Settings",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this._panel.webview.html = this._html();
    this._pushState();

    this._panel.webview.onDidReceiveMessage((msg) => this._handleMessage(msg), null, this._disposables);
    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);

    // Live updates when underlying settings change
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("alterminal") || e.affectsConfiguration("terminal.integrated")) {
        this._pushState();
      }
    }, null, this._disposables);
  }

  private _handleMessage(msg: any): void {
    switch (msg?.command) {
      case "ready":
        this._pushState();
        return;
      case "update":
        this._updateSetting(msg.key, msg.value).catch((err) => Logger.error("settings update", err));
        return;
      case "reset":
        this._updateSetting(msg.key, undefined).catch((err) => Logger.error("settings reset", err));
        return;
      case "openJson":
        vscode.commands.executeCommand("workbench.action.openSettingsJson");
        return;
      case "openSetting":
        if (typeof msg.key === "string") {
          vscode.commands.executeCommand("workbench.action.openSettings", msg.key);
        }
        return;
    }
  }

  private async _updateSetting(key: string, value: unknown): Promise<void> {
    const config = vscode.workspace.getConfiguration("alterminal");
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await config.update(key, value, target);
  }

  private _pushState(): void {
    if (!this._panel) return;
    const groups = SETTINGS.map((group) => ({
      title: group.title,
      items: group.items.map((item) => this._resolveValue(item)),
    }));
    this._panel.webview.postMessage({ command: "state", groups });
  }

  private _resolveValue(item: SettingDescriptor): SettingDescriptor & SettingValue {
    const aConfig = vscode.workspace.getConfiguration("alterminal");
    const inspect = aConfig.inspect(item.key);

    const explicitlySet =
      inspect !== undefined &&
      (inspect.globalValue !== undefined ||
        inspect.workspaceValue !== undefined ||
        inspect.workspaceFolderValue !== undefined);

    const explicit = explicitlySet
      ? (inspect.workspaceFolderValue ?? inspect.workspaceValue ?? inspect.globalValue)
      : null;

    let inheritedValue: unknown | undefined;
    let inheritedFrom: string | undefined;
    if (item.inheritsFrom) {
      const tConfig = vscode.workspace.getConfiguration("terminal.integrated");
      inheritedValue = tConfig.get(item.inheritsFrom);
      inheritedFrom = `terminal.integrated.${item.inheritsFrom}`;
    } else {
      // Alterminal-only setting: the manifest default fills in when unset
      inheritedValue = inspect?.defaultValue;
    }

    const effective = explicit ?? inheritedValue;

    return {
      ...item,
      explicit,
      effective,
      inheritedFrom,
      inheritedValue,
    };
  }

  private _html(): string {
    const nonce = Math.random().toString(36).slice(2);
    // All styling uses VS Code CSS variables so we match the current theme.
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 1.5rem 2rem;
      margin: 0 auto;
      max-width: 1100px;
      box-sizing: border-box;
    }
    h1 {
      font-size: 1.4em;
      font-weight: 600;
      margin: 0 0 0.25em 0;
    }
    .subtle { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .toolbar { margin: 0 0 1.5em 0; display: flex; gap: 0.5em; }
    button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-border, transparent);
      padding: 4px 10px;
      cursor: pointer;
      font: inherit;
      border-radius: 2px;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    h2 {
      font-size: 1.1em;
      font-weight: 600;
      margin: 1.5em 0 0.75em 0;
      padding-bottom: 0.25em;
      border-bottom: 1px solid var(--vscode-settings-headerBorder, var(--vscode-panel-border));
    }
    .setting {
      display: grid;
      grid-template-columns: minmax(180px, 1.1fr) minmax(260px, 1.5fr) minmax(240px, 1.4fr);
      gap: 1.25em;
      padding: 0.9em 0;
      border-bottom: 1px solid var(--vscode-panel-border);
      align-items: start;
    }
    @media (max-width: 760px) {
      .setting {
        grid-template-columns: 1fr;
      }
    }
    .description {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      line-height: 1.45;
    }
    .setting:last-child { border-bottom: none; }
    .label { font-weight: 500; }
    .key { font-family: var(--vscode-editor-font-family); font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    .control { display: flex; align-items: center; gap: 0.5em; flex-wrap: wrap; }
    input[type="text"], input[type="number"], select {
      background: var(--vscode-settings-textInputBackground, var(--vscode-input-background));
      color: var(--vscode-settings-textInputForeground, var(--vscode-input-foreground));
      border: 1px solid var(--vscode-settings-textInputBorder, var(--vscode-input-border, transparent));
      padding: 4px 8px;
      font: inherit;
      border-radius: 2px;
      min-width: 180px;
    }
    input[type="checkbox"] { margin: 0; }
    .effective {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-top: 0.25em;
    }
    .effective code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 2px;
    }
    a.setting-link {
      color: var(--vscode-textLink-foreground);
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 2px;
      text-decoration: none;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      cursor: pointer;
      font-weight: normal;
    }
    a.setting-link:hover {
      text-decoration: underline;
      color: var(--vscode-textLink-activeForeground);
    }
    .badge {
      display: inline-block;
      font-size: 0.75em;
      padding: 1px 6px;
      border-radius: 2px;
      margin-left: 0.5em;
    }
    .badge.overridden {
      background: var(--vscode-statusBarItem-warningBackground, #b38600);
      color: var(--vscode-statusBarItem-warningForeground, white);
    }
    .badge.inherited {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      opacity: 0.7;
    }
    .reset {
      background: transparent;
      color: var(--vscode-textLink-foreground);
      border: none;
      padding: 2px 4px;
      font-size: 0.85em;
    }
    .reset:hover { text-decoration: underline; background: transparent; }
  </style>
</head>
<body>
  <h1>Alterminal Settings</h1>
  <p class="subtle">Values shown live-update. Leave a field empty to inherit.</p>
  <div class="toolbar">
    <button id="openJson">Edit settings.json</button>
  </div>
  <div id="content"><em class="subtle">Loading…</em></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const el = document.getElementById("content");
    let state = { groups: [] };

    function fmt(v) {
      if (v === undefined || v === null) return '<span class="subtle">(unset)</span>';
      if (typeof v === "boolean") return v ? "true" : "false";
      if (typeof v === "string") return v === "" ? '<span class="subtle">(empty)</span>' : '"' + escape(v) + '"';
      return String(v);
    }
    function escape(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

    function render() {
      el.innerHTML = state.groups.map(group => \`
        <h2>\${linkifySettingRefs(group.title)}</h2>
        \${group.items.map(renderItem).join("")}
      \`).join("");
      wireInputs();
    }

    // Replace terminal.integrated references in prose with clickable links
    // that open the VS Code Settings UI filtered to them. Strips a trailing
    // ".*" since VS Code's settings search matches by prefix, not glob.
    function linkifySettingRefs(text) {
      return escape(text).replace(/terminal\\.integrated(?:\\.(?:\\*|[a-zA-Z][\\w.]*))?/g, (match) => {
        const key = match.endsWith('.*') ? match.slice(0, -2) : match;
        return '<a class="setting-link" href="#" data-openset="' + escape(key) + '">' + match + '</a>';
      });
    }

    function renderItem(item) {
      const isOverridden = item.explicit !== null && item.explicit !== undefined;
      const badge = isOverridden
        ? '<span class="badge overridden">overridden</span>'
        : item.inheritsFrom
          ? '<span class="badge inherited">inherited</span>'
          : '';
      const reset = isOverridden
        ? \`<button class="reset" data-reset="\${escape(item.key)}">Reset to inherited</button>\`
        : '';
      const inheritLink = item.inheritedFrom
        ? \`<a class="setting-link" href="#" data-openset="\${escape(item.inheritedFrom)}">\${escape(item.inheritedFrom)}</a>\`
        : '';
      const effectiveLine = item.inheritsFrom
        ? \`<div class="effective">effective: <code>\${fmt(item.effective)}</code>\${
            isOverridden
              ? \` · inherited would be <code>\${fmt(item.inheritedValue)}</code> from \${inheritLink}\`
              : \` · from \${inheritLink}\`
          }</div>\`
        : \`<div class="effective">effective: <code>\${fmt(item.effective)}</code></div>\`;

      const description = item.description
        ? \`<div class="description">\${escape(item.description)}</div>\`
        : '';
      return \`
        <div class="setting">
          <div>
            <div class="label">\${escape(item.label)}\${badge}</div>
            <div class="key">alterminal.\${escape(item.key)}</div>
          </div>
          <div>
            <div class="control">\${renderControl(item)}\${reset}</div>
            \${effectiveLine}
          </div>
          \${description}
        </div>
      \`;
    }

    function renderControl(item) {
      const v = item.explicit ?? '';
      const placeholder = item.inheritsFrom && item.inheritedValue !== undefined
        ? 'inherit: ' + formatForInput(item.inheritedValue)
        : '';
      switch (item.type) {
        case "boolean": {
          const checked = item.explicit === true ? "checked" : "";
          const ind = (item.explicit === null || item.explicit === undefined) ? "indeterminate" : "";
          return \`<input type="checkbox" data-key="\${escape(item.key)}" data-type="boolean" \${checked} data-ind="\${ind}">
                  <span class="subtle">\${item.explicit === null || item.explicit === undefined ? 'inherited' : ''}</span>\`;
        }
        case "number":
          return \`<input type="number" data-key="\${escape(item.key)}" data-type="number" value="\${v}" placeholder="\${escape(placeholder)}">\`;
        case "enum":
          return \`<select data-key="\${escape(item.key)}" data-type="enum">
            <option value="">\${escape(placeholder || '(inherit)')}</option>
            \${item.enumValues.map(e => \`<option value="\${escape(e)}" \${item.explicit === e ? "selected" : ""}>\${escape(e)}</option>\`).join("")}
          </select>\`;
        case "string":
        default:
          return \`<input type="text" data-key="\${escape(item.key)}" data-type="string" value="\${escape(v)}" placeholder="\${escape(placeholder)}">\`;
      }
    }

    function formatForInput(v) {
      if (v === undefined || v === null) return '';
      if (typeof v === "string") return v;
      return String(v);
    }

    function wireInputs() {
      // Indeterminate state for checkboxes
      document.querySelectorAll('input[type="checkbox"][data-ind="indeterminate"]').forEach(el => el.indeterminate = true);

      document.querySelectorAll('[data-key]').forEach(el => {
        const key = el.dataset.key;
        const type = el.dataset.type;
        const evt = type === 'boolean' || type === 'enum' ? 'change' : 'change';
        el.addEventListener(evt, () => {
          let value;
          if (type === 'boolean') {
            value = el.checked;
          } else if (type === 'number') {
            value = el.value === '' ? undefined : Number(el.value);
          } else if (type === 'enum') {
            value = el.value === '' ? undefined : el.value;
          } else {
            value = el.value === '' ? undefined : el.value;
          }
          if (value === undefined) {
            vscode.postMessage({ command: 'reset', key });
          } else {
            vscode.postMessage({ command: 'update', key, value });
          }
        });
      });

      document.querySelectorAll('[data-reset]').forEach(el => {
        el.addEventListener('click', () => {
          vscode.postMessage({ command: 'reset', key: el.dataset.reset });
        });
      });

      document.getElementById('openJson').addEventListener('click', () => {
        vscode.postMessage({ command: 'openJson' });
      });

      document.querySelectorAll('[data-openset]').forEach(el => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ command: 'openSetting', key: el.dataset.openset });
        });
      });
    }

    window.addEventListener('message', (ev) => {
      if (ev.data && ev.data.command === 'state') {
        state = ev.data;
        render();
      }
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }

  private _dispose(): void {
    this._panel = null;
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
  }
}
