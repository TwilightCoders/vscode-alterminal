/**
 * The CPU-side render model: a flat `Uint32Array` of `cols * rows` cells, four
 * u32 per cell. This mirrors `@xterm/addon-webgl`'s `RenderModel` layout so the
 * per-cell packing semantics are identical:
 *
 *   word 0 — content  (codepoint + combined-char bit + width)
 *   word 1 — bg       (resolved background attribute integer)
 *   word 2 — fg       (resolved foreground attribute integer)
 *   word 3 — ext      (extended attributes: underline style, variant offset)
 *
 * The renderer fills this each frame from xterm's buffer (via CellColorResolver)
 * and then derives GPU instance data from it. Keeping it a plain typed array
 * makes it cheap to diff, cheap to upload, and trivial to unit-test.
 */

export const INDICES_PER_CELL = 4;
export const CONTENT_OFFSET = 0;
export const BG_OFFSET = 1;
export const FG_OFFSET = 2;
export const EXT_OFFSET = 3;

export class RenderModel {
  public cells: Uint32Array = new Uint32Array(0);
  /** Per-row count of non-empty cells, used to skip trailing blanks. */
  public lineLengths: Uint32Array = new Uint32Array(0);
  private _cols = 0;
  private _rows = 0;

  public get cols(): number {
    return this._cols;
  }
  public get rows(): number {
    return this._rows;
  }

  /** Resize the model, reallocating only when the cell count actually changes. */
  public resize(cols: number, rows: number): void {
    this._cols = cols;
    this._rows = rows;
    const indexCount = cols * rows * INDICES_PER_CELL;
    if (indexCount !== this.cells.length) {
      this.cells = new Uint32Array(indexCount);
      this.lineLengths = new Uint32Array(rows);
    }
  }

  public clear(): void {
    this.cells.fill(0);
    this.lineLengths.fill(0);
  }

  /** Byte/word index of cell (x, y)'s first word. */
  public cellIndex(x: number, y: number): number {
    return (y * this._cols + x) * INDICES_PER_CELL;
  }

  public setCell(x: number, y: number, content: number, bg: number, fg: number, ext: number): void {
    const i = this.cellIndex(x, y);
    this.cells[i + CONTENT_OFFSET] = content;
    this.cells[i + BG_OFFSET] = bg;
    this.cells[i + FG_OFFSET] = fg;
    this.cells[i + EXT_OFFSET] = ext;
  }

  public getContent(x: number, y: number): number {
    return this.cells[this.cellIndex(x, y) + CONTENT_OFFSET];
  }
  public getBg(x: number, y: number): number {
    return this.cells[this.cellIndex(x, y) + BG_OFFSET];
  }
  public getFg(x: number, y: number): number {
    return this.cells[this.cellIndex(x, y) + FG_OFFSET];
  }
  public getExt(x: number, y: number): number {
    return this.cells[this.cellIndex(x, y) + EXT_OFFSET];
  }
}
