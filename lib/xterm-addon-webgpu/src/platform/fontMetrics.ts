/**
 * Font-driven cell metrics.
 *
 * Terminal cells are not arbitrary boxes — their height and the glyph baseline
 * come straight from the font. We read the font's own ascent/descent (the
 * `fontBoundingBox*` metrics, which are font-wide, not glyph-specific) and
 * derive:
 *   - cellHeight: the line box (ascent + descent) scaled by lineHeight
 *   - baseline:   where glyphs sit within the cell, with any extra line-height
 *                 leading split evenly above and below (so text is vertically
 *                 centered in the cell — and a full-cell selection wraps it
 *                 symmetrically instead of hugging the top)
 *
 * The derivation is split from the canvas measurement so it can be unit-tested
 * without a DOM.
 */
export interface FontMetrics {
  /** Advance width of a cell, device px. */
  cellWidth: number;
  /** Full line-box height of a cell, device px. */
  cellHeight: number;
  /** Font ascent, device px. */
  ascent: number;
  /** Font descent, device px. */
  descent: number;
  /** Baseline Y within the cell (from the cell's top), device px. */
  baseline: number;
}

/**
 * Pure metric derivation. Given the font's advance/ascent/descent (device px)
 * and a CSS-style line-height multiplier, compute cell box + baseline.
 */
export function deriveFontMetrics(
  advance: number,
  ascent: number,
  descent: number,
  lineHeight: number,
): FontMetrics {
  const lineBox = ascent + descent;
  const cellHeight = Math.max(1, Math.round(lineBox * lineHeight));
  const leading = cellHeight - lineBox;
  const baseline = Math.round(ascent + leading / 2);
  return {
    cellWidth: Math.max(1, Math.round(advance)),
    cellHeight,
    ascent,
    descent,
    baseline,
  };
}

/**
 * Measure a font via an OffscreenCanvas and derive its cell metrics. Used by
 * both the renderer's rasterizer and the smoke harness so they agree.
 */
export function measureFont(fontFamily: string, fontSizeDevicePx: number, lineHeight: number): FontMetrics {
  const ctx = new OffscreenCanvas(8, 8).getContext("2d");
  if (!ctx) {
    throw new Error("measureFont: failed to acquire a 2D context");
  }
  ctx.font = `${fontSizeDevicePx}px ${fontFamily}`;
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText("M"); // monospace: advance is uniform
  const advance = m.width;
  // fontBoundingBox* are font-wide metrics; fall back to sane fractions if a
  // browser doesn't expose them.
  const ascent = m.fontBoundingBoxAscent ?? fontSizeDevicePx * 0.9;
  const descent = m.fontBoundingBoxDescent ?? fontSizeDevicePx * 0.25;
  return deriveFontMetrics(advance, ascent, descent, lineHeight);
}
