/**
 * Render pipeline factories. All three pipelines draw an instanced unit quad
 * (6 vertices, no vertex buffer — positions come from a constant array in the
 * shader) and write to the swap-chain texture with standard alpha blending.
 */
import { Shaders } from "../pipeline/shaderRegistry.js";
import type { IBindGroupLayouts } from "./bindGroupLayouts.js";

export interface IPipelines {
  glyph: GPURenderPipeline;
  rectangle: GPURenderPipeline;
  decoration: GPURenderPipeline;
}

const ALPHA_BLEND: GPUBlendState = {
  color: {
    srcFactor: "src-alpha",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
  alpha: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
};

export function createPipelines(
  device: GPUDevice,
  layouts: IBindGroupLayouts,
  format: GPUTextureFormat,
): IPipelines {
  const target: GPUColorTargetState = { format, blend: ALPHA_BLEND };

  const glyphModule = device.createShaderModule({ label: "webgpu-term:cellGrid", code: Shaders.cellGrid });
  const rectModule = device.createShaderModule({ label: "webgpu-term:rectangles", code: Shaders.rectangles });
  const decorModule = device.createShaderModule({ label: "webgpu-term:decorations", code: Shaders.linkDecorations });

  const glyph = device.createRenderPipeline({
    label: "webgpu-term:glyphPipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [layouts.glyphShared, layouts.instanceStorage],
    }),
    vertex: { module: glyphModule, entryPoint: "vs_main" },
    fragment: { module: glyphModule, entryPoint: "fs_main", targets: [target] },
    primitive: { topology: "triangle-list" },
  });

  const rectangle = device.createRenderPipeline({
    label: "webgpu-term:rectPipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [layouts.viewportOnly, layouts.instanceStorage],
    }),
    vertex: { module: rectModule, entryPoint: "vs_main" },
    fragment: { module: rectModule, entryPoint: "fs_main", targets: [target] },
    primitive: { topology: "triangle-list" },
  });

  const decoration = device.createRenderPipeline({
    label: "webgpu-term:decorPipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [layouts.viewportOnly, layouts.instanceStorage],
    }),
    vertex: { module: decorModule, entryPoint: "vs_main" },
    fragment: { module: decorModule, entryPoint: "fs_main", targets: [target] },
    primitive: { topology: "triangle-list" },
  });

  return { glyph, rectangle, decoration };
}
