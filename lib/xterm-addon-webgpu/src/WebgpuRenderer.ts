/**
 * The WebGPU renderer. Implements xterm's `IRenderer` surface and draws the
 * visible viewport each frame in three instanced passes:
 *
 *   1. rectangles  — non-default cell backgrounds + selection
 *   2. glyphs      — textured cells from the shared atlas
 *   3. decorations — underlines / strikethrough
 *   (+ cursor, drawn as a rectangle)
 *
 * The xterm-internal plumbing (grabbing char metrics, theme colors, dpr) lives
 * in {@link WebgpuAddon}; this class takes those as injected {@link IRenderMetrics}
 * plus a buffer accessor, which also lets `smoke.html` drive it with synthetic
 * data and no real terminal.
 *
 * Phase-1 scope: the whole viewport is rebuilt every render call. {@link DamageTracker}
 * is wired for the Phase-2 partial-rebuild optimization but not yet consulted to
 * skip rows.
 */
import type { SharedDevice } from "./shared/SharedDevice.js";
import type { IRenderDimensions, IGlyphKey } from "./types.js";
import type { Palette } from "./util/colorUtils.js";
import type { IXtermBuffer, IXtermDecorationService } from "./model/xtermTypes.js";
import { rgbaToFloats } from "./util/colorUtils.js";
import { CellColorResolver, type IResolveInput } from "./model/CellColorResolver.js";
import { DamageTracker } from "./model/DamageTracker.js";
import { InstanceStager } from "./model/InstanceStager.js";
import { readCell, emptyReadCell, type IReadCell } from "./model/CellReader.js";
import { normalizeSelection, isCellInSelection, type Selection } from "./model/selection.js";
import { viewportCursorRow } from "./util/cursorViewport.js";
import { extractUnderlineStyle, FgFlags, NULL_CELL_CODE, UnderlineStyle } from "./util/attributes.js";
import { Emitter, type Event } from "./util/event.js";
import { linkUnderlineSpans } from "./util/linkUnderlineSpans.js";

export type CursorStyle = "block" | "underline" | "bar";

/**
 * The hovered-link underline span, as emitted by xterm's
 * `_linkifier2.onShowLinkUnderline`. Coordinates are viewport-relative cells:
 * (x1,y1) start, (x2,y2) end, `cols` the terminal width, `fg` an optional
 * color (256-palette index) — undefined means the default foreground.
 */
export interface ILinkUnderlineEvent {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cols: number;
  fg?: number;
}

export interface IRenderMetrics {
  cols: number;
  rows: number;
  /** Cell size in device pixels. */
  deviceCellWidth: number;
  deviceCellHeight: number;
  /** Device px from the cell top to the text baseline (where glyphs sit). */
  baseline: number;
  /** Device px from the baseline to the deepest descender (p, g, y, etc.). */
  descent: number;
  devicePixelRatio: number;
  palette: Palette;
  focused: boolean;
  cursorVisible: boolean;
  cursorStyle: CursorStyle;
  /** Whether the cursor should blink (xterm's cursorBlink option). */
  cursorBlink: boolean;
}

const GLYPH_FLOATS = 16;
const RECT_FLOATS = 8;
const DECOR_FLOATS = 12;

/** A growable storage buffer paired with its group(1) bind group. */
class StorageBufferSlot {
  public buffer?: GPUBuffer;
  public bindGroup?: GPUBindGroup;
  private _capacity = 0;

  constructor(
    private readonly _device: GPUDevice,
    private readonly _layout: GPUBindGroupLayout,
    private readonly _label: string,
  ) {}

