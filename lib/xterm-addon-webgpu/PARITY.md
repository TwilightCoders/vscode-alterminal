# WebGPU renderer — parity audit vs `@xterm/addon-webgl`

_Audit date: 2026-05-25 (Otto Loom). Branch: `feat/webgpu-renderer`._

This is an exhaustive comparison of the in-tree WebGPU renderer
(`lib/xterm-addon-webgpu/src/`) against the reference `@xterm/addon-webgl`
(`node_modules/@xterm/addon-webgl/src/`) and the shared xterm renderer contract
(`node_modules/@xterm/xterm/src/browser/renderer/shared/`). It catalogs every
place OURS diverges from or omits behavior the REFERENCE has, with concrete
`file:line` citations on both sides, ordered by severity.

**Reading the architecture difference first** (it explains many gaps): the WebGL
renderer **bakes per-cell styling into the rasterized glyph in the atlas** — the
glyph's colors, dim, minimum-contrast, underline/overline/strikethrough, custom
glyphs are all drawn into the bitmap by `TextureAtlas._drawToCache`
(`TextureAtlas.ts:433-922`), keyed by `(code|chars, bg, fg, ext)`. The
`GlyphRenderer` then just blits a textured quad. OURS rasterizes **white-on-
transparent coverage only** (`atlas/glyphRasterizer.ts:61-80`) keyed the same
way, then **tints in the shader** and draws decorations as **separate rectangle
instances** (`WebgpuRenderer.ts:422-459`). That's a legitimate alternative, but
it means several REFERENCE behaviors that "come for free" by baking are simply
absent in OURS.

---

## Severity scale

- **BREAKS-INTEGRATION** — wrong geometry, broken interaction, stale state, or
  crashes when wired into a live `Terminal`.
- **VISUALLY-WRONG** — renders, but visibly incorrect vs WebGL.
- **MISSING-FEATURE** — a capability the WebGL renderer has that OURS lacks.
- **PERF** — correctness OK, but slower than it should be.

---

## Summary table

