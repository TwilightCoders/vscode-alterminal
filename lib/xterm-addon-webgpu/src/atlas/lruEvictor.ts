/**
 * Frame-marked LRU bookkeeping for atlas glyph eviction.
 *
 * Each glyph allocation is associated with a numeric id. Every frame the
 * renderer calls {@link beginFrame}; for each glyph it draws it calls
 * {@link markUsed}. When the packer reports out-of-room, the renderer asks for
 * eviction candidates — the least-recently-used glyphs that were **not** touched
 * in the current frame.
 *
 * The current-frame guard is critical: evicting a glyph that the in-progress
 * frame still references would corrupt that frame (the very class of bug — atlas
 * bleed — that motivated replacing the WebGL renderer). So candidates are
 * strictly limited to ids with `lastUsedFrame < currentFrame`.
 */
export class LruEvictor {
  private _frame = 0;
  private _lastUsed = new Map<number, number>();

  public get currentFrame(): number {
    return this._frame;
  }

  public get size(): number {
    return this._lastUsed.size;
  }

  public beginFrame(): void {
    this._frame++;
  }

  public markUsed(id: number): void {
    this._lastUsed.set(id, this._frame);
  }

  public has(id: number): boolean {
    return this._lastUsed.has(id);
  }

  public remove(id: number): void {
    this._lastUsed.delete(id);
  }

  public clear(): void {
    this._lastUsed.clear();
  }

  /**
   * Return up to `count` eviction candidates, least-recently-used first.
   * Only glyphs untouched in the current frame are eligible. Returns fewer
   * than `count` (possibly zero) when not enough stale glyphs exist — in which
   * case the caller must grow the atlas (add a layer) rather than evict.
   */
  public selectEvictable(count: number): number[] {
    const candidates: { id: number; frame: number }[] = [];
    for (const [id, frame] of this._lastUsed) {
      if (frame < this._frame) {
        candidates.push({ id, frame });
      }
    }
    candidates.sort((a, b) => a.frame - b.frame);
    return candidates.slice(0, count).map((c) => c.id);
  }
}
