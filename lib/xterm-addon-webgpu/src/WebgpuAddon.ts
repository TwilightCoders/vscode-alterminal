/**
 * WebgpuAddon — an xterm.js `ITerminalAddon` that renders via WebGPU.
 *
 * Drop-in parity with `@xterm/addon-webgl`: `new WebgpuAddon()` works with no
 * arguments and exposes `onContextLoss` and `clearTextureAtlas`. The new
 * capability is the optional shared device — `new WebgpuAddon({ device })` —
 * which lets many terminals in one webview share a single `GPUDevice`, atlas
 * and pipelines (the O(windows) memory win).
 *
 * Unlike WebGL, a WebGPU device is acquired asynchronously. The addon kicks off
 * initialization in `activate()` and hot-swaps its renderer into xterm's render
 * service once the device is ready; until then xterm keeps whatever renderer it
 * already had (its DOM renderer), so there is no blank-screen gap. If WebGPU is
 * unavailable, the addon stays a no-op and the DOM renderer remains — a clean
 * fallback rather than an error.
 *
 * NOTE: like every xterm renderer addon (including the official WebGL one), the
 * render-service hookup reaches into xterm internals (`_core._renderService`,
 * `_charSizeService`, etc.). Those are version-sensitive; the `peerDependencies`
 * range pins the supported xterm versions.
 */
import { SharedDevice } from "./shared/SharedDevice.js";
import { WebgpuRenderer, type IRenderMetrics, type CursorStyle, type ILinkUnderlineEvent } from "./WebgpuRenderer.js";
import { isWebgpuSupported } from "./platform/deviceFeatures.js";
import { measureFont } from "./platform/fontMetrics.js";
import { DevicePixelObserver } from "./platform/DevicePixelObserver.js";
import { toRgba, type Palette } from "./util/colorUtils.js";
import { Emitter, type Event, type IDisposable } from "./util/event.js";
import type { IWebgpuAddonOptions, IFontAtlasConfig, ISharedDevice } from "./types.js";
import type { IXtermBuffer } from "./model/xtermTypes.js";

/** The minimal slice of the xterm `Terminal` we touch. */
interface IXtermTerminalLike {
  element?: HTMLElement;
  cols: number;
  rows: number;
  options: { cursorStyle?: string; cursorBlink?: boolean };
  buffer: { active: IXtermBuffer };
  // Internal handles (see NOTE above).
  _core?: unknown;
}

export class WebgpuAddon {
  private _terminal?: IXtermTerminalLike;
  private _renderer?: WebgpuRenderer;
  private _shared?: SharedDevice;
  private _ownsDevice = false;
  private _canvas?: HTMLCanvasElement;
  private _dprObserver?: DevicePixelObserver;
  private _deviceLostSub?: IDisposable;
  /** xterm event subscriptions (theme/options) to dispose on teardown. */
  private _subs: IDisposable[] = [];
  private _disposed = false;

  private readonly _onContextLoss = new Emitter<void>();
  public readonly onContextLoss: Event<void> = this._onContextLoss.event;

  constructor(private readonly _options: IWebgpuAddonOptions = {}) {}

  public activate(terminal: IXtermTerminalLike): void {
    this._terminal = terminal;
    if (!terminal.element) {
      // Terminal not opened yet — retry once it is. xterm exposes onWillOpen on
      // the core; fall back to a microtask poll if unavailable.
      const core = terminal._core as { onWillOpen?: (cb: () => void) => IDisposable } | undefined;
      if (core?.onWillOpen) {
        core.onWillOpen(() => this.activate(terminal));
        return;
      }
    }
    if (!isWebgpuSupported()) {
      // Leave xterm's existing renderer in place.
      return;
    }
    void this._initAsync(terminal);
  }

  private async _initAsync(terminal: IXtermTerminalLike): Promise<void> {
    try {
      const config = this._buildFontConfig(terminal);
      const injected = this._options.device as SharedDevice | undefined;
      if (injected) {
        this._shared = injected;
        this._ownsDevice = false;
      } else {
        this._shared = await SharedDevice.create(config);
        this._ownsDevice = true;
      }
      if (this._disposed) {
        if (this._ownsDevice) {
          this._shared.release();
        }
        return;
      }
      this._shared.acquire();

      const canvas = document.createElement("canvas");
      canvas.classList.add("xterm-webgpu-canvas");
      canvas.style.position = "absolute";
      canvas.style.top = "0";
      canvas.style.left = "0";
      // The canvas overlays .xterm-screen; without this it would swallow the
      // mouse and xterm's SelectionService would never see a drag (no
      // selection, no word-snap). Let events fall through to xterm's handlers.
      canvas.style.pointerEvents = "none";
      this._canvas = canvas;
      const screen = (terminal.element?.querySelector(".xterm-screen") ?? terminal.element ?? null) as HTMLElement | null;
      screen?.appendChild(canvas);

      const metrics = this._buildMetrics(terminal);
      const decorationService = ((terminal._core as Record<string, any>)?._decorationService ?? null) as
        | import("./model/xtermTypes.js").IXtermDecorationService
        | null;
      this._renderer = new WebgpuRenderer(
        canvas,
        this._shared,
        () => this._terminal?.buffer.active,
        metrics,
        screen,
        decorationService,
      );

      this._deviceLostSub = this._shared.onDeviceLost(() => {
        this._onContextLoss.fire();
      });
      // A DPR change alters cell dimensions, so re-measure rather than just
      // poking the old metrics.
      this._dprObserver = new DevicePixelObserver(() => this._refreshFont());

      this._installRenderer(terminal, this._renderer);
      this._subscribeToState(terminal);
      this._subscribeToLinks(terminal);
    } catch {
      // WebGPU init failed — stay a no-op so the DOM renderer keeps working.
      this._onContextLoss.fire();
    }
  }