| # | Feature | WebGL ref (file:line) | Ours status | Severity | Notes |
|---|---------|----------------------|-------------|----------|-------|
| 1 | `onRequestRedraw` ever fired | `WebglRenderer.ts:621-628`, consumed `RenderService.ts:238` | **Defined, never fired** | BREAKS-INTEGRATION | No cursor blink, no focus/blur redraw, no selection redraw, no DPR redraw. |
| 2 | Live state updates (theme/options/cursor) | `WebglRenderer.ts:93,106,243-247,362-373` | **Snapshotted once at activate; `setMetrics` never called** | BREAKS-INTEGRATION | Theme change, font/size change, cursorStyle/cursorBlink change, focus change never reach the renderer. |
| 3 | Cursor blink | `CursorBlinkStateManager.ts` + `WebglRenderer.ts:362-373,409` | **Absent** | BREAKS-INTEGRATION | No blink manager; `cursorVisible` hardcoded `true`. |
| 4 | `handleCursorMove` redraws cursor row | `WebglRenderer.ts:236-241` | **No-op** (`WebgpuRenderer.ts:275-277`) | BREAKS-INTEGRATION | Cursor only moves when other content forces a frame. |
| 5 | Decoration-service overrides (per-cell fg/bg) | `CellColorResolver.ts:67-77,174-184` | **Omitted** (`model/CellColorResolver.ts` has no decoration branch) | BREAKS-INTEGRATION | Search highlight, find-match, link hover, custom decorations don't paint. |
| 6 | Dispose restores a working default renderer | `WebglAddon.ts:90-97` | **Absent** | BREAKS-INTEGRATION | On dispose xterm is left with no renderer (blank terminal). |
| 7 | `_isAttached` deferred-attach retry in `renderRows` | `WebglRenderer.ts:323-332` | **Absent** | BREAKS-INTEGRATION | If activated before char size is valid, never recovers. |
| 8 | Selection model semantics (capped rows, columnSelectMode, viewport) | `SelectionRenderModel.ts` | **Simplified port** (`model/selection.ts`) | VISUALLY-WRONG | Off-screen scroll capping & wide-cell handling differ; see detail. |
| 9 | `selectionForeground` theme color | `CellColorResolver.ts:124-127` | **Omitted** | VISUALLY-WRONG | Selected text keeps original fg even when theme sets a selection fg. |
| 10 | Inactive-selection color (`selectionInactiveBackgroundOpaque`) | `CellColorResolver.ts:116,119` | **Approximated** (`model/CellColorResolver.ts:62-65`) | VISUALLY-WRONG | OURS fakes inactive by halving alpha of the active color; WebGL uses a distinct theme color. |
| 11 | Selection bg blend over colored cells | `CellColorResolver.ts:82-121` | **Partial** | VISUALLY-WRONG | OURS blends, but the special handling for inverse/powerline-as-bg glyph is absent. |
| 12 | minimumContrastRatio | `TextureAtlas.ts:317-424` | **Absent** | VISUALLY-WRONG | Low-contrast fg-on-bg pairs are not bumped; readability regression. |
| 13 | drawBoldTextInBrightColors | `TextureAtlas.ts:327-329,378-380` | **Absent** | VISUALLY-WRONG | Bold P16 colors 0–7 not promoted to bright 8–15. |
| 14 | DIM opacity value | `Constants.ts:8` (`0.5`), `TextureAtlas.ts:351-353` | **Matches (0.5)** but applied in shader alpha | VISUALLY-WRONG | OURS halves fg alpha (`WebgpuRenderer.ts:414`); WebGL multiplies the opaque color. Result differs over non-default bg. |
| 15 | Custom glyphs (box-drawing + powerline) | `CustomGlyphs.ts` (693 lines), `TextureAtlas.ts:514-518` | **Absent** | MISSING-FEATURE | Box-drawing / powerline render as font glyphs (gaps/seams) or tofu. |
| 16 | Powerline / box-glyph treated as bg color | `RendererUtils.ts:63-65`, `CellColorResolver.ts:129-171` | **Absent** | VISUALLY-WRONG | Powerline separators don't get the bg-color treatment under selection/inverse. |
| 17 | Character joiners (ligatures) | `WebglRenderer.ts:419-467,530-546` | **Absent** | MISSING-FEATURE | `_characterJoinerService` not consulted; ligatures render per-cell. |
| 18 | `rescaleOverlappingGlyphs` | `GlyphRenderer.ts:282-286`, `RendererUtils.ts:47-61` | **Absent** | VISUALLY-WRONG | Oversized single-width glyphs overflow into the next cell. |
| 19 | Underline color (`isUnderlineColorRGB`/`Default`) | `TextureAtlas.ts:541-553` | **Absent** | VISUALLY-WRONG | Colored underlines always drawn in fg color. |
| 20 | Dotted underline (true dotted + variant offset) | `TextureAtlas.ts:610-627`, `CellColorResolver.ts:62-64`, `RendererUtils.ts:93-95` | **Approximated as dashed** (`WebgpuRenderer.ts:569-570`) | VISUALLY-WRONG | Known stub; also the cross-cell phase (`VARIANT_OFFSET`) is dropped. |
| 21 | Underline run continuity across cells | `TextureAtlas.ts:583-608` (curly clip + bleed) | **Per-cell rect** | VISUALLY-WRONG | Curly/dashed underlines won't be continuous across adjacent cells. |
| 22 | Overline | `TextureAtlas.ts:682-692` | **Absent** | MISSING-FEATURE | `BgFlags.OVERLINE` is read into `ext`? No — not even read; never drawn. |
| 23 | Strikethrough metrics | `TextureAtlas.ts:718-728` (`charHeight/2`) | **Approx** (`WebgpuRenderer.ts:455-457`, `cellH*0.45`) | VISUALLY-WRONG | Position approximated; minor. |
| 24 | Underscore-beyond-cell shift | `TextureAtlas.ts:699-716` | **Absent** | VISUALLY-WRONG | `_` on the bottom row may be clipped. |
| 25 | `restrictToCellHeight` | `TextureAtlas.ts:558,931-934,1007-1008` | **Absent** | MISSING-FEATURE | Used for tall glyphs near viewport bottom. |
| 26 | `allowTransparency` | `TextureAtlas.ts:282-287,346`, addon ctor | **Absent** | MISSING-FEATURE | `alphaMode:"opaque"` hardcoded (`WebgpuRenderer.ts:146`). |
| 27 | Char/cell `top`/`left` offsets in dimensions | `WebglRenderer.ts:578-587` | **Hardcoded 0** (`WebgpuRenderer.ts:202`) | VISUALLY-WRONG | letterSpacing>0 / lineHeight>1 glyph centering wrong. Baseline computed in addon instead. |
| 28 | DPR observer resizes backing store | `WebglRenderer.ts:610-619` + `DevicePixelObserver.ts` | **Partial** | VISUALLY-WRONG | OURS recomputes from metrics on DPR change but metrics aren't refreshed from charSizeService (#2). |
| 29 | Context-loss restoration (auto-recover) | `WebglRenderer.ts:110-131` | **Fires loss, no auto-restore** | MISSING-FEATURE | WebGL waits 3 s for `webglcontextrestored` and rebuilds; OURS just fires `onContextLoss`. |
| 30 | Atlas page merge / multi-page growth | `TextureAtlas.ts:150-244` | **Single fixed 4-layer array, full reset on overflow** | PERF | Known stub. Correct but thrashes under glyph pressure. |
| 31 | Damage/dirty-row skipping | `WebglRenderer.ts:346-352` (`beginFrame`/lineLengths) | **Whole viewport every frame** | PERF | Known stub; `DamageTracker` wired but unused for skipping. |
| 32 | Trailing-whitespace cull (`lineLengths`) | `GlyphRenderer.ts:347-353` | **Absent** | PERF | OURS iterates all cols every row. |
| 33 | Cursor: wide-cell width, `cursorWidth`, inactive styles | `WebglRenderer.ts:479-499`, `RectangleRenderer.ts:245-308` | **Partial** | VISUALLY-WRONG | See detail; bar ignores `cursorWidth`, no `outline` inactive style, wide-cell block width wrong. |
| 34 | `clearTextureAtlas` full-refresh + redraw | `WebglRenderer.ts:307-311` | **Partial** (no redraw fire) | VISUALLY-WRONG | Clears atlas + marks dirty but never requests a redraw (ties to #1). |
| 35 | `warmUp` (idle pre-raster ASCII) | `TextureAtlas.ts:113-131`, `WebglRenderer.ts:291` | **Absent** | PERF | First frames rasterize on the hot path. |
| 36 | `setTraceLogger(logService)` | `WebglAddon.ts:71` | **Absent (logService not grabbed)** | MISSING-FEATURE | Minor; no trace logging. |
| 37 | `_core._store._isDisposed` guard on dispose | `WebglAddon.ts:91` | **Absent** | BREAKS-INTEGRATION | Dispose during teardown can touch a disposed core. |
| 38 | Canvas/screen sizing + cell-from-charSize | `WebglRenderer.ts:184-192,558-607` | **✓ handled** (`WebgpuRenderer.ts:213-236`, `WebgpuAddon.ts:146-171`) | — | The gap that prompted this audit; mirrored correctly. |

---

## Detail per gap (ordered by severity)

### 1. `onRequestRedraw` is never fired — BREAKS-INTEGRATION

**Ref:** `WebglRenderer.ts:61-62` declares the emitter;
`:621-628` (`_requestRedrawViewport`, `_requestRedrawCursor`) fire it; it is
fired from blink (`:365`), focus/blur (`:216,225`), selection (`:233`), color
change/`clearTextureAtlas` (`:310`), and the DPR observer (`:618`).
`RenderService.ts:238` wires `renderer.onRequestRedraw(e => this.refreshRows(e.start, e.end, true))`.

**Ours:** `WebgpuRenderer.ts:120-121` create the emitter and expose
`onRequestRedraw`, but **`_onRequestRedraw.fire()` is never called anywhere**
(verified by grep). `handleBlur/Focus/SelectionChanged/clearTextureAtlas` just
call `this._damage.markAllDirty()` (`:251-287`) and return — nothing asks xterm
to schedule a frame. So a focus change, selection change, atlas clear, or any
blink tick produces **no visible update** until unrelated content forces a
`renderRows`.

**Fix:** add `_requestRedrawViewport()` / `_requestRedrawCursor()` that
`this._onRequestRedraw.fire(...)`, and call them from `handleBlur`,
`handleFocus`, `handleSelectionChanged`, `clearTextureAtlas`,
`handleDevicePixelRatioChange`, and the (to-be-added) blink callback. This is
the WebGPU analog of `WebglRenderer.ts:621-628`.

---

### 2. Renderer state is snapshotted once and never updated — BREAKS-INTEGRATION

**Ref:** `WebglRenderer` holds live service handles and subscribes:
`onChangeColors` (`:93`) → `_handleColorChange` refreshes atlas + full model
clear; `onOptionChange` (`:106`) → `_handleOptionsChanged` (`:243-247`) updates
dimensions, atlas, cursor blink; focus is read live via
`_coreBrowserService.isFocused` every model build (`:483,490`). `CellColorResolver`
reads `_themeService.colors` live on every cell (`:58`).

**Ours:** `WebgpuAddon._buildMetrics` (`WebgpuAddon.ts:192-208`) builds an
`IRenderMetrics` (cols, rows, cell sizes, **palette**, focused, cursorStyle)
**once** and passes it into the renderer constructor (`:108-115`). The renderer
exposes `setMetrics` (`WebgpuRenderer.ts:207-211`) for live updates, but **the
addon never calls it** (verified by grep — only definition exists). The addon
subscribes to **no xterm services** — no `onChangeColors`, no `onOptionChange`,
no `coreBrowserService` focus events. Consequences:

- Theme change (light/dark toggle, color customization) → palette stays stale.
- Font family/size/weight/lineHeight/letterSpacing change → cell metrics and the
  rasterizer config stay stale (atlas glyphs are the wrong size).
- `cursorStyle` / `cursorBlink` option change → renderer keeps the boot value.
- `minimumContrastRatio`, `drawBoldTextInBrightColors`, `customGlyphs`,
  `rescaleOverlappingGlyphs` changes → ignored.

`RenderService.ts:94-117` is the list of option/theme changes the renderer is
expected to react to; OURS reacts to none.

**Fix:** in the addon, grab `_themeService`, `optionsService`,
`_coreBrowserService` and subscribe: `onChangeColors` → rebuild palette +
`renderer.setMetrics` + `clearTextureAtlas`; `onOptionChange`/
`onMultipleOptionChange` (font/contrast/cursor list) → rebuild metrics + font
config + force atlas refresh; `coreBrowserService.onFocus/onBlur` is already
routed via `handleFocus/handleBlur` from the render service, but those must then
fire `onRequestRedraw` (#1).

---

### 3 & 4. Cursor blink absent; `handleCursorMove` is a no-op — BREAKS-INTEGRATION

**Ref:** `CursorBlinkStateManager.ts` drives blink via `requestAnimationFrame`,
calling back into `_requestRedrawCursor` (`WebglRenderer.ts:364-366`).
`_updateCursorBlink` (`:362-373`) creates/destroys it based on
`decPrivateModes.cursorBlink ?? options.cursorBlink`. `handleCursorMove`
(`:236-241`) restarts the blink animation and redraws. Cursor visibility folds
`cursorBlinkStateManager.isCursorVisible` into the model (`:406-409`).

**Ours:** No blink manager exists. `IRenderMetrics.cursorVisible` is **hardcoded
`true`** in `WebgpuAddon._buildMetrics` (`WebgpuAddon.ts:205`) and never toggled.
`handleCursorMove` is an explicit no-op (`WebgpuRenderer.ts:275-277`) with a
comment "Cursor is rebuilt every frame in this phase" — but since blink and many
redraws don't fire frames (#1), a moved cursor often won't repaint until other
content changes.

**Fix:** port `CursorBlinkStateManager` (it only needs a `window` and a redraw
callback — easy to adapt off `coreBrowserService`), toggle `cursorVisible`
through `setMetrics` + `onRequestRedraw`, and make `handleCursorMove` restart the
blink + fire `_requestRedrawCursor`.

---

### 5. Decoration-service overrides omitted — BREAKS-INTEGRATION

**Ref:** `CellColorResolver.resolve` applies decorations twice — a 'bottom'
layer before selection (`CellColorResolver.ts:67-77`) and a 'top' layer after
(`:174-184`), each via `_decorationService.forEachDecorationAtCell(x, y, layer, cb)`,
overriding fg/bg. This is how xterm paints search highlights, find-on-page
matches, link hover backgrounds, and any `registerDecoration` overlay color.

**Ours:** `model/CellColorResolver.ts` has **no decoration branch at all** — its
header comment explicitly defers it ("decoration-service overrides ... noted for
the parity phase"). The addon never grabs `_decorationService`. So any feature
relying on decoration colors renders without them. For Alterminal specifically,
this likely breaks the in-terminal search/find highlight.

**Fix:** grab `_decorationService` in the addon, thread a decoration lookup into
the per-cell resolve (the renderer already has `absRow`/`col` at
`WebgpuRenderer.ts:355-358`). Mirror the bottom-then-selection-then-top ordering.
Note `RenderService.ts:90-91` already triggers full refresh on decoration
add/remove, so once the resolve honors them and #1 is fixed, it'll paint.

---

### 6 & 37. Dispose doesn't restore a renderer + no disposed-core guard — BREAKS-INTEGRATION

**Ref:** `WebglAddon.ts:90-97` — on dispose, if the core isn't already disposed
(`_core._store._isDisposed` guard, `:91`), it re-creates xterm's default renderer
(`renderService.setRenderer(core._createRenderer())`) and calls
`handleResize(cols, rows)`. This leaves the terminal with a working DOM renderer.

**Ours:** `WebgpuAddon.dispose` (`WebgpuAddon.ts:247-260`) disposes the renderer,
removes the canvas, releases the device — but **never calls
`renderService.setRenderer(...)` to install a replacement**. After dispose,
`RenderService._renderer.value` is the disposed WebGPU renderer (or undefined),
so the terminal goes blank. There is also no `_isDisposed` guard, so disposing
during terminal teardown can touch a half-torn-down core.

**Fix:** in dispose, if the core is alive, call
`renderService.setRenderer(core._createRenderer())` then
`renderService.handleResize(cols, rows)`, mirroring `WebglAddon.ts:90-97`.

---

### 7. No deferred-attach retry in `renderRows` — BREAKS-INTEGRATION

**Ref:** `WebglRenderer.renderRows` (`:323-332`) guards on `_isAttached`; if not
attached, it checks `screenElement.isConnected && charSizeService.width/height`
and, when ready, updates dimensions + refreshes the atlas and sets attached.
This recovers the common case where the renderer is created before the terminal
has a measured char size (hidden tab, not-yet-laid-out container).

**Ours:** `renderRows` (`WebgpuRenderer.ts:289-295`) immediately marks the range
dirty and renders. `_build` bails per-row only if `getLine` returns falsy
(`:336-339`). There's no "char size not ready yet, try again next frame" path. If
the addon initializes while `charSizeService.width` is 0 (e.g. tab opened
hidden), the metrics captured at `_buildMetrics` use the `{width:9,height:17}`
fallback (`WebgpuAddon.ts:149`) and **never correct** because of #2. Combined
with #2 this is a real first-paint hazard.

**Fix:** track an `_isAttached`-style flag; on `renderRows`, if metrics came from
the fallback / char size was invalid, re-derive from `charSizeService` once it's
valid and `setMetrics`. (Cleanest once #2's subscriptions exist.)

---

### 8. Selection model simplified — VISUALLY-WRONG

**Ref:** `SelectionRenderModel.update` (`SelectionRenderModel.ts:39-69`)
translates buffer→viewport, computes **capped** start/end rows
(`viewportCappedStartRow/EndRow`) so an off-screen-scrolled selection still
paints its visible slice, and bails when fully off-screen. `isCellSelected`
(`:71-88`) handles columnSelectMode in both column orders and the multi-row
first/last-row column rules, subtracting `viewportY` live.

**Ours:** `model/selection.ts` keeps selection in **absolute buffer coords** and
tests with `isCellInSelection` (`:30-56`). It's a clean reimplementation, but:
- No viewport capping — it relies on the renderer only iterating visible rows
  (`WebgpuRenderer.ts:333-341` uses `top = buffer.viewportY`), which is OK for
  the common case but the per-cell test uses `absRow` directly so scrolled-out
  ranges are handled implicitly. Acceptable, but untested against the capped-row
  edge cases WebGL explicitly handles.
- columnSelectMode handles only `min/max` ordering (`:38-41`); WebGL distinguishes
  `startCol <= endCol` vs the reverse drag explicitly (`SelectionRenderModel.ts:77-82`).
  For column select the visual result should match, but verify reverse-drag.
- The renderer treats wide (width-2) cells by skipping width-0 trailing spacers
  (`WebgpuRenderer.ts:350-351`); selection of a wide char's trailing half isn't
  special-cased.

**Fix:** lower-priority than #1–7. Port the capped-row logic and the explicit
column-order branch if column-select reverse-drag misbehaves.

---

### 9–11. Selection foreground / inactive color / blend specials — VISUALLY-WRONG

**Ref:** `CellColorResolver.ts`:
- `:124-127` applies `$colors.selectionForeground` when the theme defines it.
- `:116,119,136,167` use `selectionInactiveBackgroundOpaque` when unfocused —
  a **distinct theme color**, not a transparency tweak.
- `:82-121` resolves the underlying bg (including inverse) before blending the
  selection color over it; `:129-171` specially handles powerline/box glyphs as
  background color under selection.

**Ours:** `model/CellColorResolver.ts:60-66` blends `palette.selectionBackground`
over the resolved bg, and approximates inactive selection by masking the alpha to
`0x80` (`:62-65`). It does **not**:
- apply a selection foreground (`selectionForeground` isn't even in `Palette`,
  `colorUtils.ts:11-20`);
- use a separate inactive color (the addon only reads
  `selectionBackgroundOpaque`, `WebgpuAddon.ts:233` — `selectionInactiveBackgroundOpaque`
  is never read);
- handle the inverse/powerline-as-bg selection specials.

**Fix:** add `selectionForeground` and `selectionInactiveBackground` to `Palette`
+ `_buildPalette`; thread a `selectionForeground` override into the resolve and
pick the inactive color by `focused`.

---

### 12 & 13. minimumContrastRatio + drawBoldTextInBrightColors absent — VISUALLY-WRONG

**Ref:** baked into the glyph color during raster:
`TextureAtlas._getMinimumContrastColor` (`:393-424`) bumps fg via
`rgba.ensureContrastRatio` (half-ratio for dim), cached per `(bg,fg)`;
`_getForegroundColor`/`_resolveForegroundRgba` promote bold P16 0–7 → 8–15 when
`drawBoldTextInBrightColors` (`:327-329,378-380`).

**Ours:** the rasterizer draws **pure white coverage** and tints in the shader
(`glyphRasterizer.ts:74-75`, `WebgpuRenderer.ts:394-420`), so there is **no
contrast adjustment and no bright-bold promotion** anywhere. `minimumContrastRatio`
and `drawBoldTextInBrightColors` options are never read.

**Fix:** since OURS resolves fg color on the CPU in `CellColorResolver`, do both
there: (a) if `bold && drawBoldTextInBrightColors && P16 idx < 8`, add 8 before
palette lookup; (b) after resolving fg/bg, run an `ensureContrastRatio` (port
xterm's `common/Color` `rgba.ensureContrastRatio`) gated on
`minimumContrastRatio !== 1`, half-ratio when dim, and cache by `(bg,fg)`.

---

### 14. DIM applied as shader alpha vs opaque-color multiply — VISUALLY-WRONG

**Ref:** `TextureAtlas.ts:351-353` — `color.multiplyOpacity(result, DIM_OPACITY)`
on an **opaque** fg color, baking the dimmed RGB into the glyph.
`Constants.ts:8` `DIM_OPACITY = 0.5`.

**Ours:** `WebgpuRenderer.ts:378,394-414` passes `dim` to `_pushGlyph` which
**halves the glyph's alpha** (`:414` `dim ? a * 0.5 : a`). Over the default bg
this looks similar, but over a non-default cell bg the glyph blends into that bg
at 50% rather than being a fixed dimmed RGB — a different (and theme-incorrect)
result. Also if `allowTransparency` were on, halving alpha double-applies.

**Fix:** compute the dimmed fg color on the CPU in `CellColorResolver`
(`multiplyOpacity(fg, 0.5)`) and keep glyph alpha at full, matching WebGL.

---

### 15 & 16. Custom glyphs (box-drawing + powerline) absent — MISSING-FEATURE / VISUALLY-WRONG

**Ref:** `CustomGlyphs.ts` (693 lines) draws box-drawing (U+2500–259F), powerline
(U+E0A4–E0D6), and Braille programmatically; `TextureAtlas.ts:514-518` invokes
`tryDrawCustomChar` when `customGlyphs !== false`, so these render pixel-perfect
and seamless. `treatGlyphAsBackgroundColor` (`RendererUtils.ts:63-65`) flags them
for the bg-color treatment (#16) and excludes them from contrast demands
(`TextureAtlas.ts:508`).

**Ours:** no equivalent of `CustomGlyphs.ts`; box-drawing/powerline fall through
to plain `fillText` (`glyphRasterizer.ts:75`), which leaves seams between cells
(box drawing) and wrong padding (powerline). The bg-color treatment (#16) is
absent.

**Fix:** port `CustomGlyphs.ts` and call it from `glyphRasterizer.rasterize`
before `fillText` (the rasterizer already has cell dims via config). This is a
large but self-contained port. Until then, box/powerline UIs (tmux, lazygit,
starship prompts) will look visibly broken.

---

### 17. Character joiners (ligatures) absent — MISSING-FEATURE

**Ref:** `WebglRenderer._updateModel` consults
`_characterJoinerService.getJoinedCharacters(row)` (`:419`), validates the range
(consistent selection state `:445-448`, cursor not inside `:450`), builds a
`JoinedCellData` (`:458-462`, class at `:632-675`), draws one wide glyph, and
nulls the covered cells (`:530-546`).

**Ours:** the addon never grabs `_characterJoinerService`; `_build`
(`WebgpuRenderer.ts:334-384`) iterates cell-by-cell with no joining. Programming
ligatures (Fira Code `=>`, `!=`) render as separate glyphs.

**Fix:** grab `_characterJoinerService`, port the join logic into `_build`. Medium
effort. Lower priority unless Alterminal ships a ligature font by default.

---

### 18. rescaleOverlappingGlyphs absent — VISUALLY-WRONG

**Ref:** `GlyphRenderer.ts:282-286` + `allowRescaling` (`RendererUtils.ts:47-61`):
single-width glyphs whose rasterized width exceeds `1.5 × cellWidth` (excluding
ascii/emoji/powerline/nerd) are squeezed to `cellWidth-1`.

**Ours:** `_pushGlyph` (`WebgpuRenderer.ts:394-420`) emits the glyph at its tight
size with no rescaling, so a too-wide single-cell glyph spills into the neighbor.

**Fix:** port `allowRescaling`; when true, clamp the emitted quad width.

---

### 19–25. Line-style details (underline color/dotted/continuity/overline/underscore/restrict) — VISUALLY-WRONG / MISSING

All baked by `TextureAtlas._drawToCache` in the ref; OURS draws decorations as
separate rectangle instances (`WebgpuRenderer._pushDecorations`, `:422-459`),
which inherently can't replicate per-glyph baking:

- **Underline color** (`TextureAtlas.ts:541-553`): colored/indexed underline
  colors. OURS always uses fg (`:430,451`).
- **Dotted** (`:610-627`) with `VARIANT_OFFSET` phase (`CellColorResolver.ts:62-64`,
  `RendererUtils.ts:93-95`): OURS maps dotted→dashed (`:569-570`) and drops the
  cross-cell phase entirely (the `ext` VARIANT_OFFSET bits are never set —
  `CellReader.ts:64-67` only writes underline style, and `CellColorResolver` never
  computes the offset).
- **Continuity** (`:583-608` curly clip + half-cell bleed; dashed `:628-639`):
  OURS draws an independent rect per cell, so multi-cell curly/dashed underlines
  won't align/connect.
- **Overline** (`:682-692`): not drawn at all (and `BgFlags.OVERLINE` is read into
  `bg` in `CellReader.ts:60` but never consumed by the decoration pass).
- **Underscore shift** (`:699-716`): not handled.
- **restrictToCellHeight** (`:558,931-934,1007-1008`): not handled.

**Fix:** these are individually small in the rect-based model — extend
`_pushDecorations` to read underline color from `ext`, draw true dotted, set the
variant offset in the model + shader for cross-cell phase, draw overline, and
make the decoration shader bleed half a cell for curly/dashed continuity. Overline
is the cheapest, biggest-bang fix.

---

### 26. allowTransparency unsupported — MISSING-FEATURE

**Ref:** addon ctor takes `preserveDrawingBuffer`; `TextureAtlas` honors
`allowTransparency` (`:282-287,346`) to render the glyph bg as transparent.

**Ours:** `WebgpuRenderer.ts:146` hardcodes `alphaMode:"opaque"` and the clear
uses an opaque background (`:508`). If Alterminal ever enables a transparent/
acrylic terminal background, OURS can't honor it.

**Fix:** thread `allowTransparency` from options → `alphaMode:"premultiplied"`
and clear alpha; skip drawing the default-bg rect (already done at `:367`).

---

### 27. char/cell `top`/`left` offsets hardcoded to 0 — VISUALLY-WRONG

**Ref:** `WebglRenderer._updateDimensions` (`:578-587`) computes
`device.char.top` (vertical centering when lineHeight≠1) and `device.char.left`
(`floor(letterSpacing/2)`), and the glyph renderer applies them
(`GlyphRenderer.ts:249,264`).

**Ours:** `dimensions.device.char` is reported as `{top:0,left:0}`
(`WebgpuRenderer.ts:202`). OURS instead bakes a single baseline into the
rasterizer (`WebgpuAddon._charDims:160-164`) and centers there. For `lineHeight=1,
letterSpacing=0` (the default) this is fine, but with `lineHeight>1` or
`letterSpacing>0` the horizontal centering and the reported `dimensions` will
disagree with what xterm/WebGL expect. Since `dimensions` is also read by xterm
consumers (e.g. overview ruler, addon-image), the zeroed offsets could mislead
them.

**Fix:** compute `char.top`/`char.left` per `WebglRenderer.ts:578-587` and apply
the left offset to glyph x; verify against a non-1 lineHeight.

---

### 28. DPR change doesn't re-measure char size — VISUALLY-WRONG (ties to #2)

**Ref:** `WebglRenderer.handleDevicePixelRatioChange` (`:164-171`) updates
`_devicePixelRatio` from `coreBrowserService.dpr` then calls `handleResize`,
which re-runs `_updateDimensions` reading `charSizeService` at the new DPR, and
regenerates the atlas.

**Ours:** `handleDevicePixelRatioChange` (`WebgpuRenderer.ts:247-249`) just calls
`_applyMetrics()` using the **existing** `_metrics` (whose `devicePixelRatio` and
cell sizes are stale — they were snapshotted at activate, #2). The
`DevicePixelObserver` callback (`WebgpuAddon.ts:120`) calls the renderer method
but the addon never recomputes metrics/font config at the new DPR, so glyphs stay
rasterized at the old DPR (blurry) until something else rebuilds them.

**Fix:** in the addon's DPR-observer callback, recompute `_charDims` + font config
+ `setMetrics` + force atlas re-raster (clearTextureAtlas), then fire redraw.

---

### 29. No WebGPU device-lost recovery — MISSING-FEATURE

**Ref:** `WebglRenderer.ts:110-131` listens for `webglcontextlost`, waits 3 s for
`webglcontextrestored`, and on restore rebuilds GL state + atlas and redraws;
only fires `onContextLoss` if not restored.

**Ours:** `SharedDevice.onDeviceLost` → addon fires `onContextLoss`
(`WebgpuAddon.ts:117-119`) with no attempt to re-acquire a device and rebuild.
WebGPU device loss is rarer but real (GPU reset, driver update). Acceptable for a
spike; note for parity.

**Fix:** on device-lost, attempt `SharedDevice.create` again and rebuild atlas +
pipelines + renderer; only surface `onContextLoss` if re-acquire fails.

---

### 30–32 & 35. Atlas growth, damage skipping, whitespace cull, warmUp — PERF

All known/expected for Phase 1, listed for completeness:
- **Atlas page merge/growth** — ref `TextureAtlas.ts:150-244`; OURS fixed 4×2048²
  with full reset on overflow (`GlyphAtlas.ts:142-163`). STATUS.md item 2.
- **Damage skipping** — ref `WebglRenderer.ts:346-352`; OURS rebuilds whole
  viewport (`WebgpuRenderer.ts:289-295,315-387`). STATUS.md item 1; `DamageTracker`
  wired but `_build` ignores it.
- **Trailing-whitespace cull** — ref `GlyphRenderer.ts:347-353` via `lineLengths`;
  OURS iterates all cols.
- **warmUp** — ref `TextureAtlas.ts:113-131` pre-rasters ASCII 33–126 in idle
  callbacks; OURS has none, so first frames rasterize on the hot path.

---

### 33. Cursor: wide-cell width, cursorWidth, inactive styles — VISUALLY-WRONG

**Ref:** model captures `width: cell.getWidth()`, `cursorWidth`, and the
focused/inactive style (`WebglRenderer.ts:479-486`). `RectangleRenderer.updateCursor`
(`:245-308`) handles `bar` (width = `dpr * cursorWidth`), `underline` (width =
`cursor.width * cellWidth` — i.e. spans wide cells), and `outline` (the inactive
hollow box, all four edges).

**Ours:** `_pushCursor` (`WebgpuRenderer.ts:461-486`): bar width is hardcoded
`2*dpr` (ignores `cursorWidth`); underline width is one cell (ignores wide-cell
`cell.getWidth()`); block inversion is inline (`_build:360-373`) and the unfocused
hollow outline is a manual 4-rect (`_pushRectOutline:489-495`) — but only for
`block`, and there's no `outline`/`bar`/`underline` **inactive** style mapping
(`cursorInactiveStyle` is never read; the addon doesn't pass it). `cursorWidth`
and `cursorInactiveStyle` options aren't in `IRenderMetrics`.

**Fix:** add `cursorWidth` and `cursorInactiveStyle` to metrics; honor them; use
`cell.getWidth()` for block/underline width on wide cells. (The true block
inversion at `:360-377` is a genuine improvement over WebGL's translucent fill and
was already fixed per commit `c2c358e` — ✓ keep it.)

---

### 34. clearTextureAtlas doesn't request a redraw — VISUALLY-WRONG (ties to #1)

**Ref:** `WebglRenderer.clearTextureAtlas` (`:307-311`) clears the atlas, clears
the model, **and `_requestRedrawViewport()`**.

**Ours:** `clearTextureAtlas` (`WebgpuRenderer.ts:283-287`) clears the atlas and
marks dirty but doesn't fire a redraw (#1). After an atlas clear nothing repaints
until other content changes. Folds into the #1 fix.

---

### 36. logService / setTraceLogger not wired — MISSING-FEATURE (minor)

**Ref:** `WebglAddon.ts:66,71` grabs `_logService` and calls `setTraceLogger`.
**Ours:** not grabbed. No functional impact beyond missing trace logs.

---

### 38. Canvas/screen sizing + cell-from-charSize — ✓ HANDLED

The gap that prompted this audit is correctly mirrored. `_applyMetrics`
(`WebgpuRenderer.ts:213-236`) sets the canvas backing store, the canvas CSS size
(rounded `w/dpr`), **and** the `.xterm-screen` element CSS size — matching
`WebglRenderer.ts:184-192`. Cell dims derive from `charSizeService × dpr ×
lineHeight (+ letterSpacing)` in `WebgpuAddon._charDims` (`:146-171`), matching
`WebglRenderer._updateDimensions` (`:558-607`) for the default lineHeight=1/
letterSpacing=0 case. The `dimensions` getter (`:187-205`) reports css/device
canvas + cell correctly. **Caveat:** the `char.top`/`char.left` offsets are zeroed
(#27) and the values are snapshotted, not live (#2/#28).

---

## Internal handles: which the addon grabs vs misses

WebGL grabs (`WebglAddon.ts:57-67`): `coreService`, `optionsService`,
`_renderService`, `_characterJoinerService`, `_charSizeService`,
`_coreBrowserService`, `_decorationService`, `_logService`, `_themeService`.

OURS grabs (read ad-hoc inside `WebgpuAddon._charDims`/`_buildMetrics`/
`_buildPalette`/`_installRenderer`): `_renderService` (for setRenderer/handleResize),
`_charSizeService` (read once), `_coreBrowserService` (dpr + isFocused, read once),
`optionsService` (rawOptions, read once), `_themeService` (colors, read once).

**Missed entirely:** `_decorationService` (#5), `_characterJoinerService` (#17),
`coreService` (cursor blink/style live state, `decPrivateModes` — #2/#3),
`_logService` (#36). And the ones it does read are **read once, not subscribed**
(#2) — the core defect.

---

## Recommended fix order

1. **#1 `onRequestRedraw` wiring** — unblocks blink, focus, selection, atlas-clear
   redraws. Cheap, high impact.
2. **#2 live service subscriptions + `setMetrics`** — theme/option/font/focus
   updates. The structural fix that several others depend on.
3. **#6/#37 dispose restores default renderer + disposed guard** — prevents blank
   terminal on teardown.
4. **#3/#4 cursor blink + handleCursorMove** — port `CursorBlinkStateManager`.
5. **#5 decoration overrides** — search/find/link highlights.
6. **#7 deferred-attach retry** — first-paint robustness for hidden tabs.
7. **#12/#13/#14 contrast + bright-bold + dim-as-color** — readability/correctness.
8. **#15/#16 custom glyphs** — box-drawing/powerline (large port; high visual
   payoff for TUIs).
9. Remaining VISUALLY-WRONG (#8–11, #18–27, #33) and PERF (#30–32, #35).
