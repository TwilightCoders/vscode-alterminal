# xterm-addon-webgpu

A WebGPU-backed renderer addon for [xterm.js](https://github.com/xtermjs/xterm.js) —
a drop-in replacement for `@xterm/addon-webgl` with one extra capability:
**many terminals in one page can share a single `GPUDevice`, glyph atlas and
set of pipelines.**

> Status: **early / in-tree.** This package currently lives inside the
> Alterminal repo at `lib/xterm-addon-webgpu/` for fast iteration. It is built
> to extract cleanly to a standalone repo once stable (see *Carve-out*). See
> [`STATUS.md`](./STATUS.md) for exactly what works today.

## Why

xterm's WebGL renderer creates an independent WebGL2 context per `Terminal`.
WebGL contexts cannot share resources, so each terminal carries its own glyph
atlas, shaders and GL state — tens of MB each. A workspace with many windows ×
many tabs multiplies that cost across the GPU process.

WebGPU lets multiple canvases share one `GPUDevice`. With a shared device, each
additional terminal adds only a canvas context and a small per-cell storage
buffer (~tens of KB) instead of a whole new atlas + context. GPU memory scales
with the number of **windows**, not windows × tabs.

A correctly-keyed, explicitly-managed atlas also sidesteps the glyph-atlas
*bleed* class of bug (mis-sampled neighbours showing as stray colored fragments)
that can affect the WebGL renderer under heavy churn.

## Usage

```ts
import { WebgpuAddon, SharedDevice } from "xterm-addon-webgpu";

// Drop-in — identical to WebglAddon:
const addon = new WebgpuAddon();
terminal.loadAddon(addon);
addon.onContextLoss(() => {/* fall back to DOM renderer */});

// Shared device — one per page/webview, passed to every terminal:
const shared = await SharedDevice.create(fontAtlasConfig);
terminalA.loadAddon(new WebgpuAddon({ device: shared }));
terminalB.loadAddon(new WebgpuAddon({ device: shared }));
terminalC.loadAddon(new WebgpuAddon({ device: shared }));
// All three share one GPUDevice + one atlas + one set of pipelines.
```

Because WebGPU device acquisition is asynchronous, the addon initializes in the
background and swaps its renderer into xterm once the device is ready. Until
then (and if WebGPU is unavailable), xterm keeps its existing DOM renderer — so
there is never a blank-screen gap, and an environment without WebGPU degrades
gracefully instead of erroring.

## Architecture

```
SharedDevice (one per page)
 ├─ GPUDevice + GPUAdapter
 ├─ GlyphAtlas      rgba8unorm 2D texture array; shelf packing + LRU bookkeeping
 ├─ pipelines       glyph (cell grid) · rectangles (bg/cursor) · decorations
 └─ bind group layouts

WebgpuRenderer (one per terminal)   ← implements xterm IRenderer
 ├─ GPUCanvasContext (its own canvas)
 ├─ per-pipeline storage buffers (instance data, grown as needed)
 ├─ RenderModel / CellColorResolver / DamageTracker
 └─ each frame: read viewport cells → resolve colors → pack instances → 3 draws
```

The three pipelines all draw an instanced unit quad (6 vertices, no vertex
buffer) with per-instance data pulled from a storage buffer:

- **cellGrid** — one instance per visible glyph, textured from the atlas.
  Grayscale glyphs are rasterized white-on-transparent (coverage in alpha) and
  tinted by the foreground color; color glyphs (emoji) use their own RGBA.
- **rectangles** — non-default cell backgrounds, selection, cursor.
- **linkDecorations** — underlines (single/double/dashed/curly) + strikethrough.

## Building

Self-contained — it has its own `node_modules`, `tsconfig`, and tests, so it
neither depends on nor disturbs the host extension's build.

```bash
npm install      # once
npm run build    # tsc -> dist/  (ESM, NodeNext, .js import specifiers)
npm test         # compiles + runs Mocha unit tests in plain Node
```

The pure-logic core (color math, atlas packing, LRU, cell model, instance
staging) is unit-tested in plain Node — no GPU, no DOM, no Electron harness.

### Manual / visual verification

- `test/smoke.html` — drives `WebgpuRenderer` with a synthetic buffer (no
  xterm, no extension). Serve the directory over http and open in a
  WebGPU-capable browser:
  ```bash
  npx http-server .     # then open /test/smoke.html
  ```
- `bench/bench.html` — Phase-0 micro-benchmark: instanced quads vs
  fullscreen-quad+lookup, across grid sizes.

## Shaders

Shaders are authored as TypeScript string modules (`src/pipeline/*.wgsl.ts`)
because the host extension builds with plain `tsc` and no asset loader. On
extraction to a bundler-based repo these can become raw `.wgsl` imports with no
change to the public API.

## Carve-out

This directory is structured to lift out as a standalone npm package without
restructuring: it already has its own `package.json`, `tsconfig.json`, `LICENSE`
(MIT), tests and docs, and takes `@xterm/xterm` only as a `peerDependency`. The
xterm API it consumes is declared structurally in `src/model/xtermTypes.ts`
(public `IBufferCell`/`IBuffer` surface only); the one internal reach (hooking
the render service) is isolated in `WebgpuAddon` and pinned via the peer range.

## License

MIT. Portions derived from xterm.js (`@xterm/addon-webgl`), © the xterm.js
authors, MIT.