  /** Hook the renderer into xterm's render service (internal API). */
  private _installRenderer(terminal: IXtermTerminalLike, renderer: WebgpuRenderer): void {
    const core = terminal._core as { _renderService?: { setRenderer(r: unknown): void; handleResize(c: number, r: number): void } };
    const renderService = core?._renderService;
    if (!renderService) {
      return;
    }
    renderService.setRenderer(renderer as unknown);
    renderService.handleResize(terminal.cols, terminal.rows);
  }

  /**
   * Subscribe to the live xterm state the renderer depends on. Without this the
   * renderer would keep the theme/font/cursor it had at activation forever (the
   * "snapshot once" defect). Mirrors what WebglRenderer does internally, but
   * from the addon since our renderer holds no xterm service handles.
   */
  private _subscribeToState(terminal: IXtermTerminalLike): void {
    const core = terminal._core as Record<string, any> | undefined;
    const theme = core?._themeService;
    const opts = core?.optionsService;
    if (theme?.onChangeColors) {
      this._subs.push(theme.onChangeColors(() => this._refreshColors()));
    }
    if (opts?.onOptionChange) {
      this._subs.push(opts.onOptionChange(() => this._refreshFont()));
    }
  }

  /**
   * Subscribe to xterm's link hover underline events. WebGL's renderer has a
   * built-in link render layer; ours doesn't, so without this links are
   * detected (Cmd+click works) but never underlined. `_linkifier2` is internal
   * (see NOTE at top); guard for its absence.
   */
  private _subscribeToLinks(terminal: IXtermTerminalLike): void {
    const core = terminal._core as Record<string, any> | undefined;
    // `_core.linkifier` is the public getter the WebGL addon uses to reach the
    // Linkifier2 (the instance that fires onShow/HideLinkUnderline). The
    // `_linkifier2` fallbacks guard against version drift.
    const linkifier = core?.linkifier ?? core?._linkifier2 ?? core?.linkifier2;
    if (!linkifier?.onShowLinkUnderline || !linkifier?.onHideLinkUnderline) {
      return;
    }
    this._subs.push(
      linkifier.onShowLinkUnderline((e: ILinkUnderlineEvent) => this._renderer?.setLinkUnderline(e)),
    );
    this._subs.push(
      linkifier.onHideLinkUnderline(() => this._renderer?.setLinkUnderline(null)),
    );
  }

  /** Theme changed — push a fresh palette (no atlas clear; glyphs are untinted). */
  private _refreshColors(): void {
    if (this._terminal && this._renderer) {
      this._renderer.setMetrics(this._buildMetrics(this._terminal));
    }
  }

  /**
   * Font/size/lineHeight/letterSpacing/cursor or DPR changed — re-measure the
   * font (new baseline), clear the shared atlas, and push fresh metrics.
   */
  private _refreshFont(): void {
    if (this._terminal && this._renderer && this._shared) {
      this._shared.updateFontConfig(this._buildFontConfig(this._terminal));
      this._renderer.setMetrics(this._buildMetrics(this._terminal));
    }
  }

  /**
   * Compute device cell dimensions the way xterm's own renderers do — from
   * charSizeService × dpr × lineHeight (+ letterSpacing) — so the grid we draw
   * matches the dimensions xterm uses for mouse → cell hit-testing. The glyph
   * baseline comes from the font's ascent, centered within that cell height.
   */
  private _charDims(terminal: IXtermTerminalLike) {
    const core = terminal._core as Record<string, any> | undefined;
    const dpr = core?._coreBrowserService?.dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio : 1) ?? 1;
    const cs = core?._charSizeService ?? { width: 9, height: 17 };
    const opts = core?.optionsService?.rawOptions ?? {};
    const fontFamily = opts.fontFamily ?? "monospace";
    const fontSize = opts.fontSize ?? 14;
    const lineHeight = opts.lineHeight ?? 1;
    const letterSpacing = opts.letterSpacing ?? 0;

    const deviceCharWidth = Math.floor((cs.width || 9) * dpr);
    const deviceCharHeight = Math.ceil((cs.height || 17) * dpr);
    const deviceCellHeight = Math.floor(deviceCharHeight * lineHeight);
    const deviceCellWidth = deviceCharWidth + Math.round(letterSpacing);

    // Baseline: the font's ascent, with any line-height leading split evenly.
    const fm = measureFont(fontFamily, fontSize * dpr, lineHeight);
    const leading = deviceCellHeight - (fm.ascent + fm.descent);
    const baseline = Math.round(fm.ascent + leading / 2);

