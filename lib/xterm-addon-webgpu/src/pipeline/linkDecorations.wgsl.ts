/**
 * Line-decoration shader — underlines (single, double, dashed, curly) and
 * strikethrough. Each decoration is a thin instanced quad spanning the run of
 * decorated cells; the fragment shader shapes the line within the quad.
 *
 * Per-instance layout is 12 × f32 (48 bytes):
 *   [0,1]  originPx   quad top-left, device px (already positioned at the
 *                     correct baseline/strike height by the renderer)
 *   [2,3]  sizePx     quad size, device px (height is the line thickness band)
 *   [4..7] color      RGBA
 *   [8]    style      0 single, 1 double, 2 curly, 3 dashed, 4 strikethrough
 *   [9]    periodPx   dash/curly period in device px
 *   [10,11] _pad
 */
export const linkDecorationsWgsl = /* wgsl */ `
struct Viewport {
  resolution: vec2<f32>,
};

struct DecorInstance {
  originPx: vec2<f32>,
  sizePx: vec2<f32>,
  color: vec4<f32>,
  style: f32,
  periodPx: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(1) @binding(0) var<storage, read> decors: array<DecorInstance>;

struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) local: vec2<f32>,      // 0..1 within the quad
  @location(2) sizePx: vec2<f32>,
  @location(3) @interpolate(flat) style: f32,
  @location(4) @interpolate(flat) periodPx: f32,
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
  let d = decors[iid];
  let corner = CORNERS[vid];
  let posPx = d.originPx + corner * d.sizePx;
  let ndc = vec2<f32>(
    (posPx.x / viewport.resolution.x) * 2.0 - 1.0,
    1.0 - (posPx.y / viewport.resolution.y) * 2.0,
  );
  var out: VsOut;
  out.clipPos = vec4<f32>(ndc, 0.0, 1.0);
  out.color = d.color;
  out.local = corner;
  out.sizePx = d.sizePx;
  out.style = d.style;
  out.periodPx = max(d.periodPx, 1.0);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let xPx = in.local.x * in.sizePx.x;
  let yN = in.local.y; // 0 (top) .. 1 (bottom) within the band
  var alpha = in.color.a;

  // style: 0 single, 1 double, 2 curly, 3 dashed, 4 strikethrough
  if (in.style == 1.0) {
    // Double: two thin bars at the top and bottom thirds.
    let inTop = yN < 0.34;
    let inBot = yN > 0.66;
    if (!inTop && !inBot) { alpha = 0.0; }
  } else if (in.style == 2.0) {
    // Curly: sine centerline, coverage by distance to the wave.
    let phase = (xPx / in.periodPx) * 6.2831853;
    let center = 0.5 + 0.35 * sin(phase);
    let dist = abs(yN - center);
    alpha = alpha * (1.0 - smoothstep(0.12, 0.28, dist));
  } else if (in.style == 3.0) {
    // Dashed: on for the first 60% of each period.
    let t = fract(xPx / in.periodPx);
    if (t > 0.6) { alpha = 0.0; }
  }
  // style 0 (single) and 4 (strikethrough) are solid fills of the band.

  return vec4<f32>(in.color.rgb, alpha);
}
`;
