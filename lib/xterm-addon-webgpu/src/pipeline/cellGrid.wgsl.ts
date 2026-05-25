/**
 * Cell-grid glyph shader.
 *
 * One instance per visible glyph. A unit quad (two triangles, 6 vertices) is
 * positioned and sized in device-pixel space from per-instance data held in a
 * storage buffer, then textured from the shared glyph atlas (a 2D texture
 * array; one array layer per atlas page).
 *
 * Per-instance layout is 16 × f32 (64 bytes) — see `GpuCellBuffer` for the
 * matching CPU-side packing:
 *
 *   [ 0, 1] originPx   glyph top-left, device px
 *   [ 2, 3] sizePx     glyph size, device px
 *   [ 4, 5] uvOrigin   atlas UV top-left (normalized 0..1 within the layer)
 *   [ 6, 7] uvSize     atlas UV size (normalized)
 *   [ 8..11] color     foreground tint (grayscale glyphs) — premultiplied later
 *   [12]    layer      atlas array layer (stored as f32, rounded in-shader)
 *   [13]    flags      bit-ish: >= 0.5 means the glyph carries its own color
 *   [14,15] _pad
 *
 * Grayscale glyphs are rasterized white-on-transparent, so coverage lives in
 * the atlas alpha channel; the fragment tints that coverage with `color`.
 * Color glyphs (emoji) ignore `color` and use the sampled RGBA directly.
 */
export const cellGridWgsl = /* wgsl */ `
struct Viewport {
  resolution: vec2<f32>,
};

struct CellInstance {
  originPx: vec2<f32>,
  sizePx: vec2<f32>,
  uvOrigin: vec2<f32>,
  uvSize: vec2<f32>,
  color: vec4<f32>,
  layer: f32,
  flags: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(0) @binding(1) var atlasSampler: sampler;
@group(0) @binding(2) var atlasTexture: texture_2d_array<f32>;
@group(1) @binding(0) var<storage, read> cells: array<CellInstance>;

struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) @interpolate(flat) layer: i32,
  @location(3) @interpolate(flat) isColor: f32,
};

// Unit quad corners (two triangles).
const CORNERS = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(0.0, 1.0),
  vec2<f32>(0.0, 1.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(1.0, 1.0),
);

@vertex
fn vs_main(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VsOut {
  let cell = cells[iid];
  let corner = CORNERS[vid];

  let posPx = cell.originPx + corner * cell.sizePx;
  // Device pixels -> clip space. Y is flipped (px grows downward).
  let ndc = vec2<f32>(
    (posPx.x / viewport.resolution.x) * 2.0 - 1.0,
    1.0 - (posPx.y / viewport.resolution.y) * 2.0,
  );

  var out: VsOut;
  out.clipPos = vec4<f32>(ndc, 0.0, 1.0);
  out.uv = cell.uvOrigin + corner * cell.uvSize;
  out.color = cell.color;
  out.layer = i32(round(cell.layer));
  out.isColor = cell.flags;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let sampled = textureSample(atlasTexture, atlasSampler, in.uv, in.layer);
  if (in.isColor >= 0.5) {
    // Color glyph (emoji): use as-is.
    return sampled;
  }
  // Grayscale glyph: alpha channel is coverage; tint with the fg color.
  let coverage = sampled.a;
  return vec4<f32>(in.color.rgb, in.color.a * coverage);
}
`;