    return {
      dpr, fontFamily, fontSize, fontWeight: opts.fontWeight ?? "normal",
      fontWeightBold: opts.fontWeightBold ?? "bold", letterSpacing, lineHeight,
      deviceCharWidth, deviceCharHeight, deviceCellWidth, deviceCellHeight, baseline,
    };
  }

  private _buildFontConfig(terminal: IXtermTerminalLike): IFontAtlasConfig {
    const d = this._charDims(terminal);
    return {
      fontFamily: d.fontFamily,
      fontSize: d.fontSize,
      fontWeight: d.fontWeight,
      fontWeightBold: d.fontWeightBold,
      letterSpacing: d.letterSpacing,
      lineHeight: d.lineHeight,
      devicePixelRatio: d.dpr,
      deviceCellWidth: d.deviceCellWidth,
      deviceCellHeight: d.deviceCellHeight,
      deviceCharWidth: d.deviceCharWidth,
      deviceCharHeight: d.deviceCharHeight,
      baseline: d.baseline,
      palette: this._buildPalette(terminal),
    };
  }

  private _buildMetrics(terminal: IXtermTerminalLike): IRenderMetrics {
    const core = terminal._core as Record<string, any> | undefined;
    const d = this._charDims(terminal);
    const focused = core?._coreBrowserService?.isFocused ?? true;
    const opts = core?.optionsService?.rawOptions ?? {};
    const cursorStyle = (terminal.options.cursorStyle as CursorStyle) ?? "block";
    return {
      cols: terminal.cols,
      rows: terminal.rows,
      deviceCellWidth: d.deviceCellWidth,
      deviceCellHeight: d.deviceCellHeight,
      devicePixelRatio: d.dpr,
      palette: this._buildPalette(terminal),
      focused,
      cursorVisible: opts.cursorInactiveStyle !== "none" || focused,
      cursorStyle,
      cursorBlink: !!(terminal.options.cursorBlink ?? opts.cursorBlink),
    };
  }

  private _buildPalette(terminal: IXtermTerminalLike): Palette {
    const core = terminal._core as Record<string, any> | undefined;
    const colors = core?._themeService?.colors;
    if (!colors) {
      // Sensible dark default if the theme service isn't reachable.
      const ansi: number[] = [];
      for (let i = 0; i < 256; i++) ansi.push(toRgba(i, i, i));
      return {
        foreground: toRgba(0xd0, 0xd0, 0xd0),
        background: toRgba(0x1e, 0x1e, 0x1e),
        cursor: toRgba(0xff, 0xff, 0xff),
        cursorAccent: toRgba(0, 0, 0),
        selectionBackground: toRgba(0x26, 0x4f, 0x78, 0xff),
        ansi,
      };
    }
    const ansi: number[] = (colors.ansi ?? []).map((c: { rgba: number }) => c.rgba >>> 0);
    while (ansi.length < 256) ansi.push(toRgba(0, 0, 0));
    return {
      foreground: (colors.foreground?.rgba ?? toRgba(0xd0, 0xd0, 0xd0)) >>> 0,
      background: (colors.background?.rgba ?? toRgba(0x1e, 0x1e, 0x1e)) >>> 0,
      cursor: (colors.cursor?.rgba ?? toRgba(0xff, 0xff, 0xff)) >>> 0,
      cursorAccent: (colors.cursorAccent?.rgba ?? toRgba(0, 0, 0)) >>> 0,
      selectionBackground: (colors.selectionBackgroundOpaque?.rgba ?? toRgba(0x26, 0x4f, 0x78, 0xff)) >>> 0,
      ansi,
    };
  }

  /** Matches WebglAddon's API; there is no HTMLCanvasElement atlas in WebGPU. */
  public get textureAtlas(): HTMLCanvasElement | undefined {
    return undefined;
  }

  public clearTextureAtlas(): void {
    this._renderer?.clearTextureAtlas();
  }

  public dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    for (const sub of this._subs) {
      sub.dispose();
    }
    this._subs = [];
    this._dprObserver?.dispose();
    this._deviceLostSub?.dispose();
    this._renderer?.dispose();
    this._canvas?.remove();

    // Restore xterm's default renderer so the Terminal keeps working after the
    // addon unloads (mirrors WebglAddon) — otherwise it's left with no renderer
    // and goes blank. Guarded against an already-disposed core.
    try {
      const core = this._terminal?._core as {
        _store?: { _isDisposed?: boolean };
        _renderService?: { setRenderer(r: unknown): void; handleResize(c: number, r: number): void };
        _createRenderer?: () => unknown;
      } | undefined;
      if (core && !core._store?._isDisposed && core._renderService && core._createRenderer) {
        core._renderService.setRenderer(core._createRenderer());
        core._renderService.handleResize(this._terminal!.cols, this._terminal!.rows);
      }
    } catch {
      /* terminal already torn down */
    }

    if (this._shared && this._ownsDevice) {
      this._shared.release();
    }
    this._onContextLoss.dispose();
  }
}

export type { ISharedDevice };
