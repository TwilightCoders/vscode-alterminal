/**
 * Pure geometry for hovered-link underlines.
 *
 * Given a link span in viewport-relative cells (as xterm's
 * `onShowLinkUnderline` reports it), produce the per-row cell ranges to
 * underline, clamped to the grid. Mirrors xterm's built-in link render layer:
 *
 *   - single row (y1 === y2): underline [x1, x2)
 *   - multi-row: [x1, cols) on the first row, full rows in between, [0, x2) on
 *     the last row
 *
 * Kept pure (no GPU, no metrics) so the off-by-one-prone span logic is unit
 * tested independently of rendering.
 */
export interface ILinkUnderlineSpanInput {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cols: number;
}

export interface ILinkSpan {
  row: number;
  colStart: number;
  colEnd: number;
}

export function linkUnderlineSpans(
  lu: ILinkUnderlineSpanInput,
  rows: number,
  cols: number,
): ILinkSpan[] {
  const spans: ILinkSpan[] = [];
  const add = (row: number, colStart: number, colEnd: number): void => {
    if (row < 0 || row >= rows) {
      return;
    }
    const c0 = Math.max(0, Math.min(colStart, cols));
    const c1 = Math.max(0, Math.min(colEnd, cols));
    if (c1 > c0) {
      spans.push({ row, colStart: c0, colEnd: c1 });
    }
  };

  if (lu.y1 === lu.y2) {
    add(lu.y1, lu.x1, lu.x2);
  } else {
    add(lu.y1, lu.x1, lu.cols);
    for (let row = lu.y1 + 1; row < lu.y2; row++) {
      add(row, 0, lu.cols);
    }
    add(lu.y2, 0, lu.x2);
  }
  return spans;
}
