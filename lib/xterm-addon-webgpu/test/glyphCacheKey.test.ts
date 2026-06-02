import * as assert from "node:assert/strict";
import { isCompositeGlyph, computeGlyphKey } from "../src/util/glyphCacheKey.js";

describe("isCompositeGlyph", () => {
  it("false for a single ASCII char", () => {
    assert.equal(isCompositeGlyph("A"), false);
  });

  it("false for empty string", () => {
    assert.equal(isCompositeGlyph(""), false);
  });

  it("false for a single astral emoji (one code point, surrogate pair)", () => {
    // U+1F642 SLIGHTLY SMILING FACE — getCode() returns the full code point, so
    // the numeric key is faithful; this must stay on the fast path.
    assert.equal(isCompositeGlyph("\u{1F642}"), false);
  });

  it("true for an emoji with VS16 (⚠️ = U+26A0 U+FE0F)", () => {
    assert.equal(isCompositeGlyph("⚠️"), true);
  });

  it("true for the file-cabinet emoji with VS16 (🗄️ = U+1F5C4 U+FE0F)", () => {
    assert.equal(isCompositeGlyph("\u{1F5C4}️"), true);
  });

  it("true for a ZWJ family sequence", () => {
    assert.equal(isCompositeGlyph("\u{1F468}‍\u{1F469}‍\u{1F467}"), true);
  });

  it("true for a base letter + combining accent", () => {
    assert.equal(isCompositeGlyph("é"), true);
  });
});

describe("computeGlyphKey", () => {
  const makeIntern = () => {
    const m = new Map<string, number>();
    let next = 1000;
    return (s: string) => {
      let id = m.get(s);
      if (id === undefined) {
        id = next++;
        m.set(s, id);
      }
      return id;
    };
  };

  it("simple glyph keys by code in namespace 0", () => {
    assert.deepEqual(computeGlyphKey(0x41, "A", false, false, makeIntern()), [0x41, 0, 0, 0]);
  });

  it("single astral emoji keys by its full code point in namespace 0", () => {
    assert.deepEqual(
      computeGlyphKey(0x1f642, "\u{1F642}", false, false, makeIntern()),
      [0x1f642, 0, 0, 0],
    );
  });

  it("bold/italic land in slots 1 and 2", () => {
    assert.deepEqual(computeGlyphKey(0x41, "A", true, false, makeIntern()), [0x41, 1, 0, 0]);
    assert.deepEqual(computeGlyphKey(0x41, "A", false, true, makeIntern()), [0x41, 0, 1, 0]);
  });

  it("REGRESSION: two distinct VS16 emoji sharing code 0xFE0F get DIFFERENT keys", () => {
    const intern = makeIntern();
    // xterm reports the trailing code point (0xFE0F) for BOTH combined cells —
    // this is exactly the collision that rendered every emoji as a filing cabinet.
    const warn = computeGlyphKey(0xfe0f, "⚠️", false, false, intern);
    const cab = computeGlyphKey(0xfe0f, "\u{1F5C4}️", false, false, intern);
    assert.equal(warn[3], 1, "composite glyphs use namespace 1");
    assert.equal(cab[3], 1);
    assert.notDeepEqual(warn, cab, "distinct emoji must not collide to one atlas slot");
  });

  it("the same composite string is stable across calls (same key)", () => {
    const intern = makeIntern();
    const a = computeGlyphKey(0xfe0f, "⚠️", false, false, intern);
    const b = computeGlyphKey(0xfe0f, "⚠️", false, false, intern);
    assert.deepEqual(a, b);
  });

  it("an interned id can never collide with a real code of the same value", () => {
    const intern = makeIntern(); // interned ids start at 1000
    const simple = computeGlyphKey(1000, "Ϩ", false, false, intern); // U+03E8 == 1000, simple
    const comp = computeGlyphKey(0xfe0f, "⚠️", false, false, intern); // first intern → 1000
    assert.deepEqual(simple, [1000, 0, 0, 0]);
    assert.equal(comp[0], 1000);
    assert.equal(comp[3], 1);
    assert.notDeepEqual(simple, comp); // separated by the namespace slot
  });
});
