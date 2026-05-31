/**
 * Convert xterm's baseY-anchored cursor row into a viewport-relative row.
 *
 * Per xterm's docs, `buffer.cursorY` is in the range `[0, rows-1]` measured
 * from `buffer.baseY` — i.e. relative to the line where new output is being
 * written, NOT to wherever the user has scrolled the viewport.
 *
 * When the user scrolls back, `viewportY` drops below `baseY`. Using
 * `cursorY` raw to position the cursor on the rendered canvas pins it to
 * whatever screen row it occupied when the user started scrolling — and
 * subsequent PTY output, rendered through that mis-positioned cursor cell,
 * scribbles over the historical buffer.
 *
 * The conversion mirrors `@xterm/addon-webgl`'s `viewportRelativeCursorY`:
 *   absoluteCursorY = baseY + cursorY
 *   viewportRow     = absoluteCursorY - viewportY
 */
export function viewportCursorRow(
  cursorY: number,
  baseY: number,
  viewportY: number,
): number {
  return baseY + cursorY - viewportY;
}

/** True iff the cursor sits inside the visible viewport [0, rows). */
export function cursorOnScreen(
  cursorY: number,
  baseY: number,
  viewportY: number,
  rows: number,
): boolean {
  const r = viewportCursorRow(cursorY, baseY, viewportY);
  return r >= 0 && r < rows;
}
