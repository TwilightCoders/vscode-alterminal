/**
 * Vertical cell metrics — the split between the content BAND and the cell PITCH.
 *
 * A terminal row has two vertical extents that are usually the same but diverge
 * once `lineSpacing` is in play:
 *
 *   - bandHeight — the snug "line box": font char-height × lineHeight. This is
 *     what the cursor, selection, and cell backgrounds fill, and what the glyph
 *     baseline is centered within. Resizing it would resize the perceived line.
 *   - cellPitch  — how far apart consecutive rows sit: bandHeight + the gap. The
 *     renderer positions row N at `N × cellPitch` and reports cellPitch as the
 *     cell height in `dimensions`, so xterm's hit-testing / selection / row
 *     count all account for the gap.
 *
 * `lineSpacing` is an absolute CSS-pixel gap added BELOW each line. It widens the
 * pitch but must leave the band — and therefore the baseline — untouched, so the
 * glyphs and the line box stay exactly the same size and only the space between
 * rows grows. (This is the distinction the user drew: "spacing between lines",
 * not "height of the lines".)
 */
export interface VerticalCellMetricsInput {
  /** Font cell char-height in device px (e.g. ceil(charSize.height × dpr)). */
  deviceCharHeight: number;
  /** xterm lineHeight multiplier. */
  lineHeight: number;
  /** Absolute inter-line gap in CSS px (pre-DPR); clamped to >= 0. */
  lineSpacingCssPx: number;
  /** Device pixel ratio. */
  dpr: number;
  /** Font ascent in device px. */
  ascent: number;
  /** Font descent in device px. */
  descent: number;
}

export interface VerticalCellMetrics {
  /** Snug line box (font × lineHeight), device px — cursor/selection/bg fill. */
  bandHeight: number;
  /** Inter-line gap, device px — empty space below each line's band. */
  gap: number;
  /** Row advance, device px = bandHeight + gap — drives row Y and dimensions. */
  cellPitch: number;
  /** Baseline from the cell/band top, device px — centered within the band. */
  baseline: number;
}

export function computeVerticalCellMetrics(i: VerticalCellMetricsInput): VerticalCellMetrics {
  const bandHeight = Math.floor(i.deviceCharHeight * i.lineHeight);
  const gap = Math.max(0, Math.round(i.lineSpacingCssPx * i.dpr));
  const cellPitch = bandHeight + gap;
  const leading = bandHeight - (i.ascent + i.descent);
  const baseline = Math.round(i.ascent + leading / 2);
  return { bandHeight, gap, cellPitch, baseline };
}
