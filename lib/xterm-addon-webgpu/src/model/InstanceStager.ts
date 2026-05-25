/**
 * A growable CPU-side staging array for per-instance GPU data.
 *
 * The renderer builds one of these per pipeline each frame (glyphs, rectangles,
 * decorations), pushing a fixed number of floats per instance. The backing
 * `Float32Array` grows by doubling and is reused across frames. {@link used}
 * returns just the populated prefix, ready to hand to `queue.writeBuffer`.
 *
 * This is deliberately GPU-free so its growth and packing logic can be unit
 * tested in plain Node.
 */
export class InstanceStager {
  private _data: Float32Array;
  private _count = 0;

  constructor(
    public readonly floatsPerInstance: number,
    initialInstances = 256,
  ) {
    this._data = new Float32Array(floatsPerInstance * initialInstances);
  }

  public get count(): number {
    return this._count;
  }

  /** The populated prefix of the backing array (length `count * floatsPerInstance`). */
  public get used(): Float32Array {
    return this._data.subarray(0, this._count * this.floatsPerInstance);
  }

  /** Byte length of the populated region. */
  public get usedByteLength(): number {
    return this._count * this.floatsPerInstance * Float32Array.BYTES_PER_ELEMENT;
  }

  public reset(): void {
    this._count = 0;
  }

  /**
   * Append one instance. `values.length` must equal `floatsPerInstance`. Grows
   * the backing array if needed.
   */
  public push(values: ArrayLike<number>): void {
    if (values.length !== this.floatsPerInstance) {
      throw new Error(
        `InstanceStager.push expected ${this.floatsPerInstance} floats, got ${values.length}`,
      );
    }
    const offset = this._count * this.floatsPerInstance;
    if (offset + this.floatsPerInstance > this._data.length) {
      this._grow();
    }
    this._data.set(values, offset);
    this._count++;
  }

  private _grow(): void {
    const next = new Float32Array(this._data.length * 2);
    next.set(this._data);
    this._data = next;
  }
}
