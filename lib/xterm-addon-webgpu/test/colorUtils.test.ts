import * as assert from "node:assert/strict";
import {
  toRgba,
  redChannel,
  greenChannel,
  blueChannel,
  alphaChannel,
  rgbaToFloats,
  blend,
  resolveColor,
  type Palette,
} from "../src/util/colorUtils.js";
import { Attributes } from "../src/util/attributes.js";

function makePalette(): Palette {
  const ansi: number[] = [];
  for (let i = 0; i < 256; i++) {
    ansi.push(toRgba(i, i, i, 0xff));
  }
  ansi[1] = toRgba(0xff, 0x00, 0x00); // red
  ansi[2] = toRgba(0x00, 0xff, 0x00); // green
  return {
    foreground: toRgba(0xd0, 0xd0, 0xd0),
    background: toRgba(0x10, 0x10, 0x10),
    cursor: toRgba(0xff, 0xff, 0xff),
    cursorAccent: toRgba(0x00, 0x00, 0x00),
    selectionBackground: toRgba(0x33, 0x55, 0x77, 0x80),
    ansi,
  };
}

describe("colorUtils", () => {
  it("packs and unpacks channels round-trip", () => {
    const c = toRgba(0x12, 0x34, 0x56, 0x78);
    assert.equal(redChannel(c), 0x12);
    assert.equal(greenChannel(c), 0x34);
    assert.equal(blueChannel(c), 0x56);
    assert.equal(alphaChannel(c), 0x78);
  });

  it("keeps packed colors as unsigned 32-bit", () => {
    const c = toRgba(0xff, 0xff, 0xff, 0xff);
    assert.ok(c > 0, "0xFFFFFFFF must stay positive (unsigned)");
    assert.equal(c, 0xffffffff);
  });

  it("normalizes to 0..1 floats", () => {
    const [r, g, b, a] = rgbaToFloats(toRgba(0xff, 0x00, 0x80, 0xff));
    assert.equal(r, 1);
    assert.equal(g, 0);
    assert.ok(Math.abs(b - 0x80 / 255) < 1e-9);
    assert.equal(a, 1);
  });

  describe("blend", () => {
    it("returns fg unchanged when fg is opaque", () => {
      const fg = toRgba(0x11, 0x22, 0x33, 0xff);
      assert.equal(blend(toRgba(0, 0, 0), fg), fg);
    });

    it("returns bg-ish when fg is fully transparent", () => {
      const bg = toRgba(0x40, 0x40, 0x40);
      const out = blend(bg, toRgba(0xff, 0xff, 0xff, 0x00));
      assert.equal(redChannel(out), 0x40);
    });

    it("blends halfway at 50% alpha", () => {
      const out = blend(toRgba(0, 0, 0), toRgba(0xff, 0xff, 0xff, 0x80));
      // 0x80/255 ≈ 0.502 -> round(255*0.502) = 128
      assert.equal(redChannel(out), 128);
      assert.equal(alphaChannel(out), 0xff);
    });
  });

  describe("resolveColor", () => {
    const palette = makePalette();

    it("resolves DEFAULT fg to theme foreground", () => {
      assert.equal(resolveColor(Attributes.CM_DEFAULT, palette, true), palette.foreground);
    });

    it("resolves DEFAULT bg to theme background", () => {
      assert.equal(resolveColor(Attributes.CM_DEFAULT, palette, false), palette.background);
    });

    it("resolves P16 index to the ANSI palette", () => {
      const attr = Attributes.CM_P16 | 1;
      assert.equal(resolveColor(attr, palette, true), palette.ansi[1]);
    });

    it("resolves P256 index to the ANSI palette", () => {
      const attr = Attributes.CM_P256 | 200;
      assert.equal(resolveColor(attr, palette, true), palette.ansi[200]);
    });

    it("resolves RGB color mode directly from the RGB room", () => {
      const attr = Attributes.CM_RGB | (0xaabbcc & Attributes.RGB_MASK);
      const out = resolveColor(attr, palette, true);
      assert.equal(redChannel(out), 0xaa);
      assert.equal(greenChannel(out), 0xbb);
      assert.equal(blueChannel(out), 0xcc);
      assert.equal(alphaChannel(out), 0xff);
    });
  });
});
