/**
 * Tracks which terminal rows are "dirty" (need their GPU cell data rebuilt).
 *
 * xterm drives rendering by calling `renderRows(start, end)` with the inclusive
 * range of rows that changed. We coalesce successive calls within a frame into
 * a single dirty range, and expose a per-row dirty query so the renderer can
 * skip atlas lookups and buffer writes for unchanged rows.
 */
export class DamageTracker {
  private _rows = 0;
  private _dirtyStart = -1;
  private _dirtyEnd = -1;
  /** When true, the next frame rebuilds every row (after resize/clear/theme change). */
  private _allDirty = true;

  public resize(rows: number): void {
    this._rows = rows;
    this.markAllDirty();
  }

  public markAllDirty(): void {
    this._allDirty = true;
    this._dirtyStart = 0;
    this._dirtyEnd = Math.max(0, this._rows - 1);
  }

  /** Record an inclusive dirty row range from xterm's `renderRows`. */
  public markRange(start: number, end: number): void {
    if (start > end) {
      [start, end] = [end, start];
    }
    start = Math.max(0, start);
    end = Math.min(this._rows - 1, end);
    if (this._dirtyStart === -1) {
      this._dirtyStart = start;
      this._dirtyEnd = end;
    } else {
      this._dirtyStart = Math.min(this._dirtyStart, start);
      this._dirtyEnd = Math.max(this._dirtyEnd, end);
    }
  }

  public get hasDamage(): boolean {
    return this._allDirty || this._dirtyStart !== -1;
  }

  public get isAllDirty(): boolean {
    return this._allDirty;
  }

  /** The inclusive [start, end] dirty range, or null when nothing is dirty. */
  public get range(): [number, number] | null {
    if (!this.hasDamage) {
      return null;
    }
    return [this._dirtyStart === -1 ? 0 : this._dirtyStart, this._dirtyEnd === -1 ? this._rows - 1 : this._dirtyEnd];
  }

  public isRowDirty(row: number): boolean {
    if (this._allDirty) {
      return true;
    }
    return this._dirtyStart !== -1 && row >= this._dirtyStart && row <= this._dirtyEnd;
  }

  /** Clear all damage. Called after a frame has been rendered. */
  public clear(): void {
    this._allDirty = false;
    this._dirtyStart = -1;
    this._dirtyEnd = -1;
  }
}
