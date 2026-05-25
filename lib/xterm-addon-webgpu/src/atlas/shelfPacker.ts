/**
 * Shelf-packing allocator for the glyph atlas.
 *
 * Glyphs are packed onto horizontal "shelves" within a fixed `width x height`
 * region. A new glyph is placed on the shortest existing shelf that can still
 * fit it horizontally; if none fits, a new shelf is opened below the last one.
 * When no shelf fits and there's no vertical room left, `allocate` returns null
 * and the caller triggers LRU eviction + a repack.
 *
 * Shelf packing is simple, fast, and—per Mozilla's `etagere` retrospective—
 * beats guillotine packing on real terminal glyph workloads, where glyph
 * heights cluster tightly around the line height.
 */

export interface IPackPosition {
  x: number;
  y: number;
}

interface IShelf {
  y: number;
  height: number;
  /** Current horizontal cursor — next free x on this shelf. */
  cursorX: number;
}

export class ShelfPacker {
  private _shelves: IShelf[] = [];
  private _nextY = 0;

  constructor(
    public readonly width: number,
    public readonly height: number,
  ) {}

  /**
   * Allocate a `w x h` region. Returns its top-left position, or null if it
   * does not fit anywhere in the current atlas.
   */
  public allocate(w: number, h: number): IPackPosition | null {
    if (w > this.width || h > this.height) {
      return null; // Cannot ever fit.
    }

    // Find the shelf with the smallest height that still fits this glyph both
    // vertically (shelf tall enough) and horizontally (room remaining).
    let best: IShelf | undefined;
    for (const shelf of this._shelves) {
      if (shelf.height >= h && shelf.cursorX + w <= this.width) {
        if (!best || shelf.height < best.height) {
          best = shelf;
        }
      }
    }

    if (best) {
      const pos = { x: best.cursorX, y: best.y };
      best.cursorX += w;
      return pos;
    }

    // Open a new shelf if there's vertical room.
    if (this._nextY + h <= this.height) {
      const shelf: IShelf = { y: this._nextY, height: h, cursorX: w };
      this._shelves.push(shelf);
      const pos = { x: 0, y: this._nextY };
      this._nextY += h;
      return pos;
    }

    return null; // Out of room.
  }

  /** Fraction of the atlas height consumed by opened shelves (0..1). */
  public get verticalFill(): number {
    return this.height === 0 ? 0 : this._nextY / this.height;
  }

  public get shelfCount(): number {
    return this._shelves.length;
  }

  /** Reset to an empty atlas (used after a full eviction/repack). */
  public reset(): void {
    this._shelves = [];
    this._nextY = 0;
  }
}
