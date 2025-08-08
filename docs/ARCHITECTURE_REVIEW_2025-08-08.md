# Architecture & Vision Review (2025-08-08)

This document captures the current state analysis, strategic direction, and performance remediation plan so we can iterate without losing context.

## 1. Current High-Level Architecture

| Layer | Description | Notes |
|-------|-------------|-------|
| Extension Host (TS) | `extension.ts`, `claudeCodeProvider.ts`, `ptyManager.ts`, utilities | Clean separation; PTY lifecycle managed host-side |
| Webview (JS) | `tabManager.js`, `terminal.js` monoliths + template HTML | Large, untyped, global state, performance concerns |
| State Persistence | Primary: `vscode.setState()` (webview); Backup: `workspaceState` | Dual system adds complexity; races possible |
| Link & File Cache | Workspace scan -> Set<string> sent to webview | Good approach, but no incremental diffing |
| PTY Processes | Map `tabId -> IPty`; polling for process name | Multiple intervals; could centralize |

## 2. Strengths
- Clear host/webview separation; PTY logic isolated.
- Recent simplification of path link detection (maintainable regex set).
- Thoughtful UX (bell indicators only when inactive, developer mode gating, debug filters).
- File cache saves synchronous FS lookups during link underline decisions.
- Journaling habit provides continuity & rationale.

## 3. Key Technical Debt / Risks
| Area | Issue | Impact | Priority |
|------|-------|--------|----------|
| Webview Code Size | ~2k LOC untyped JS | Hard to refactor safely | High |
| Rendering Blank On Refocus | Terminal not redrawn after visibility change | Critical UX risk / accidental command execution | Critical |
| Initialization Latency | Per-tab addon loading & debug instrumentation upfront | Slower perceived load | High |
| Multiple Regex Passes | One provider per pattern | Unnecessary CPU on render | Medium |
| Process Poll Timers | One interval per terminal | Scales poorly | Medium |
| Open File Security | Opens any resolved path unrestricted | Potential disclosure | Medium |
| Temp File Leakage | Dropped data persisted under /tmp without cleanup | Disk clutter / security | Medium |
| Dual State Sources | Webview vs backup workspace state | Race / duplication | Medium |
| Hardcoded Developer ID | Static GitHub account id | Fragile; not configurable | Low |

## 4. Addressing TS in Webview (Clarification)
You *can* use TypeScript for webview code. VS Code does not forbid TS—webviews simply receive final JS. Typical approach:
1. Create `webview-src/` with modular TS (e.g. `core/terminal.ts`, `tabs/tabManager.ts`, `links/linkProvider.ts`).
2. Bundle with esbuild / rollup / vite into a single `webview.js` (or small chunks) placed in `out/webview/`.
3. Reference bundled asset in the HTML template (`{{combinedScript}}`).
4. Source maps (inline or separate) for easier debugging.

Example esbuild script (concept):
```ts
import esbuild from 'esbuild';
await esbuild.build({
  entryPoints: ['webview-src/index.ts'],
  bundle: true,
  sourcemap: true,
  outfile: 'media/webview.bundle.js',
  format: 'iife',
  target: 'es2020'
});
```

## 5. Vision Shift: General Enhanced Terminal
Reposition as a “Smart Multi-Session Terminal” with optional auto-command profiles.

Pillars:
1. First-class tabbed terminal UX (reordering, vertical/horizontal layouts, persistence).
2. Profiles (shell, claude, node, docker, custom scripts).
3. File-aware enhancements (path recognition, quick open, completion).
4. Session resilience & export.
5. AI backend adapters (Claude CLI, future GPT / others).

Settings Evolution (examples):
- `smartTerminal.profiles`: Array `{ id, label, command, args, cwd, autoResume, env }`.
- `smartTerminal.startupProfiles`: Profiles to auto-create.
- `smartTerminal.link.mode`: `"validated" | "allTokensWithMeta"`.

Migration Steps:
1. Neutral internal IDs; preserve current contributes.
2. Seed profiles from existing types.
3. Gradual UI wording shift (behind feature flag).

## 6. Performance / Blank Render Issue Analysis
Symptoms:
- Refocus → black area until keypress.
- Slow initial load.

Likely Causes:
- Early fit/open before visible → zero dimension layout.
- Missing redraw on visibility gain.
- WebGL context loss not handled.
- Heavy synchronous debug logic before first paint.
- Premature test content writes.

Instrumentation Plan (timestamps T0–T6: script start, ctor start, open done, addons loaded, first fit, first PTY data, paint).

Remediation Phases:
**Phase A (Quick Wins)**
- Gate debug/test injections.
- Single combined link provider.
- `ResizeObserver` + visibility refresh.
- WebGL context loss → fallback to Canvas.

**Phase B (Moderate)**
- Staged addon loading (idle / microtasks).
- Lazy serialize/unicode addons.
- Central process polling.

**Phase C (Structural)**
- TS modularization.
- Slower polling or event-based detection.
- Visibility state machine.

Acceptance Targets:
- Refocus visible content <150ms median.
- Cold load prompt <800ms.
- Zero ‘black screen’ occurrences post-focus.

## 7. Security / Safety Enhancements
- Restrict `openFile` to workspace paths or prompt for external.
- Reject suspicious link tokens containing control/meta characters.
- Size threshold prompt for dropped binaries.
- Track & cleanup temp files on deactivate.

## 8. State Model Simplification
Single source: webview.
Extension host only snapshot for crash recovery.
Versioned schema (V2) with migration.

## 9. Refactor Roadmap
1. Quick Wins (Phase A + file guard + instrumentation).
2. Profile engine abstraction.
3. Webview TS conversion + bundler.
4. State v2.
5. Extensible link/completion strategies.
6. AI backend adapters.

## 10. Immediate Action Checklist
- [ ] Visibility-aware refresh & resize observer.
- [ ] Consolidate link providers.
- [ ] `openFile` workspace guard.
- [ ] Load timing instrumentation.
- [ ] Debug gating.

## 11. Open Questions
- Rebrand extension ID or keep for continuity?
- Multi-root workspace support priority?
- Scrollback trimming policy vs memory?

## 12. Appendix: Combined Link Regex
```js
const COMBINED = /(\b[\.~]?\/[^\s"'`]*(?:\s[^\s"'`]*)*|[a-z0-9_][^\s\/]*\.[a-z0-9]+|[a-zA-Z]:\\[^\s"'`]+)/g;
// CMD: /[^\s"'`]+/g
```

## 13. Appendix: Visibility Handling Snippet
```js
const ro = new ResizeObserver(() => activeTerminal?.fit());
ro.observe(container);
window.addEventListener('visibilitychange', () => {
  if (!document.hidden) requestAnimationFrame(() => {
    term.refresh(0, term.rows - 1);
    term.focus();
    term.fit();
  });
});
```

---
Update this file as milestones complete.
