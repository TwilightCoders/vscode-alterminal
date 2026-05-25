/**
 * The per-webview shared GPU context — the architectural centerpiece.
 *
 * One `SharedDevice` is meant to exist per VS Code webview and be handed to
 * every terminal tab's {@link WebgpuAddon} in that webview. It owns the single
 * `GPUDevice`, the glyph atlas, the shader pipelines and the bind group
 * layouts. Per-tab addons add only a canvas context and a small instance buffer
 * each, so GPU memory scales with the number of windows rather than the number
 * of tabs.
 *
 * It is reference-counted: each attached addon calls {@link acquire} on attach
 * and {@link release} on dispose. When the count hits zero and the device was
 * created internally (not injected), the device is destroyed.
 */
import { acquireDevice } from "../platform/deviceFeatures.js";
import { GlyphRasterizer } from "../atlas/glyphRasterizer.js";
import { GlyphAtlas } from "../atlas/GlyphAtlas.js";
import { createBindGroupLayouts, type IBindGroupLayouts } from "./bindGroupLayouts.js";
import { createPipelines, type IPipelines } from "./pipelines.js";
import { Emitter, type Event } from "../util/event.js";
import type { IFontAtlasConfig, ISharedDevice } from "../types.js";

export class SharedDevice implements ISharedDevice {
  public readonly device: GPUDevice;
  public readonly format: GPUTextureFormat;
  public readonly adapter: GPUAdapter;
  public readonly layouts: IBindGroupLayouts;
  public readonly pipelines: IPipelines;
  public readonly atlas: GlyphAtlas;
  public readonly rasterizer: GlyphRasterizer;

  private readonly _onDeviceLost = new Emitter<GPUDeviceLostInfo>();
  public readonly onDeviceLost: Event<GPUDeviceLostInfo> = this._onDeviceLost.event;

  private _refCount = 0;
  private _destroyed = false;

  private constructor(
    adapter: GPUAdapter,
    device: GPUDevice,
    format: GPUTextureFormat,
    config: IFontAtlasConfig,
  ) {
    this.adapter = adapter;
    this.device = device;
    this.format = format;
    this.layouts = createBindGroupLayouts(device);
    this.pipelines = createPipelines(device, this.layouts, format);
    this.rasterizer = new GlyphRasterizer(config);
    this.atlas = new GlyphAtlas(device, this.rasterizer);

    // Surface device loss so attached addons can re-init or fall back.
    void device.lost.then((info) => {
      if (!this._destroyed) {
        this._onDeviceLost.fire(info);
      }
    });
  }

  /** Create a shared device, acquiring a GPU adapter/device for this webview. */
  public static async create(config: IFontAtlasConfig): Promise<SharedDevice> {
    const { adapter, device, format } = await acquireDevice();
    return new SharedDevice(adapter, device, format, config);
  }

  /** Update the shared font metrics and drop cached glyphs (e.g. on zoom). */
  public updateFontConfig(config: IFontAtlasConfig): void {
    this.rasterizer.updateConfig(config);
    this.atlas.clearTexture();
  }

  public acquire(): void {
    this._refCount++;
  }

  public release(): void {
    this._refCount--;
    if (this._refCount <= 0) {
      this._destroy();
    }
  }

  private _destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this.atlas.dispose();
    this._onDeviceLost.dispose();
    this.device.destroy();
  }
}
