/**
 * Pure selection-range geometry, shared by the renderer's per-cell paint test.
 *
 * Coordinates are absolute buffer cells `[col, row]`. The `end` column is
 * exclusive, matching xterm's selection model. Kept dependency-free so the
 * range logic (the part that's easy to get subtly wrong across row boundaries
 * and in column-select mode) is unit-testable without a GPU.
 */
export interface Selection {
  start: [number, number];
  end: [number, number];
  columnMode: boolean;
}

/** Order endpoints so `start` precedes `end` in (row, then col) order. */
export function normalizeSelection(
  start: [number, number],
  end: [number, number],
  columnMode: boolean,
): Selection {
  let s = start;
  let e = end;
  if (e[1] < s[1] || (e[1] === s[1] && e[0] < s[0])) {
    [s, e] = [e, s];
  }
  return { start: s, end: e, columnMode };
}

/** Whether the cell at absolute (col, row) falls within `sel`. */
export function isCellInSelection(col: number, row: number, sel: Selection | null): boolean {
  if (!sel) {
    return false;
  }
  const [sc, sr] = sel.start;
  const [ec, er] = sel.end;

  if (sel.columnMode) {
    const c0 = Math.min(sc, ec);
    const c1 = Math.max(sc, ec);
    return row >= sr && row <= er && col >= c0 && col < c1;
  }

  if (row < sr || row > er) {
    return false;
  }
  if (sr === er) {
    return col >= sc && col < ec; // single-row selection
  }
  if (row === sr) {
    return col >= sc; // first row: start col to end-of-line
  }
  if (row === er) {
    return col < ec; // last row: up to (exclusive) end col
  }
  return true; // a fully-selected middle row
}
