# Next Up

## Wishlist: Native macOS "Look Up" / Dictionary

xterm renders to canvas/WebGL, so macOS text services (three-finger tap, Ctrl+Cmd+D, native context menu "Look Up") can't see the text. To get this working we'd need to:

- Build a custom right-click context menu in the webview
- Extract the selected (or hovered) word from xterm
- Send it to the extension host, which would shell out: `open "dict://<word>"`

Not trivial. Filed for later.

## 1. Inherit VS Code built-in terminal settings

Design Alterminal's settings so that it reads and honors all of VS Code's built-in `terminal.integrated.*` settings by default, then lets users override specific behaviors under `alterminal.*`.

### Approach
- For every relevant `terminal.integrated.*` setting, Alterminal should read the VS Code value as the default
- Only when a user explicitly sets the corresponding `alterminal.*` setting does it override
- This way 99.99% of users get their existing terminal config "for free" in Alterminal

### Implementation pattern
```typescript
function getSetting<T>(key: string, fallback: T): T {
  const alterminalValue = vscode.workspace.getConfiguration('alterminal').get<T>(key);
  if (alterminalValue !== undefined) return alterminalValue;
  return vscode.workspace.getConfiguration('terminal.integrated').get<T>(key, fallback);
}
```

### Task
- Audit all `terminal.integrated.*` settings that VS Code ships (fonts, cursor, scrollback, shell, env, profiles, etc.)
- Identify which ones are applicable to Alterminal
- Wire up the cascading read (alterminal → terminal.integrated → default)
- Document in README which built-in settings are honored

## 2. Configurable `${remote}` labels

Shipped `${remote}` resolves to a single uppercase token (`LOCAL`, `SSH`, `WSL`, `TUNNEL`, ...). Users want to customize per-type rendering: hide for local, show `[hostname]` for tunnel/SSH, etc.

### Setting
```jsonc
"alterminal.remoteLabels": {
  "local":         "",                  // hide entirely when local
  "ssh":           "[{hostname}] ",
  "tunnel":        "[tunnel:{hostname}] ",
  "wsl":           "[WSL] ",
  "codespaces":    "[CS] ",
  "dev-container": "[DEV] ",
  "default":       "[{type}] "          // fallback for unknown types
}
```

### Resolution
1. Determine remote type from `vscode.env.remoteName` (or `"local"` if undefined).
2. Look up format string: exact type match → `"default"` → built-in fallback.
3. Substitute tokens, set the result on the `${remote}` context key.

### Tokens
- `{type}` — uppercased `remoteName` with trailing `-remote` stripped (`SSH`, `WSL`, `LOCAL`)
- `{hostname}` — parsed from `vscode.env.remoteAuthority` (for `ssh-remote+devbox` → `devbox`). For WSL it's the distro name, for tunnel it's the tunnel name.
- `{authority}` — verbatim `vscode.env.remoteAuthority` (or empty when local)

### Open design questions
- `{hostname}` vs `{target}` vs `{name}` — "hostname" is accurate for SSH and tunnel, sloppy for WSL/dev-container. "target" is neutral. Decide before implementing.
- Authority parsing: split on first `+`, right side is the target. Probably fine for all known remote types. Verify against VS Code source before shipping.
- Event wiring: `remoteName` and `remoteAuthority` don't change during a window's lifetime, so one computation at activate() is enough. Only re-compute if the user changes `alterminal.remoteLabels`.

### Blocked by
Nothing, but queue behind #1 (inheritance work) to avoid merge churn in the config/settings surface.
