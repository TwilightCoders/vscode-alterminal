/**
 * The shared glyph atlas: a single `rgba8unorm` 2D texture array. Each array
 * layer is an independent packing surface managed by its own {@link ShelfPacker}.
 * Glyphs are keyed by `(code, bold, italic)` via {@link FourKeyMap}. The bitmap
 * is a solid-white coverage mask — fg/bg color is applied in the shader, not
 * baked in — so color is deliberately NOT part of the key (one bitmap serves a
 * codepoint in every color).
 *
 * Eviction strategy: when every layer is full, the atlas evicts the
 * least-recently-used ~half of its cold glyphs (via {@link LruEvictor}) and
 * repacks the survivors onto freshly-reset layers — it does NOT nuke everything.
 * Survivors are re-rasterized from their stored `text`/style and keep their LRU
 * recency. A full reset is only the degenerate fallback when a single frame's
 * glyphs exceed the whole atlas.
 *
 * Mid-frame safety: eviction (and any fallback reset) relocates glyph positions,
 * so {@link consumeReset} lets the renderer detect it and rebuild the frame once
 * on the repacked atlas. Crucially, {@link LruEvictor.selectEvictable} never
 * returns a glyph touched in the current frame, so glyphs already drawn this
 * frame are always preserved — a mid-frame fill relocates them but cannot
 * corrupt them (the bug class that motivated this renderer).
 */
import { ShelfPacker } from "./shelfPacker.js";
import { LruEvictor } from "./lruEvictor.js";
import { FourKeyMap } from "../util/fourKeyMap.js";
import { computeGlyphKey, type GlyphKeyTuple } from "../util/glyphCacheKey.js";
import type { GlyphRasterizer } from "./glyphRasterizer.js";
import type { IGlyphKey, IRasterizedGlyph } from "../types.js";

interface IAtlasEntry {
  id: number;
  glyph: IRasterizedGlyph;
  // Identity + source needed to re-rasterize and re-key this glyph when
  // repacking survivors during LRU eviction. `key` is the exact 4-int atlas
  // key (so repack re-keys identically); `text` is the actual string handed to
  // the rasterizer.
  key: GlyphKeyTuple;
  text: string;
  bold: boolean;
  italic: boolean;
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
  // Interning table for composite glyphs (multi-codepoint emoji / ZWJ runs),
  // whose numeric code() collides. Maps the full glyph string → a stable id
  // used in the composite key namespace. Kept across evict/reset so survivors'
  // stored keys stay valid.
  private _composite = new Map<string, number>();
  private _compositeNext = 1;
  private _internComposite = (text: string): number => {
    let id = this._composite.get(text);
    if (id === undefined) {
      id = this._compositeNext++;
      this._composite.set(text, id);
    }
    return id;
  };
  private _didReset = false;
  private _evictionCount = 0;
  private _hardResetCount = 0;

  /** Diagnostics: how many LRU evict-and-repack cycles have run. */
  public get evictionCount(): number {
    return this._evictionCount;
  }
  /** Diagnostics: how many degenerate full resets have run. */
  public get hardResetCount(): number {
    return this._hardResetCount;
  }

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
    // The atlas bitmap is a solid-white coverage mask (fg/bg are applied in the
    // shader, not baked in), so it depends ONLY on (code, bold, italic). Keying
    // by color would store one identical bitmap per fg/bg combo — a gradient
    // progress bar or powerline prompt would multiply a single block glyph into
    // dozens of redundant entries and thrash the atlas. Key by what the bitmap
    // actually depends on.
    // Composite glyphs (emoji+VS16, ZWJ, base+combining) share a trailing
    // code() and would collide if keyed by code alone — key them by interned
    // string id in a separate namespace. See glyphCacheKey.ts.
    const [k0, k1, k2, k3] = computeGlyphKey(key.code, text, bold, italic, this._internComposite);
    const existing = this._entries.get(k0, k1, k2, k3);
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
    this._entries.set(k0, k1, k2, k3, { id, glyph, key: [k0, k1, k2, k3], text, bold, italic });
    this._evictor.markUsed(id);
    return glyph;
  }

  /** Allocate a `w x h` region across the layers, or null if all are full. */
  private _allocate(w: number, h: number): { layer: number; x: number; y: number } | null {
    for (let layer = 0; layer < this._packers.length; layer++) {
      const pos = this._packers[layer].allocate(w, h);
      if (pos) {
        return { layer, x: pos.x, y: pos.y };
      }
    }
    return null;
  }

  /**
   * Place a `w x h` region. When the atlas is full, evict the least-recently-used
   * glyphs and repack the survivors rather than nuking everything. Glyphs touched
   * in the current frame are never evicted (selectEvictable excludes them), so a
   * fill that happens mid-frame can't corrupt glyphs already drawn this frame —
   * it just relocates them, and the renderer rebuilds the frame via `_didReset`.
   */
  private _place(w: number, h: number): { layer: number; x: number; y: number } | null {
    const direct = this._allocate(w, h);
    if (direct) {
      return direct;
    }
    if (this._evictAndRepack()) {
      const retry = this._allocate(w, h);
      if (retry) {
        return retry;
      }
    }
    // Degenerate: a single frame needs more than the whole atlas. Hard reset.
    this._reset();
    return this._allocate(w, h);
  }

  /**
   * Drop the least-recently-used ~half of cold glyphs (never current-frame ones)
   * and repack the survivors onto freshly-reset layers. Returns false when there
   * is nothing evictable (every glyph is in the current frame). Sets `_didReset`
   * because survivor texture positions change — the renderer must rebuild.
   */
  private _evictAndRepack(): boolean {
    const evictCount = Math.max(1, Math.floor(this._entries.size / 2));
    const evictIds = new Set(this._evictor.selectEvictable(evictCount));
    if (evictIds.size === 0) {
      return false;
    }

    const survivors: IAtlasEntry[] = [];
    for (const e of this._entries.values()) {
      if (!evictIds.has(e.id)) {
        survivors.push(e);
      }
    }

    // Reset packing surfaces and the entry map; keep the evictor's recency for
    // survivors (only drop the evicted ids) so LRU ordering is preserved.
    for (const p of this._packers) {
      p.reset();
    }
    this._entries.clear();
    for (const id of evictIds) {
      this._evictor.remove(id);
    }

    for (const e of survivors) {
      const raster = this._rasterizer.rasterize(e.text, e.bold, e.italic);
      const bbox = raster ? this._tightBounds(raster.imageData) : null;
      const pos = bbox ? this._allocate(bbox.maxX - bbox.minX + 1, bbox.maxY - bbox.minY + 1) : null;
      if (!raster || !bbox || !pos) {
        this._evictor.remove(e.id); // couldn't re-place — drop it cleanly
        continue;
      }
      this._upload(raster.imageData, bbox, pos.layer, pos.x, pos.y);
      const glyph: IRasterizedGlyph = {
        layer: pos.layer,
        texturePosition: { x: pos.x, y: pos.y },
        size: { x: bbox.maxX - bbox.minX + 1, y: bbox.maxY - bbox.minY + 1 },
        offset: { x: bbox.minX, y: bbox.minY },
        isColor: raster.isColor,
      };
      this._entries.set(e.key[0], e.key[1], e.key[2], e.key[3], { ...e, glyph });
    }

    this._evictionCount++;
    this._didReset = true;
    return true;
  }

  private _reset(): void {
    for (const p of this._packers) {
      p.reset();
    }
    this._entries.clear();
    this._evictor.clear();
    this._hardResetCount++;
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
    this._composite.clear();
  }
}
