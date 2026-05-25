import * as assert from "node:assert/strict";
import { CellColorResolver } from "../src/model/CellColorResolver.js";
import { toRgba, type Palette } from "../src/util/colorUtils.js";
import { Attributes, FgFlags, BgFlags } from "../src/util/attributes.js";

function makePalette(): Palette {
  const ansi: number[] = [];
  for (let i = 0; i < 256; i++) {
    ansi.push(toRgba(i, 0, 0, 0xff));
  }
  return {
    foreground: toRgba(0xd0, 0xd0, 0xd0),
    background: toRgba(0x10, 0x10, 0x10),
    cursor: toRgba(0xff, 0xff, 0xff),
    cursorAccent: toRgba(0, 0, 0),
    selectionBackground: toRgba(0x33, 0x55, 0x77, 0xff),
    ansi,
  };
}

describe("CellColorResolver", () => {
  const palette = makePalette();
  const r = new CellColorResolver();

  it("resolves default fg/bg to theme colors", () => {
    const out = r.resolve({ fg: 0, bg: 0, selected: false, focused: true }, palette);
    assert.equal(out.fg, palette.foreground);
    assert.equal(out.bg, palette.background);
    assert.equal(out.dim, false);
  });

  it("swaps fg and bg under the inverse flag", () => {
    const out = r.resolve(
      { fg: FgFlags.INVERSE, bg: 0, selected: false, focused: true },
      palette,
    );
    // Inverse with default fg/bg: fg becomes (default bg), bg becomes (default fg).
    assert.equal(out.fg, (palette.background | 0xff) >>> 0);
    assert.equal(out.bg, (palette.foreground | 0xff) >>> 0);
  });

  it("hides the glyph under the invisible flag (fg == bg)", () => {
    const out = r.resolve(
      { fg: FgFlags.INVISIBLE, bg: 0, selected: false, focused: true },
      palette,
    );
    assert.equal(out.fg, out.bg);
  });

  it("flags dim cells", () => {
    const out = r.resolve({ fg: 0, bg: BgFlags.DIM, selected: false, focused: true }, palette);
    assert.equal(out.dim, true);
  });

  it("paints the selection background when selected and focused", () => {
    const out = r.resolve({ fg: 0, bg: 0, selected: true, focused: true }, palette);
    // selectionBackground is opaque here, so it replaces the bg entirely.
    assert.equal(out.bg, palette.selectionBackground);
  });

  it("resolves RGB foreground directly", () => {
    const fg = Attributes.CM_RGB | (0xaabbcc & Attributes.RGB_MASK);
    const out = r.resolve({ fg, bg: 0, selected: false, focused: true }, palette);
    assert.equal((out.fg >>> 8) & 0xffffff, 0xaabbcc);
  });
});
