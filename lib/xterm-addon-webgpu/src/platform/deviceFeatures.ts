/**
 * WebGPU capability detection and device acquisition.
 */

/** True when the running environment exposes the WebGPU API. */
export function isWebgpuSupported(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && !!navigator.gpu;
}

export interface IAcquiredDevice {
  adapter: GPUAdapter;
  device: GPUDevice;
  /** Preferred canvas format for this platform (e.g. "bgra8unorm"). */
  format: GPUTextureFormat;
}

/**
 * Request an adapter + device. Throws a descriptive error if WebGPU is missing
 * or no adapter is available, so callers can fall back to another renderer.
 */
export async function acquireDevice(): Promise<IAcquiredDevice> {
  if (!isWebgpuSupported()) {
    throw new Error("WebGPU is not available in this environment (navigator.gpu missing)");
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    throw new Error("WebGPU: no GPUAdapter available");
  }
  const device = await adapter.requestDevice({ label: "webgpu-term:device" });
  const format = navigator.gpu.getPreferredCanvasFormat();
  return { adapter, device, format };
}
