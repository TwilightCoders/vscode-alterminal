# Next Up

## Known Issue: yellow glyph artifacts (WebGL atlas)

**Symptom:** occasional yellow-tinted *fragments* land on individual glyphs of
**plain, uncolored** text in Alterminal tabs (e.g. the `0`s in `0.2.0`, the `a`
in `default`, the `q` in `question`). The letters are in the right places —
they're just mis-*painted* yellow.

**Localized to the renderer (not content, not the daemon, not Claude Code):**
- The affected text was plain ASCII with **no color escapes** — so the yellow is
  not in the byte stream.
- The **same** Claude Code / ClaudePilot sessions rendered in **Terminal.app**
  (native renderer) show **zero** artifacts → rules out loompty (transport) and
  Claude Code (the bytes are correct).
- Only Alterminal's **xterm `@xterm/addon-webgl`** renderer exhibits it.

**Hypothesis:** glyph-atlas corruption in `addon-webgl`. Under heavy churn the
texture atlas fills and **evicts**, and a cell can end up sampling a region that
holds another entry's pixels — yellow, when a yellow glyph occupies the bled
region. (This is a known *class* of addon-webgl bug.)

**Trigger is Claude Code's Ink renderer.** Ink does relentless in-place repaints
(cursor-home, erase-line, redraw) with a huge variety of styled glyphs (spinner
frames, syntax-highlighted diffs, colored status). That churns/overflows the
atlas far harder than ordinary output, so the artifact is **accumulative** and
emerges only over sustained Claude-heavy sessions. Frequency scales with how
colorful the in-terminal workload is, **not** with the daemon.

**Ruled out:** a static "colored-text-then-plain-text" repro (80 rows cycling
colors, incl. heavy yellow, interleaved with plain copies) did **not** reproduce
on WebGL — so it is *not* simple color-cache reuse; it needs real atlas
eviction/churn, which static output doesn't cause.

**Workaround (shipped this session):** `alterminal.renderer: "dom"` switches to
xterm's built-in DOM renderer, which has **no glyph atlas**. Dale is soak-testing
on `dom` (if the yellow never recurs across normal Claude-heavy days where WebGL
showed it regularly → confirmed atlas bug).

**Fix options, cheapest first (try before the WebGPU rewrite):**
1. Bump `@xterm/addon-webgl` — atlas/eviction bugs have been fixed across versions.
2. Periodic `clearTextureAtlas()` under heavy churn (the addon exposes it).
3. WebGPU shared-device renderer (the big plan) — correctly-keyed atlas + real
   per-cell color resolution kills this whole class.
   - ⚠️ **Revisit the plan's premise:** a fresh-restart A/B (2026-05-24) showed the
     `Code Helper (GPU)` process is ~flat between webgl/dom (**147 vs 178 MB**),
     *not* the multi-GB hog the plan assumes. WebGL's cost is ~**64 MB/renderer**
     (spread across webview processes), not a giant central GPU process — likely
     the "2.5 GB GPU process" was an accumulated-uptime artifact. The memory win
     from WebGPU is per-renderer (shared device), not "shrink the GPU process."

**Note:** `@xterm/addon-canvas` is **not** an option — it stalled at peer
`@xterm/xterm: ^5.0.0` (latest 0.7.0) and we're on xterm 6; and it shares the same
atlas as WebGL anyway, so it wouldn't dodge the bug.

**Diagnostics available:** `alterminal.renderer` (`webgl`|`dom`) for A/B.

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