  /** Ensure the buffer can hold `byteLength`, then upload `data`. */
  public upload(data: Float32Array, byteLength: number): void {
    if (byteLength === 0) {
      return;
    }
    if (!this.buffer || byteLength > this._capacity) {
      this._capacity = Math.max(byteLength, this._capacity * 2, 1024);
      // Storage buffer size must be a multiple of 4; round up.
      this._capacity = Math.ceil(this._capacity / 4) * 4;
      this.buffer?.destroy();
      this.buffer = this._device.createBuffer({
        label: this._label,
        size: this._capacity,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bindGroup = this._device.createBindGroup({
        label: `${this._label}:bg`,
        layout: this._layout,
        entries: [{ binding: 0, resource: { buffer: this.buffer } }],
      });
    }
    this._device.queue.writeBuffer(this.buffer, 0, data.buffer, data.byteOffset, byteLength);
  }

  public dispose(): void {
    this.buffer?.destroy();
    this.buffer = undefined;
    this.bindGroup = undefined;
  }
}

export class WebgpuRenderer {
  private readonly _device: GPUDevice;
  private readonly _ctx: GPUCanvasContext;
  private _metrics: IRenderMetrics;

  private readonly _viewportBuffer: GPUBuffer;
  private readonly _sampler: GPUSampler;
  private _glyphSharedBindGroup: GPUBindGroup;
  private readonly _viewportOnlyBindGroup: GPUBindGroup;

  private readonly _rectSlot: StorageBufferSlot;
  private readonly _glyphSlot: StorageBufferSlot;
  private readonly _decorSlot: StorageBufferSlot;

  private readonly _rectStager = new InstanceStager(RECT_FLOATS);
  private readonly _glyphStager = new InstanceStager(GLYPH_FLOATS);
  private readonly _decorStager = new InstanceStager(DECOR_FLOATS);

  private readonly _colorResolver = new CellColorResolver();
  private readonly _damage = new DamageTracker();
  private readonly _scratchCell: IReadCell = emptyReadCell();
  /** Reused per cell to avoid allocating a resolve-input object every cell. */
  private readonly _resolveInput: IResolveInput = { fg: 0, bg: 0, selected: false, focused: true };
  /** Active selection in absolute buffer coordinates; null when none. */
  private _selection: Selection | null = null;
  /** xterm's reusable cell object, captured on first read to avoid per-cell GC. */
  private _reusableXtermCell?: import("./model/xtermTypes.js").IXtermBufferCell;
  /** Cursor blink state: true = cursor visible this phase. */
  private _cursorBlinkOn = true;
  /**
   * Active hovered-link underline span (fg pre-resolved to RGBA), or null.
   * xterm draws link hover underlines via `onShowLinkUnderline`; unlike WebGL's
   * built-in link render layer, our renderer has to draw them itself.
   */
  private _linkUnderline: { x1: number; y1: number; x2: number; y2: number; cols: number; fgRgba: number } | null = null;
  private _blinkTimer?: ReturnType<typeof setInterval>;
  /**
   * Vertical band (device px, cell-local) that cell backgrounds fill — taken
   * from the FULL BLOCK glyph U+2588, the font's reference for a fully-inked
   * cell. Backgrounds use this instead of the full line-box height so a block
   * character and its background share the same extent (aligned), and the
   * font's line-gap stays as inter-line spacing rather than being painted.
   */
  private _fillTop = 0;
  private _fillHeight = 0;

  private readonly _onRequestRedraw = new Emitter<{ start: number; end: number }>();
  public readonly onRequestRedraw: Event<{ start: number; end: number }> = this._onRequestRedraw.event;

  private _disposed = false;

  constructor(
    private readonly _canvas: HTMLCanvasElement,
    private readonly _shared: SharedDevice,
    private readonly _getBuffer: () => IXtermBuffer | undefined,
    metrics: IRenderMetrics,
    /**
     * xterm's `.xterm-screen` element. When provided, the renderer sizes it to
     * match the canvas's CSS dimensions so xterm's mouse → cell hit-testing
     * (which reads back `renderService.dimensions`) lines up with the rendered
     * grid. Omitted in the standalone smoke harness.
     */
    private readonly _screenElement: HTMLElement | null = null,
    /** xterm's decoration service — per-cell fg/bg overrides (search highlights, etc.). */
    private readonly _decorationService: IXtermDecorationService | null = null,
  ) {
    this._device = _shared.device;
    this._metrics = metrics;

    const ctx = _canvas.getContext("webgpu");
    if (!ctx) {
      throw new Error("WebgpuRenderer: failed to acquire a 'webgpu' canvas context");
    }
    this._ctx = ctx;
    this._ctx.configure({ device: this._device, format: _shared.format, alphaMode: "opaque" });

    this._viewportBuffer = this._device.createBuffer({
      label: "webgpu-term:viewport",
      size: 16, // vec2<f32> resolution, padded to 16
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._sampler = this._device.createSampler({
      label: "webgpu-term:atlasSampler",
      magFilter: "nearest",
      minFilter: "nearest",
    });

    this._glyphSharedBindGroup = this._makeGlyphSharedBindGroup();
    this._viewportOnlyBindGroup = this._device.createBindGroup({
      label: "webgpu-term:viewportOnlyBG",
      layout: _shared.layouts.viewportOnly,
      entries: [{ binding: 0, resource: { buffer: this._viewportBuffer } }],
    });

    this._rectSlot = new StorageBufferSlot(this._device, _shared.layouts.instanceStorage, "webgpu-term:rects");
    this._glyphSlot = new StorageBufferSlot(this._device, _shared.layouts.instanceStorage, "webgpu-term:glyphs");
    this._decorSlot = new StorageBufferSlot(this._device, _shared.layouts.instanceStorage, "webgpu-term:decors");

    this._applyMetrics();
    this._updateBlink();
  }

  private _makeGlyphSharedBindGroup(): GPUBindGroup {
    return this._device.createBindGroup({
      label: "webgpu-term:glyphSharedBG",
      layout: this._shared.layouts.glyphShared,
      entries: [
        { binding: 0, resource: { buffer: this._viewportBuffer } },
        { binding: 1, resource: this._sampler },
        { binding: 2, resource: this._shared.atlas.textureView },
      ],
    });
  }

  // --- IRenderer surface -----------------------------------------------------

  public get dimensions(): IRenderDimensions {
    const m = this._metrics;
    const dpr = m.devicePixelRatio || 1;
    const deviceCanvasW = m.cols * m.deviceCellWidth;
    const deviceCanvasH = m.rows * m.deviceCellHeight;
    return {
      css: {
        // Round the canvas to whole CSS px (xterm does the same) so the screen
        // element and the mouse → cell math agree.
        canvas: { width: Math.round(deviceCanvasW / dpr), height: Math.round(deviceCanvasH / dpr) },
        cell: { width: m.deviceCellWidth / dpr, height: m.deviceCellHeight / dpr },
      },
      device: {
        canvas: { width: deviceCanvasW, height: deviceCanvasH },
        cell: { width: m.deviceCellWidth, height: m.deviceCellHeight },
        char: { width: m.deviceCellWidth, height: m.deviceCellHeight, top: 0, left: 0 },
      },
    };
  }

  public setMetrics(metrics: IRenderMetrics): void {
    this._metrics = metrics;
    this._applyMetrics();
    this._updateBlink();
    this._damage.markAllDirty();
    this._requestRedraw();
  }

  private _applyMetrics(): void {
    const m = this._metrics;
    const dpr = m.devicePixelRatio || 1;
    // Device-pixel backing store (what we render into).
    const w = Math.max(1, m.cols * m.deviceCellWidth);
    const h = Math.max(1, m.rows * m.deviceCellHeight);
    if (this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas.width = w;
      this._canvas.height = h;
    }
    // CSS display size, and — critically — size xterm's screen element to match
    // so its mouse → cell hit-testing aligns with what we draw. Mirrors
    // @xterm/addon-webgl's WebglRenderer.
    const cssW = Math.round(w / dpr);
    const cssH = Math.round(h / dpr);
    this._canvas.style.width = `${cssW}px`;
    this._canvas.style.height = `${cssH}px`;
    if (this._screenElement) {
      this._screenElement.style.width = `${cssW}px`;
      this._screenElement.style.height = `${cssH}px`;
    }
    this._device.queue.writeBuffer(this._viewportBuffer, 0, new Float32Array([w, h, 0, 0]));
    this._damage.resize(m.rows);
    this._computeCellFillBox();
  }

  /** Derive the cell-background fill band from the full-block glyph (U+2588). */
  private _computeCellFillBox(): void {
    let top = 0;
    let height = this._metrics.deviceCellHeight;
    try {
      const g = this._shared.atlas.getOrAllocate({ code: 0x2588, bg: 0, fg: 0, ext: 0 }, "█", false, false);
      if (g) {
        top = g.offset.y;
        height = g.size.y;
      }
    } catch {
      // Atlas/rasterizer not ready — fall back to the full cell.
    }
    this._fillTop = top;
    this._fillHeight = height;
  }

  /**
   * Ask xterm to schedule a repaint of the viewport. xterm's RenderService
   * subscribes to onRequestRedraw and calls back into renderRows. Visual-state
   * changes that don't alter buffer content (selection, focus, cursor, atlas
   * clear, resize) MUST fire this, or nothing repaints. Mirrors WebglRenderer's
   * _requestRedrawViewport.
   */
  private _requestRedraw(): void {
    this._onRequestRedraw.fire({ start: 0, end: Math.max(0, this._metrics.rows - 1) });
  }

  /**
   * (Re)configure cursor blinking. Blinks only when the option is on AND the
   * terminal is focused; otherwise the cursor is steady. Each tick flips
   * visibility and requests a redraw. A simplified CursorBlinkStateManager —
   * fixed interval, reset to visible on (re)start.
   */
  private _updateBlink(): void {
    if (this._blinkTimer !== undefined) {
      clearInterval(this._blinkTimer);
      this._blinkTimer = undefined;
    }
    this._cursorBlinkOn = true;
    if (this._metrics.cursorBlink && this._metrics.focused && !this._disposed) {
      this._blinkTimer = setInterval(() => {
        this._cursorBlinkOn = !this._cursorBlinkOn;
        this._requestRedraw();
      }, 530);
    }
  }

  public handleResize(cols: number, rows: number): void {
    this._metrics = { ...this._metrics, cols, rows };
    this._applyMetrics();
    this._requestRedraw();
  }

  public handleCharSizeChanged(): void {
    this._applyMetrics();
    this._requestRedraw();
  }

  public handleDevicePixelRatioChange(): void {
    this._applyMetrics();
    this._requestRedraw();
  }

  public handleBlur(): void {
    this._metrics = { ...this._metrics, focused: false };
    this._updateBlink(); // stop blinking while unfocused
    this._damage.markAllDirty();
    this._requestRedraw();
  }

  public handleFocus(): void {
    this._metrics = { ...this._metrics, focused: true };
    this._updateBlink(); // resume blinking, reset to visible
    this._damage.markAllDirty();
    this._requestRedraw();
  }

  /**
   * Receive a selection change from xterm. `start`/`end` are absolute buffer
   * coordinates `[col, row]` (end exclusive). Undefined clears the selection.
   * Matches xterm's `IRenderer.handleSelectionChanged` signature.
   */
  public handleSelectionChanged(
    start: [number, number] | undefined,
    end: [number, number] | undefined,
    columnSelectMode: boolean,
  ): void {
    this._selection = start && end ? normalizeSelection(start, end, columnSelectMode) : null;
    this._damage.markAllDirty();
    this._requestRedraw();
  }

  public handleCursorMove(): void {
    // Reset the blink so the cursor is solid right after it moves (xterm does
    // the same — typing shouldn't land mid-blink-off).
    this._updateBlink();
    this._damage.markAllDirty();
    this._requestRedraw();
  }

  public clear(): void {
    this._damage.markAllDirty();
    this._requestRedraw();
  }

  public clearTextureAtlas(): void {
    this._shared.atlas.clearTexture();
    // Atlas view object is stable across clears, so the bind group stays valid.
    this._damage.markAllDirty();
    this._requestRedraw();
  }

  public renderRows(start: number, end: number): void {
    if (this._disposed) {
      return;
    }
    this._damage.markRange(start, end);
    this._renderFrame();
  }

  // --- rendering -------------------------------------------------------------

  private _renderFrame(): void {
    const buffer = this._getBuffer();
    if (!buffer) {
      return;
    }
    this._build(buffer);
    // If the atlas reset mid-build, positions handed out earlier are stale —
    // rebuild once on the now-clean atlas.
    if (this._shared.atlas.consumeReset()) {
      this._build(buffer);
      this._shared.atlas.consumeReset();
    }
    this._draw();
    this._damage.clear();
  }

  private _build(buffer: IXtermBuffer): void {
    const m = this._metrics;
    const cellW = m.deviceCellWidth;
    const cellH = m.deviceCellHeight;
    const palette = m.palette;

    this._shared.atlas.beginFrame();
    this._rectStager.reset();
    this._glyphStager.reset();
    this._decorStager.reset();

    // Cursor cell (viewport-relative). `cursorPos` is the position regardless
    // of blink phase — used for bg-fill geometry so the cursor cell keeps the
    // same full-cell footprint across blink on/off (otherwise the off-phase
    // would fall back to the block-glyph-band partial fill, producing the
    // "two-size blink" artifact). `cursor` gates the actual cursor draw
    // (invert/outline), so it goes null when blinked off.
    //
    // xterm's `cursorY` is baseY-relative, not viewportY-relative — using it
    // raw "drags" the cursor with scrollback and lets subsequent PTY output
    // scribble over the visible historical buffer. Convert via the
    // canonical viewportCursorRow helper.
    const cursorRow = viewportCursorRow(buffer.cursorY, buffer.baseY, buffer.viewportY);
    const cursorVisibleOnScreen =
      m.cursorVisible &&
      cursorRow >= 0 && cursorRow < m.rows && buffer.cursorX >= 0 && buffer.cursorX < m.cols;
    const cursorPos = cursorVisibleOnScreen ? { row: cursorRow, col: buffer.cursorX } : null;
    const cursor = cursorVisibleOnScreen && this._cursorBlinkOn ? cursorPos : null;
    const blockCursor = cursorPos !== null && m.cursorStyle === "block";

    const top = buffer.viewportY;
    for (let row = 0; row < m.rows; row++) {
      const absRow = top + row;
      const line = buffer.getLine(absRow);
      if (!line) {
        continue;
      }
      const yPx = row * cellH;
      for (let col = 0; col < m.cols; col++) {
        const xtermCell = line.getCell(col, this._reusableXtermCell);
        if (!xtermCell) {
          continue;
        }
        if (!this._reusableXtermCell) {
          this._reusableXtermCell = xtermCell; // capture for reuse
        }
        const cell = readCell(xtermCell, this._scratchCell);
        if (cell.width === 0) {
          continue; // wide-char trailing spacer
        }
        const xPx = col * cellW;

        const ri = this._resolveInput;
        ri.fg = cell.fg;
        ri.bg = cell.bg;
        ri.selected = isCellInSelection(col, absRow, this._selection);
        ri.focused = m.focused;
        ri.decorationBottomBg = ri.decorationBottomFg = ri.decorationTopBg = ri.decorationTopFg = undefined;
        if (this._decorationService) {
          this._gatherDecorations(ri, col, absRow);
        }
        const resolved = this._colorResolver.resolve(ri, palette);

        const isCursorCell = cursorPos !== null && cursorPos.row === row && cursorPos.col === col;
        const invertForCursor = isCursorCell && blockCursor && m.focused && cursor !== null;
        // Unfocused block cursor renders as a hollow outline. We suppress the
        // cell's bg fill in that case so the outline stands out against the
        // terminal background instead of getting camouflaged by a TUI-painted
        // bg whose color happens to be close to palette.cursor.
        const unfocusedOutline = isCursorCell && blockCursor && !m.focused;

        // Background. A focused block cursor paints the cell in the cursor
        // color and the glyph gets inverted to the accent color below (true
        // inversion, not a translucent overlay). Otherwise skip the default bg.
        const bgColor = invertForCursor ? m.palette.cursor : resolved.bg;
        if (bgColor !== palette.background && !unfocusedOutline) {
          // A focused block cursor and a selection fill the whole cell (they're
          // continuous UI highlights). The cursor cell also fills full-height
          // on its blink-OFF phase — otherwise its TUI-painted bg renders as a
          // smaller block-glyph band, producing a "two-size blink" (big bright
          // cursor / small dim band) instead of a clean toggle. Non-cursor
          // cells keep the block-glyph-band fill so the font's line-gap stays
          // as inter-line spacing rather than getting painted.
          if (invertForCursor || ri.selected || isCursorCell) {
            this._pushRect(xPx, yPx, cellW, cellH, bgColor, 1);
          } else {
            this._pushRect(xPx, yPx + this._fillTop, cellW, this._fillHeight, bgColor, 1);
          }
        }
        if (unfocusedOutline) {
          this._pushRectOutline(xPx, yPx, cellW, cellH, m.palette.cursor);
        }

        // Glyph.
        if (cell.code !== NULL_CELL_CODE && cell.chars.length > 0 && cell.chars !== " ") {
          const glyphColor = invertForCursor ? m.palette.cursorAccent : resolved.fg;
          this._pushGlyph(cell, xPx, yPx, glyphColor, resolved.dim && !invertForCursor);
        }

        // Underline / strikethrough decorations.
        this._pushDecorations(cell, xPx, yPx, cellW, cellH, resolved.fg);
      }
    }

    this._pushCursor(buffer);
    this._pushLinkUnderline();
  }

  /**
   * Draw the hovered-link underline across its cell span. Mirrors WebGL's
   * link render layer: single-row links underline [x1, x2); multi-row links
   * underline [x1, cols) on the first row, full rows between, and [0, x2) on
   * the last. A no-op when nothing is hovered.
   */
  private _pushLinkUnderline(): void {
    const lu = this._linkUnderline;
    if (!lu) {
      return;
    }
    const m = this._metrics;
    const cellW = m.deviceCellWidth;
    const cellH = m.deviceCellHeight;
    const dpr = m.devicePixelRatio || 1;
    const stroke = Math.max(1, Math.round(dpr));
    const gap = Math.max(1, Math.round(dpr));
    // Anchor BELOW the descender region so the stroke clears p/g/y/etc. We
    // already know `descent` (device px from baseline to deepest descender);
    // sitting just under it keeps the underline off the glyphs even on tight
    // line-heights. Clamp to cell bottom so the stroke stays inside the cell.
    const belowDescender = m.baseline + m.descent + Math.max(1, Math.round(dpr / 2));
    const yInCell = Math.min(Math.max(belowDescender, m.baseline + gap), cellH - stroke);
    const periodPx = Math.max(4, Math.round(cellH * 0.5));
    const styleId = underlineStyleToShaderId(UnderlineStyle.SINGLE);
    const [r, g, b, a] = rgbaToFloats(lu.fgRgba);

    for (const span of linkUnderlineSpans(lu, m.rows, m.cols)) {
      const xPx = span.colStart * cellW;
      const w = (span.colEnd - span.colStart) * cellW;
      const yBand = span.row * cellH + yInCell;
      this._decorStager.push([xPx, yBand, w, stroke, r, g, b, a, styleId, periodPx, 0, 0]);
    }
  }

  /**
   * Show (or, with null, hide) the hovered-link underline. Driven by xterm's
   * `_linkifier2` show/hide events, which the addon forwards here. Triggers an
   * immediate redraw since a hover changes no buffer content.
   */
  public setLinkUnderline(e: ILinkUnderlineEvent | null): void {
    if (this._disposed) {
      return;
    }
    if (!e) {
      if (!this._linkUnderline) {
        return; // already clear — avoid a redundant repaint
      }
      this._linkUnderline = null;
    } else {
      const p = this._metrics.palette;
      const fgRgba =
        typeof e.fg === "number" && e.fg >= 0 && e.fg < 256 && p.ansi[e.fg] != null
          ? p.ansi[e.fg]
          : p.foreground;
      this._linkUnderline = { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, cols: e.cols, fgRgba };
      // Stash just the raw event coords for casual `window.__altLink` peeks.
      // Rich provider-side diagnostic lives in terminal.ts crossLineProvider
      // (window.__altLinks / __altLinksJSON()) so we can correlate the rendered
      // span with the library's range + a ground-truth cell walk.
      try {
        (window as unknown as { __altLink?: unknown }).__altLink = {
          x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, cols: e.cols,
        };
      } catch { /* diagnostic only */ }
    }
    this._renderFrame();
  }

  /** Read decoration-service fg/bg overrides for a cell into the resolve input. */
  private _gatherDecorations(ri: IResolveInput, col: number, absRow: number): void {
    const ds = this._decorationService!;
    ds.forEachDecorationAtCell(col, absRow, "bottom", (d) => {
      if (d.backgroundColorRGB) ri.decorationBottomBg = d.backgroundColorRGB.rgba >>> 0;
      if (d.foregroundColorRGB) ri.decorationBottomFg = d.foregroundColorRGB.rgba >>> 0;
    });
    ds.forEachDecorationAtCell(col, absRow, "top", (d) => {
      if (d.backgroundColorRGB) ri.decorationTopBg = d.backgroundColorRGB.rgba >>> 0;
      if (d.foregroundColorRGB) ri.decorationTopFg = d.foregroundColorRGB.rgba >>> 0;
    });
  }

  private _pushRect(x: number, y: number, w: number, h: number, rgba: number, alpha: number): void {
    const [r, g, b] = rgbaToFloats(rgba);
    this._rectStager.push([x, y, w, h, r, g, b, alpha]);
  }

  private _pushGlyph(cell: IReadCell, xPx: number, yPx: number, fgRgba: number, dim: boolean): void {
    const key: IGlyphKey = { code: cell.code, bg: cell.bg, fg: cell.fg, ext: cell.ext };
    const glyph = this._shared.atlas.getOrAllocate(key, cell.chars, cell.bold, cell.italic);
    if (!glyph) {
      return;
    }
    const page = this._shared.atlas.pageSize;
    const [r, g, b, a] = rgbaToFloats(fgRgba);
    // Half-texel inset: sample within [pos+0.5 .. pos+size-0.5] so nearest
    // filtering always lands on this glyph's own texels and never bleeds into
    // the adjacent glyph at the quad's far edge (the yellow-fragment artifact).
    const uvX = (glyph.texturePosition.x + 0.5) / page;
    const uvY = (glyph.texturePosition.y + 0.5) / page;
    const uvW = Math.max(0, glyph.size.x - 1) / page;
    const uvH = Math.max(0, glyph.size.y - 1) / page;
    this._glyphStager.push([
      xPx + glyph.offset.x,
      yPx + glyph.offset.y,
      glyph.size.x,
      glyph.size.y,
      uvX,
      uvY,
      uvW,
      uvH,
      r,
      g,
      b,
      dim ? a * 0.5 : a,
      glyph.layer,
      glyph.isColor ? 1 : 0,
      0,
      0,
    ]);
  }

  private _pushDecorations(
    cell: IReadCell,
    xPx: number,
    yPx: number,
    cellW: number,
    cellH: number,
    fgRgba: number,
  ): void {
    const [r, g, b, a] = rgbaToFloats(fgRgba);
    const dpr = this._metrics.devicePixelRatio || 1;
    // A 1px logical stroke; scales with DPR. (Real font underline-thickness
    // metrics would refine this; this is the cell-derived approximation.)
    const stroke = Math.max(1, Math.round(dpr));
    const gap = Math.max(1, Math.round(dpr));

    const us = extractUnderlineStyle(cell.ext);
    if (us !== UnderlineStyle.NONE) {
      const styleId = underlineStyleToShaderId(us);
      // Single/dashed: a thin stroke. Double needs room for two lines; curly
      // needs amplitude for the wave. The shader shapes within this band.
      let bandH = stroke;
      if (us === UnderlineStyle.DOUBLE) {
        bandH = stroke * 3;
      } else if (us === UnderlineStyle.CURLY) {
        bandH = Math.max(3 * dpr, Math.round(cellH * 0.12));
      }
      // Anchor BELOW the descender region (under p/g/y/etc.) so the stroke
      // doesn't intersect glyphs on tight line-heights. Falls back to
      // baseline+gap when descent is unusually small; clamps to keep the band
      // inside the cell.
      const m = this._metrics;
      const belowDescender = yPx + m.baseline + m.descent + Math.max(1, Math.round(dpr / 2));
      const baselinePlusGap = yPx + m.baseline + gap;
      const yBand = Math.min(Math.round(Math.max(belowDescender, baselinePlusGap)), Math.round(yPx + cellH - bandH));
      // periodPx drives dashed/curly; ~half a cell reads well.
      const periodPx = Math.max(4, Math.round(cellH * 0.5));
      this._decorStager.push([xPx, yBand, cellW, Math.round(bandH), r, g, b, a, styleId, periodPx, 0, 0]);
    }

    // Strikethrough — a thin stroke across the x-height midline.
    if (cell.fg & FgFlags.STRIKETHROUGH) {
      const yStrike = Math.round(yPx + cellH * 0.45);
      this._decorStager.push([xPx, yStrike, cellW, stroke, r, g, b, a, 4, cellW, 0, 0]);
    }
  }

  private _pushCursor(buffer: IXtermBuffer): void {
    const m = this._metrics;
    if (!m.cursorVisible || !this._cursorBlinkOn) {
      return;
    }
    // cursorY is baseY-relative; convert to viewport row so scrollback
    // doesn't drag the cursor (and subsequent PTY output) over visible
    // history. See util/cursorViewport.ts.
    const row = viewportCursorRow(buffer.cursorY, buffer.baseY, buffer.viewportY);
    const col = buffer.cursorX;
    if (row < 0 || row >= m.rows || col < 0 || col >= m.cols) {
      return;
    }
    const xPx = col * m.deviceCellWidth;
    const yPx = row * m.deviceCellHeight;
    // Block cursor is handled inline in _build (true inversion / outline).
    const barW = Math.max(1, Math.round(2 * m.devicePixelRatio));
    const lineH = Math.max(1, Math.round(2 * m.devicePixelRatio));
    switch (m.cursorStyle) {
      case "bar":
        this._pushRect(xPx, yPx, barW, m.deviceCellHeight, m.palette.cursor, 1);
        break;
      case "underline":
        this._pushRect(xPx, yPx + m.deviceCellHeight - lineH, m.deviceCellWidth, lineH, m.palette.cursor, 1);
        break;
      default:
        break; // block handled in _build
    }
  }

  /** Draw a hollow rectangle outline (unfocused block cursor). */
  private _pushRectOutline(x: number, y: number, w: number, h: number, rgba: number): void {
    const t = Math.max(1, Math.round(this._metrics.devicePixelRatio));
    this._pushRect(x, y, w, t, rgba, 1); // top
    this._pushRect(x, y + h - t, w, t, rgba, 1); // bottom
    this._pushRect(x, y, t, h, rgba, 1); // left
    this._pushRect(x + w - t, y, t, h, rgba, 1); // right
  }

  private _draw(): void {
    this._rectSlot.upload(this._rectStager.used, this._rectStager.usedByteLength);
    this._glyphSlot.upload(this._glyphStager.used, this._glyphStager.usedByteLength);
    this._decorSlot.upload(this._decorStager.used, this._decorStager.usedByteLength);

    const [cr, cg, cb] = rgbaToFloats(this._metrics.palette.background);
    const encoder = this._device.createCommandEncoder({ label: "webgpu-term:frame" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this._ctx.getCurrentTexture().createView(),
          clearValue: { r: cr, g: cg, b: cb, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    // 1. backgrounds + selection + cursor
    if (this._rectStager.count > 0 && this._rectSlot.bindGroup) {
      pass.setPipeline(this._shared.pipelines.rectangle);
      pass.setBindGroup(0, this._viewportOnlyBindGroup);
      pass.setBindGroup(1, this._rectSlot.bindGroup);
      pass.draw(6, this._rectStager.count);
    }

    // 2. glyphs
    if (this._glyphStager.count > 0 && this._glyphSlot.bindGroup) {
      pass.setPipeline(this._shared.pipelines.glyph);
      pass.setBindGroup(0, this._glyphSharedBindGroup);
      pass.setBindGroup(1, this._glyphSlot.bindGroup);
      pass.draw(6, this._glyphStager.count);
    }

    // 3. decorations
    if (this._decorStager.count > 0 && this._decorSlot.bindGroup) {
      pass.setPipeline(this._shared.pipelines.decoration);
      pass.setBindGroup(0, this._viewportOnlyBindGroup);
      pass.setBindGroup(1, this._decorSlot.bindGroup);
      pass.draw(6, this._decorStager.count);
    }

    pass.end();
    this._device.queue.submit([encoder.finish()]);
  }

  public dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    if (this._blinkTimer !== undefined) {
      clearInterval(this._blinkTimer);
      this._blinkTimer = undefined;
    }
    this._rectSlot.dispose();
    this._glyphSlot.dispose();
    this._decorSlot.dispose();
    this._viewportBuffer.destroy();
    this._onRequestRedraw.dispose();
    try {
      this._ctx.unconfigure();
    } catch {
      /* context may already be gone */
    }
  }
}

function underlineStyleToShaderId(us: UnderlineStyle): number {
  switch (us) {
    case UnderlineStyle.DOUBLE:
      return 1;
    case UnderlineStyle.CURLY:
      return 2;
    case UnderlineStyle.DASHED:
      return 3;
    case UnderlineStyle.DOTTED:
      return 3; // approximated as dashed in Phase 1
    case UnderlineStyle.SINGLE:
    default:
      return 0;
  }
}
