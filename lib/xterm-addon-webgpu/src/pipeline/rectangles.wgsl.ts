/**
 * Solid-rectangle shader — cell backgrounds, the cursor (block style), and
 * selection fills. Drawn before the glyph pass (backgrounds) and, for non-block
 * cursors, after it.
 *
 * Per-instance layout is 8 × f32 (32 bytes):
 *   [0,1] originPx   top-left, device px
 *   [2,3] sizePx     size, device px
 *   [4..7] color     RGBA (straight alpha)
 */
export const rectanglesWgsl = /* wgsl */ `
struct Viewport {
  resolution: vec2<f32>,
};

struct RectInstance {
  originPx: vec2<f32>,
  sizePx: vec2<f32>,
  color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(1) @binding(0) var<storage, read> rects: array<RectInstance>;

struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color: vec4<f32>,
};

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
  let rect = rects[iid];
  let corner = CORNERS[vid];
  let posPx = rect.originPx + corner * rect.sizePx;
  let ndc = vec2<f32>(
    (posPx.x / viewport.resolution.x) * 2.0 - 1.0,
    1.0 - (posPx.y / viewport.resolution.y) * 2.0,
  );
  var out: VsOut;
  out.clipPos = vec4<f32>(ndc, 0.0, 1.0);
  out.color = rect.color;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  return in.color;
}
`;
