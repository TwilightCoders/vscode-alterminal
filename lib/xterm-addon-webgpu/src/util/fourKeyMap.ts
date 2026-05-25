/**
 * A map keyed by four 32-bit integers. The glyph atlas keys each rasterized
 * glyph by `(code, bg, fg, ext)` — the same identity xterm's atlas uses — so a
 * styled glyph is cached independently of the same codepoint in another style.
 *
 * Implemented as nested maps to avoid allocating string keys on the hot path.
 * Mirrors the structure of xterm's `FourKeyMap`.
 */
export class FourKeyMap<T> {
  private _map = new Map<number, Map<number, Map<number, Map<number, T>>>>();
  private _size = 0;

  public get size(): number {
    return this._size;
  }

  public get(a: number, b: number, c: number, d: number): T | undefined {
    return this._map.get(a)?.get(b)?.get(c)?.get(d);
  }

  public set(a: number, b: number, c: number, d: number, value: T): void {
    let mb = this._map.get(a);
    if (!mb) {
      mb = new Map();
      this._map.set(a, mb);
    }
    let mc = mb.get(b);
    if (!mc) {
      mc = new Map();
      mb.set(b, mc);
    }
    let md = mc.get(c);
    if (!md) {
      md = new Map();
      mc.set(c, md);
    }
    if (!md.has(d)) {
      this._size++;
    }
    md.set(d, value);
  }

  public delete(a: number, b: number, c: number, d: number): boolean {
    const md = this._map.get(a)?.get(b)?.get(c);
    if (md && md.delete(d)) {
      this._size--;
      return true;
    }
    return false;
  }

  public clear(): void {
    this._map.clear();
    this._size = 0;
  }

  /** Iterate every stored value (order unspecified). Used by eviction sweeps. */
  public *values(): IterableIterator<T> {
    for (const mb of this._map.values()) {
      for (const mc of mb.values()) {
        for (const md of mc.values()) {
          yield* md.values();
        }
      }
    }
  }
}
