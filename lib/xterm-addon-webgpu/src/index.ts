/**
 * xterm-addon-webgpu — a WebGPU renderer for xterm.js.
 *
 * Public surface:
 *   - WebgpuAddon  — the `ITerminalAddon`; drop-in for `WebglAddon`.
 *   - SharedDevice — per-webview device/atlas/pipelines, shared across tabs.
 *   - types        — option and palette shapes for integrators.
 */
export { WebgpuAddon } from "./WebgpuAddon.js";
export { SharedDevice } from "./shared/SharedDevice.js";
export { isWebgpuSupported } from "./platform/deviceFeatures.js";
export { measureFont, deriveFontMetrics, type FontMetrics } from "./platform/fontMetrics.js";
export type {
  IWebgpuAddonOptions,
  ISharedDevice,
  IFontAtlasConfig,
  Palette,
} from "./types.js";
