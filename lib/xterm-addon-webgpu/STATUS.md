# WebGPU renderer — build status & handoff

_Last updated: 2026-05-25. Branch: `feat/webgpu-renderer`._

> **UPDATE 2026-05-25:** It's now **wired into the live extension** as
> `alterminal.renderer: "webgpu"` and in real use. Validated against a real
> xterm Terminal (standalone demo + the extension): correct geometry, working
> selection/word-snap/copy, live theme/font/cursor, search-match highlighting,
> blinking cursor. Most parity items below are **done** (kerning, block-cursor
> inversion, font-driven metrics, live state subscriptions, dispose-restore,
> decoration overrides, cursor blink). See `PARITY.md` for the live gap list.
> **Remaining real-use gaps:** custom glyphs (powerline/box-drawing — TUIs show
> seams/tofu until ported), the shared-device memory win (v1 is per-terminal
> device), real LRU eviction (#27, approved), min-contrast/ligatures/overline.

This was built from the plan in `~/.claude/plans/transient-doodling-creek.md`.
The historical notes below describe the original spike; treat the UPDATE above
as current truth where they conflict.

## TL;DR

- **Phase 0 (bench)** + **Phase 1 (skeleton)** are done and compiling.
- Pure-logic core is **unit-tested (56 tests, green) in plain Node** — its own
  fast suite, independent of the extension's `@vscode/test-electron` harness.
- The GPU path is exercisable **right now** via `test/smoke.html` in any
  WebGPU-capable browser (no extension host needed).
- `src/webview/terminal.ts` is **untouched.** Swapping the live renderer is the
  Phase-3 step to do together, with eyes on a running window.

## What works (and is verified)

Built + strict-compiled + unit-tested in Node:

| Module | What | Tested |
|---|---|---|
| `util/attributes.ts` | xterm cell bit layout (fg/bg/ext masks, underline style) | via colorUtils/resolver |
| `util/colorUtils.ts` | rgba pack/unpack/blend, packed-attr → concrete color | ✅ |
| `util/fourKeyMap.ts` | `(code,fg,bg,ext)` glyph cache map | ✅ |
| `model/RenderModel.ts` | 4×u32-per-cell CPU model (xterm-identical layout) | ✅ |
| `model/CellColorResolver.ts` | inverse / invisible / dim / selection resolution | ✅ |
| `model/DamageTracker.ts` | dirty-row coalescing | ✅ |
| `model/InstanceStager.ts` | growable CPU instance buffer | ✅ |
| `atlas/shelfPacker.ts` | etagere-style shelf packing | ✅ |
| `atlas/lruEvictor.ts` | frame-marked LRU + **never-evict-this-frame** guard | ✅ |

Built + strict-compiled, exercised via `smoke.html` (need a GPU to run, so not
in the Node suite):

- `atlas/glyphRasterizer.ts` — OffscreenCanvas glyph raster + color detection
- `atlas/GlyphAtlas.ts` — texture-array atlas, tight-bbox crop upload, mid-frame
  reset guard
- `shared/SharedDevice.ts` — per-page device/atlas/pipelines, refcounted, device-lost
- `shared/{bindGroupLayouts,pipelines}.ts` — layouts + the 3 render pipelines
- `pipeline/*.wgsl.ts` — cellGrid / rectangles / linkDecorations shaders
- `platform/{deviceFeatures,DevicePixelObserver}.ts`
- `model/CellReader.ts` — public `IBufferCell` → packed attrs
- `WebgpuRenderer.ts` — the `IRenderer`; builds + draws a frame
- `WebgpuAddon.ts` — the `ITerminalAddon`; async init + render-service hookup

## Known stubs / Phase-2 scope (intentional)

These are deliberately simplified for the Phase-1 skeleton and called out in
code comments:

1. **Whole-viewport rebuild every frame.** `DamageTracker` is wired but the
   renderer doesn't yet skip clean rows. Correct, just not optimal.
2. **Atlas eviction = full reset.** When all layers fill, the atlas clears
   entirely and re-rasterizes on demand (correct, simple). The LRU data is
   maintained so the Phase-2 "evict LRU set, repack survivors" can drop in.
   Dynamic layer growth (recreate texture + copy) is not implemented; layer
   count is fixed at 4 × 2048².
3. **Block cursor is a translucent fill**, not true glyph inversion. Bar and
   underline cursors are correct.
4. **Selection** is plumbed through `CellColorResolver` but the renderer always
   passes `selected:false` (no selection-model integration yet).
5. **Decoration overrides** from xterm's decoration service (per-cell fg/bg
   decorations) are not applied — `CellColorResolver` omits that branch.
6. **Combining chars / grapheme clusters** rasterize via `getChars()` which
   returns the full cluster string, so they mostly work, but wide-glyph metrics
   and zero-width joins aren't specially handled.
7. **Dotted underline** is approximated as dashed.

## Deliberately deferred (needs Dale + a running window)

**The Phase-3 step — swapping `WebglAddon` → `WebgpuAddon` in
`src/webview/terminal.ts` — was intentionally NOT done.** Reasons:

- It's the one change that can't be verified without a live VS Code window and
  human eyes (does real Claude/Ink output render correctly? cursor? resize?
  theme changes? selection?).
- The addon's render-service hookup reaches into xterm internals
  (`_core._renderService`, `_charSizeService`, `_themeService`). Those need to
  be confirmed against our pinned xterm 6.0.0 build interactively — exactly the
  kind of "confident action on an unverified model" that bites.
- It's gated behind a settings flag anyway; wiring it half-tested overnight adds
  risk with no upside.

When we do it together, the integration is small and already designed for:
- `terminal.ts` already branches on `window.__alterminalRenderer` (currently
  `webgl`/`dom`). Add a `webgpu` case that constructs `WebgpuAddon`.
- Create one `SharedDevice` at webview boot (e.g. in `init.ts`) and pass it to
  every `TerminalInstance` so tabs share it — that's where the memory win is.
- Add `"webgpu"` to the `alterminal.renderer` enum in `package.json`.
- The build needs a decision: the webview is tsc-only ESM loaded as UMD globals
  today. Either (a) compile `lib/xterm-addon-webgpu/src` into the webview bundle
  via an added `include`, or (b) ship `dist/` and load it. **Decide this with
  Dale** — it's the only real integration question and affects the build graph.

## ⚠️ Revisit the plan's core premise

The plan assumes a ~2.5 GB `Code Helper (GPU)` process that WebGPU shrinks. The
2026-05-24 fresh-restart A/B contradicts this: the GPU process was ~flat between
WebGL and DOM (**147 vs 178 MB**). WebGL's real cost is ~**64 MB per renderer**,
spread across webview processes — not a giant central GPU process.

So the memory win from this work is **per-renderer (shared device collapses
N atlases/contexts to 1)**, not "shrink the GPU process." Still real, still
worth it — and the atlas-bleed fix is an independent win — but measure against
the right baseline in Phase 3, and don't expect a multi-GB GPU-process drop.

## How to poke it

```bash
cd lib/xterm-addon-webgpu
npm install && npm test          # 56 green, pure Node
npm run build                    # dist/
npx http-server .                # open /test/smoke.html and /bench/bench.html
```

`smoke.html` should show 6 lines of styled text (colors, bold/italic/underline/
curly, emoji) and a block cursor. If you can read them, the rasterizer → atlas →
instanced-draw → composite path all work.
