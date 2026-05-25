/**
 * Public and internal types for the WebGPU renderer addon.
 */

import type { Palette } from "./util/colorUtils.js";

export type { Palette } from "./util/colorUtils.js";

/** 2D integer vector. */
export interface IVector {
  x: number;
  y: number;
}

/**
 * Render dimensions, mirroring xterm's `IRenderDimensions`. Tracked in both CSS
 * pixels (layout) and device pixels (the backing GPU surface).
 */
export interface IRenderDimensions {
  css: {
    canvas: { width: number; height: number };
    cell: { width: number; height: number };
  };
  device: {
    canvas: { width: number; height: number };
    cell: { width: number; height: number };
    char: { width: number; height: number; top: number; left: number };
  };
}

/** Options accepted by the {@link WebgpuAddon} constructor. */
export interface IWebgpuAddonOptions {
  /**
   * An externally-created shared device. When supplied, this addon reuses the
   * device, glyph atlas and pipelines instead of creating private ones — this
   * is the mechanism that collapses GPU memory from O(tabs) to O(windows).
   *
   * When omitted, the addon lazily creates a private device for itself,
   * preserving drop-in `new WebgpuAddon()` semantics identical to WebglAddon.
   */
  device?: ISharedDevice;
}

/**
 * The per-webview shared GPU context. One instance is meant to be created per
 * VS Code webview and passed to every terminal tab's addon in that webview.
 */
export interface ISharedDevice {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  /** Fires when the underlying `GPUDevice` is lost. */
  onDeviceLost(listener: (info: GPUDeviceLostInfo) => void): { dispose(): void };
  /** Increment refcount when an addon attaches. */
  acquire(): void;
  /** Decrement refcount; destroys the device when it reaches zero (if owned). */
  release(): void;
}

/** A rasterized glyph's placement within the atlas texture array. */
export interface IRasterizedGlyph {
  /** Atlas texture-array layer this glyph lives on. */
  layer: number;
  /** Pixel position within the layer. */
  texturePosition: IVector;
  /** Pixel size of the rasterized glyph. */
  size: IVector;
  /** Pixel offset from the cell's top-left to the glyph's top-left. */
  offset: IVector;
  /** True when the glyph carries its own color (e.g. emoji); shader skips fg tint. */
  isColor: boolean;
}

/** Glyph identity used as the atlas cache key. */
export interface IGlyphKey {
  code: number;
  bg: number;
  fg: number;
  ext: number;
}

/** Configuration describing the current font/cell metrics for rasterization. */
export interface IFontAtlasConfig {
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
  fontWeightBold: string | number;
  letterSpacing: number;
  lineHeight: number;
  devicePixelRatio: number;
  deviceCellWidth: number;
  deviceCellHeight: number;
  deviceCharWidth: number;
  deviceCharHeight: number;
  palette: Palette;
}
