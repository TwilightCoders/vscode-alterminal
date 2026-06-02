/**
 * Atlas cache-key computation.
 *
 * xterm stores a cell's glyph either as a single code point — `getCode()`
 * returns it faithfully — or, for COMBINED cells (an emoji + U+FE0F variation
 * selector, a ZWJ sequence, a base char + combining mark), as the trailing
 * code point only. So keying the glyph atlas by the numeric code alone makes
 * every VS16 emoji (⚠️ ✏️ ❤️ 🗄️ …) collide to code 0xFE0F and render as
 * whichever one was rasterized into that slot first (the "everything becomes a
 * filing cabinet" bug). Composite glyphs must be keyed by their full string.
 *
 * We keep the fast numeric {@link FourKeyMap} by NAMESPACING the key:
 *   - simple glyph    → (code, bold, italic, 0)
 *   - composite glyph → (internedStringId, bold, italic, 1)
 * The namespace slot (0 vs 1) guarantees an interned id can never collide with
 * a real code point of the same numeric value.
 */

/** True when `text` is more than one Unicode code point (i.e. a combined cell). */
export function isCompositeGlyph(text: string): boolean {
  if (text.length <= 1) {
    return false; // empty, or a single UTF-16 code unit (BMP char)
  }
  let count = 0;
  for (const _ of text) {
    // Iterating a string yields code points (handles surrogate pairs), so a lone
    // astral emoji is count 1 (fast path) while ⚠️ / ZWJ runs are count > 1.
    if (++count > 1) {
      return true;
    }
  }
  return false; // a single astral code point (a surrogate pair, length 2)
}

export type GlyphKeyTuple = [number, number, number, number];

/**
 * Compute the 4-int atlas cache key for a glyph. `intern` maps a composite
 * glyph string to a stable unique id (the atlas owns the interning table).
 */
export function computeGlyphKey(
  code: number,
  text: string,
  bold: boolean,
  italic: boolean,
  intern: (text: string) => number,
): GlyphKeyTuple {
  const b = bold ? 1 : 0;
  const i = italic ? 1 : 0;
  return isCompositeGlyph(text) ? [intern(text), b, i, 1] : [code, b, i, 0];
}
