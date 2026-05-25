/**
 * Rasterizes a single glyph (or combined-char cluster) to pixels using a 2D
 * canvas, ready for upload into the atlas texture.
 *
 * Grayscale glyphs are drawn white-on-transparent so coverage lands in the
 * alpha channel and the shader can tint them with any foreground color. Color
 * glyphs (emoji, some symbols) keep their own RGBA and are flagged so the
 * shader skips tinting.
 */
import type { IFontAtlasConfig } from "../types.js";

export interface IRasterizedImage {
  imageData: ImageData;
  width: number;
  height: number;
  /** True when the glyph carries intrinsic color (emoji, etc.). */
  isColor: boolean;
}

/** Minimal 2D context surface we rely on — eases testing/mocking. */
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export class GlyphRasterizer {
  private _canvas: OffscreenCanvas;
  private _ctx: Ctx2D;

  constructor(private _config: IFontAtlasConfig) {
    // A generously sized scratch surface — two cells wide to fit wide glyphs.
    const w = Math.ceil(_config.deviceCellWidth * 2) || 32;
    const h = Math.ceil(_config.deviceCellHeight) || 32;
    this._canvas = new OffscreenCanvas(w, h);
    const ctx = this._canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("GlyphRasterizer: failed to acquire 2D context");
    }
    this._ctx = ctx as Ctx2D;
  }

  public updateConfig(config: IFontAtlasConfig): void {
    this._config = config;
    const w = Math.ceil(config.deviceCellWidth * 2) || 32;
    const h = Math.ceil(config.deviceCellHeight) || 32;
    if (w !== this._canvas.width || h !== this._canvas.height) {
      this._canvas.width = w;
      this._canvas.height = h;
    }
  }

  private _fontString(bold: boolean, italic: boolean): string {
    const c = this._config;
    const weight = bold ? c.fontWeightBold : c.fontWeight;
    const style = italic ? "italic " : "";
    // Font size is in device pixels (config already multiplied by DPR).
    return `${style}${weight} ${c.fontSize * c.devicePixelRatio}px ${c.fontFamily}`;
  }

  /**
   * Rasterize the given text (usually one character) with the given style.
   * Returns null for whitespace / empty content (nothing to draw).
   */
  public rasterize(text: string, bold: boolean, italic: boolean): IRasterizedImage | null {
    if (text.length === 0 || text === " ") {
      return null;
    }
    const ctx = this._ctx;
    const w = this._canvas.width;
    const h = this._canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.font = this._fontString(bold, italic);
    ctx.textBaseline = "top";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, 0, 0);

    const imageData = ctx.getImageData(0, 0, w, h);
    const isColor = this._detectColor(imageData.data);
    return { imageData, width: w, height: h, isColor };
  }

  /**
   * A glyph is "color" if any painted pixel has channel divergence — i.e. it
   * isn't pure white. White-on-transparent grayscale text always has r=g=b=255,
   * so any deviation signals an intrinsically-colored glyph (emoji).
   */
  private _detectColor(data: Uint8ClampedArray): boolean {
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a === 0) {
        continue;
      }
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r !== g || g !== b || r !== 255) {
        return true;
      }
    }
    return false;
  }
}
