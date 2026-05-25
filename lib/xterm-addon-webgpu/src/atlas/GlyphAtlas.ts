/**
 * The shared glyph atlas: a single `rgba8unorm` 2D texture array. Each array
 * layer is an independent packing surface managed by its own {@link ShelfPacker}.
 * Glyphs are keyed by `(code, bg, fg, ext)` via {@link FourKeyMap} so a styled
 * glyph is cached separately from the same codepoint in another style.
 *
 * Eviction strategy (Phase 1): when every layer is full, the atlas performs a
 * full reset — all cached glyphs are dropped and re-rasterized on demand. This
 * is correct and simple. The {@link LruEvictor} is wired and the per-glyph LRU
 * data is maintained so the Phase-2 strategy ("evict the LRU set, repack the
 * survivors") can drop in without touching call sites.
 *
 * Mid-frame reset safety: because a reset invalidates positions handed out
 * earlier in the same frame, {@link consumeReset} lets the renderer detect a
 * reset and rebuild the frame once. Glyphs allocated in the current frame are
 * never evicted (the reset only happens when even those don't fit, which for a
 * single viewport's worth of glyphs cannot occur with a reasonably sized atlas).
 */
import { ShelfPacker } from "./shelfPacker.js";
import { LruEvictor } from "./lruEvictor.js";
import { FourKeyMap } from "../util/fourKeyMap.js";
import type { GlyphRasterizer } from "./glyphRasterizer.js";
import type { IGlyphKey, IRasterizedGlyph } from "../types.js";

interface IAtlasEntry {
  id: number;
  glyph: IRasterizedGlyph;
}

export interface IGlyphAtlasOptions {
  /** Edge length of each square atlas layer, in device pixels. */
  pageSize?: number;
  /** Number of array layers. */
  layers?: number;
}

const DEFAULT_PAGE_SIZE = 2048;
const DEFAULT_LAYERS = 4;

export class GlyphAtlas {
  public readonly texture: GPUTexture;
  public readonly textureView: GPUTextureView;
  public readonly pageSize: number;
  public readonly layerCount: number;

  private _packers: ShelfPacker[];
  private _entries = new FourKeyMap<IAtlasEntry>();
  private _evictor = new LruEvictor();
  private _nextId = 1;
  private _didReset = false;

  constructor(
    private readonly _device: GPUDevice,
    private readonly _rasterizer: GlyphRasterizer,
    options: IGlyphAtlasOptions = {},
  ) {
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.layerCount = options.layers ?? DEFAULT_LAYERS;
    const maxDim = _device.limits.maxTextureDimension2D;
    if (this.pageSize > maxDim) {
      this.pageSize = maxDim;
    }
    this.texture = _device.createTexture({
      label: "webgpu-term:glyphAtlas",
      format: "rgba8unorm",
      size: { width: this.pageSize, height: this.pageSize, depthOrArrayLayers: this.layerCount },
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: "2d",
    });
    this.textureView = this.texture.createView({ dimension: "2d-array" });
    this._packers = this._makePackers();
  }

  private _makePackers(): ShelfPacker[] {
    const packers: ShelfPacker[] = [];
    for (let i = 0; i < this.layerCount; i++) {
      packers.push(new ShelfPacker(this.pageSize, this.pageSize));
    }
    return packers;
  }

  /** Begin a render frame; advances the LRU frame counter. */
  public beginFrame(): void {
    this._evictor.beginFrame();
  }

  /** Returns true (and clears the flag) if the atlas reset during the last build. */
  public consumeReset(): boolean {
    const r = this._didReset;
    this._didReset = false;
    return r;
  }

