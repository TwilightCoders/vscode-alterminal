/**
 * Bind group layout factories.
 *
 * Group 0 is the per-frame "shared" group: the viewport uniform plus (for the
 * glyph pipeline) the atlas sampler and texture. Group 1 is the per-draw
 * storage buffer holding the instance array.
 *
 * The layouts are created once on the {@link SharedDevice} and reused by every
 * attached terminal, since they describe shapes, not data.
 */

export interface IBindGroupLayouts {
  /** group(0) for the glyph pipeline: viewport + sampler + atlas texture array. */
  glyphShared: GPUBindGroupLayout;
  /** group(0) for the rectangle/decoration pipelines: viewport only. */
  viewportOnly: GPUBindGroupLayout;
  /** group(1): a read-only storage buffer of instances. */
  instanceStorage: GPUBindGroupLayout;
}

export function createBindGroupLayouts(device: GPUDevice): IBindGroupLayouts {
  const glyphShared = device.createBindGroupLayout({
    label: "webgpu-term:glyphShared",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d-array" },
      },
    ],
  });

  const viewportOnly = device.createBindGroupLayout({
    label: "webgpu-term:viewportOnly",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });

  const instanceStorage = device.createBindGroupLayout({
    label: "webgpu-term:instanceStorage",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
    ],
  });

  return { glyphShared, viewportOnly, instanceStorage };
}
