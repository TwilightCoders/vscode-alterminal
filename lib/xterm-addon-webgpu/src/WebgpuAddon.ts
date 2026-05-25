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
import { WebgpuRenderer, type IRenderMetrics, type CursorStyle } from "./WebgpuRenderer.js";
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
      this._canvas = canvas;
      const screen = terminal.element?.querySelector(".xterm-screen") ?? terminal.element;
      screen?.appendChild(canvas);

      const metrics = this._buildMetrics(terminal);
      this._renderer = new WebgpuRenderer(canvas, this._shared, () => this._terminal?.buffer.active, metrics);

      this._deviceLostSub = this._shared.onDeviceLost(() => {
        this._onContextLoss.fire();
      });
      this._dprObserver = new DevicePixelObserver(() => this._renderer?.handleDevicePixelRatioChange());

      this._installRenderer(terminal, this._renderer);
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

  private _buildFontConfig(terminal: IXtermTerminalLike): IFontAtlasConfig {
    const core = terminal._core as Record<string, any> | undefined;
    const dpr = core?._coreBrowserService?.dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio : 1) ?? 1;
    const css = core?._charSizeService ?? { width: 9, height: 17 };
    const opts = core?.optionsService?.rawOptions ?? {};
    const fontFamily = opts.fontFamily ?? "monospace";
    const fontSize = opts.fontSize ?? 14;
    const lineHeight = opts.lineHeight ?? 1;
    // Derive cell box + baseline from the font itself (see fontMetrics). xterm's
    // charSizeService width is used for the advance when available, but the
    // baseline and height come from the font's ascent/descent.
    const fm = measureFont(fontFamily, fontSize * dpr, lineHeight);
    const deviceCellWidth = css.width ? Math.max(1, Math.round(css.width * dpr)) : fm.cellWidth;
    const deviceCellHeight = fm.cellHeight;
    return {
      fontFamily,
      fontSize,
      fontWeight: opts.fontWeight ?? "normal",
      fontWeightBold: opts.fontWeightBold ?? "bold",
      letterSpacing: opts.letterSpacing ?? 0,
      lineHeight,
      devicePixelRatio: dpr,
      deviceCellWidth,
      deviceCellHeight,
      deviceCharWidth: deviceCellWidth,
      deviceCharHeight: deviceCellHeight,
      baseline: fm.baseline,
      palette: this._buildPalette(terminal),
    };
  }

  private _buildMetrics(terminal: IXtermTerminalLike): IRenderMetrics {
    const core = terminal._core as Record<string, any> | undefined;
    const dpr = core?._coreBrowserService?.dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio : 1) ?? 1;
    const css = core?._charSizeService ?? { width: 9, height: 17 };
    const opts = core?.optionsService?.rawOptions ?? {};
    const focused = core?._coreBrowserService?.isFocused ?? true;
    const cursorStyle = (terminal.options.cursorStyle as CursorStyle) ?? "block";
    // Cell box derived from the font (must match _buildFontConfig so the
    // rasterizer's baseline and the renderer's grid agree).
    const fm = measureFont(opts.fontFamily ?? "monospace", (opts.fontSize ?? 14) * dpr, opts.lineHeight ?? 1);
    return {
      cols: terminal.cols,
      rows: terminal.rows,
      deviceCellWidth: css.width ? Math.max(1, Math.round(css.width * dpr)) : fm.cellWidth,
      deviceCellHeight: fm.cellHeight,
      devicePixelRatio: dpr,
      palette: this._buildPalette(terminal),
      focused,
      cursorVisible: true,
      cursorStyle,
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
    this._dprObserver?.dispose();
    this._deviceLostSub?.dispose();
    this._renderer?.dispose();
    this._canvas?.remove();
    if (this._shared && this._ownsDevice) {
      this._shared.release();
    }
    this._onContextLoss.dispose();
  }
}

export type { ISharedDevice };
