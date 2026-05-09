/**
 * In-memory queue of string chunks bounded by both an entry count and a
 * total byte budget. Used to buffer PTY output while the webview is
 * hidden — without a byte cap, a single tab spamming output can hold
 * gigabytes of strings (libuv reads ~64KB chunks; 10000 entries × 64KB =
 * 640MB worst case per tab).
 *
 * Eviction policy: drop oldest first. If a single chunk exceeds maxBytes
 * we still keep it (otherwise we'd discard the very thing we just got).
 */

export interface BoundedChunkBufferOptions {
  /** Drop oldest when length exceeds this. */
  maxChunks: number;
  /** Drop oldest when totalBytes exceeds this (keeps at least the newest entry). */
  maxBytes: number;
}

export class BoundedChunkBuffer {
  private chunks: string[] = [];
  private bytes = 0;
  private droppedHead = 0; // index into chunks[] of the logical front
  private readonly opts: BoundedChunkBufferOptions;

  constructor(opts: BoundedChunkBufferOptions) {
    this.opts = opts;
  }

  get length(): number {
    return this.chunks.length - this.droppedHead;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  push(chunk: string): void {
    if (chunk.length === 0) return;

    this.chunks.push(chunk);
    this.bytes += chunk.length;
    this.enforceCaps();

    // Compact occasionally to keep the underlying array from growing
    // unbounded when we evict from the front frequently.
    if (this.droppedHead > 1024 && this.droppedHead > this.length) {
      this.chunks = this.chunks.slice(this.droppedHead);
      this.droppedHead = 0;
    }
  }

  /** Concatenate all live chunks into a single string and clear the buffer. */
  flush(): string {
    if (this.length === 0) {
      this.chunks = [];
      this.droppedHead = 0;
      this.bytes = 0;
      return "";
    }
    const live =
      this.droppedHead === 0
        ? this.chunks
        : this.chunks.slice(this.droppedHead);
    const out = live.join("");
    this.chunks = [];
    this.droppedHead = 0;
    this.bytes = 0;
    return out;
  }

  private enforceCaps(): void {
    // Entry-count cap.
    while (this.length > this.opts.maxChunks) {
      this.bytes -= this.chunks[this.droppedHead].length;
      this.droppedHead++;
    }
    // Byte cap — but always keep at least the newest entry, otherwise a
    // single oversized chunk would empty the buffer entirely.
    while (this.length > 1 && this.bytes > this.opts.maxBytes) {
      this.bytes -= this.chunks[this.droppedHead].length;
      this.droppedHead++;
    }
  }
}