  /**
   * Look up or rasterize+pack the glyph for `key` rendered as `text`. Returns
   * null for empty/whitespace glyphs (nothing to draw). The returned object is
   * owned by the atlas — copy out fields you need to retain.
   */
  public getOrAllocate(
    key: IGlyphKey,
    text: string,
    bold: boolean,
    italic: boolean,
  ): IRasterizedGlyph | null {
    const existing = this._entries.get(key.code, key.bg, key.fg, key.ext);
    if (existing) {
      this._evictor.markUsed(existing.id);
      return existing.glyph;
    }

    const raster = this._rasterizer.rasterize(text, bold, italic);
    if (!raster) {
      return null;
    }
    const bbox = this._tightBounds(raster.imageData);
    if (!bbox) {
      return null; // Fully transparent (e.g. a space-like glyph).
    }
    const bw = bbox.maxX - bbox.minX + 1;
    const bh = bbox.maxY - bbox.minY + 1;

    const placement = this._place(bw, bh);
    if (!placement) {
      return null; // Glyph larger than a whole atlas layer — should not happen.
    }

    this._upload(raster.imageData, bbox, placement.layer, placement.x, placement.y);

    const id = this._nextId++;
    const glyph: IRasterizedGlyph = {
      layer: placement.layer,
      texturePosition: { x: placement.x, y: placement.y },
      size: { x: bw, y: bh },
      offset: { x: bbox.minX, y: bbox.minY },
      isColor: raster.isColor,
    };
    this._entries.set(key.code, key.bg, key.fg, key.ext, { id, glyph });
    this._evictor.markUsed(id);
    return glyph;
  }

  /** Try to place a `w x h` region across the layers, resetting if all are full. */
  private _place(w: number, h: number): { layer: number; x: number; y: number } | null {
    for (let layer = 0; layer < this._packers.length; layer++) {
      const pos = this._packers[layer].allocate(w, h);
      if (pos) {
        return { layer, x: pos.x, y: pos.y };
      }
    }
    // Every layer is full — reset and retry on a clean layer 0.
    this._reset();
    const pos = this._packers[0].allocate(w, h);
    return pos ? { layer: 0, x: pos.x, y: pos.y } : null;
  }

  private _reset(): void {
    for (const p of this._packers) {
      p.reset();
    }
    this._entries.clear();
    this._evictor.clear();
    this._didReset = true;
  }

  /** Upload a cropped sub-rect of `imageData` into the texture array layer. */
  private _upload(
    imageData: ImageData,
    bbox: { minX: number; minY: number },
    layer: number,
    x: number,
    y: number,
  ): void {
    const fullWidth = imageData.width;
    // dataLayout offset addresses the top-left of the cropped region within the
    // full-width source buffer; bytesPerRow is the full source row stride, so
    // the GPU reads the correct windowed sub-rectangle.
    this._device.queue.writeTexture(
      { texture: this.texture, origin: { x, y, z: layer } },
      imageData.data,
      {
        offset: (bbox.minY * fullWidth + bbox.minX) * 4,
        bytesPerRow: fullWidth * 4,
        rowsPerImage: imageData.height,
      },
      { width: this._cropW, height: this._cropH, depthOrArrayLayers: 1 },
    );
  }

  // Cropped dimensions are stashed by _tightBounds for _upload to consume.
  private _cropW = 0;
  private _cropH = 0;

  /** Compute the tight non-transparent bounding box, or null if fully empty. */
  private _tightBounds(
    imageData: ImageData,
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const { data, width, height } = imageData;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let yy = 0; yy < height; yy++) {
      for (let xx = 0; xx < width; xx++) {
        if (data[(yy * width + xx) * 4 + 3] !== 0) {
          if (xx < minX) minX = xx;
          if (xx > maxX) maxX = xx;
          if (yy < minY) minY = yy;
          if (yy > maxY) maxY = yy;
        }
      }
    }
    if (maxX < 0) {
      return null;
    }
    this._cropW = maxX - minX + 1;
    this._cropH = maxY - minY + 1;
    return { minX, minY, maxX, maxY };
  }

  public clearTexture(): void {
    this._reset();
  }

  public dispose(): void {
    this.texture.destroy();
    this._entries.clear();
    this._evictor.clear();
  }
}
