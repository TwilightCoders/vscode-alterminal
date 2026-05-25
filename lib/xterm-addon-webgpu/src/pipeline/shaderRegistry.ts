/**
 * Central registry of the WGSL shader sources used by the renderer.
 *
 * Shaders are authored as TypeScript string modules (`*.wgsl.ts`) rather than
 * raw `.wgsl` files because the host extension builds with plain `tsc` and no
 * asset loader. When this package is extracted to a standalone repo with a
 * bundler, these can become real `.wgsl` imports with no API change here.
 */
import { cellGridWgsl } from "./cellGrid.wgsl.js";
import { rectanglesWgsl } from "./rectangles.wgsl.js";
import { linkDecorationsWgsl } from "./linkDecorations.wgsl.js";

export const Shaders = {
  cellGrid: cellGridWgsl,
  rectangles: rectanglesWgsl,
  linkDecorations: linkDecorationsWgsl,
} as const;

export type ShaderName = keyof typeof Shaders;
