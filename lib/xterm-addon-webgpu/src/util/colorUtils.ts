/**
 * Color packing/unpacking helpers.
 *
 * Colors are stored as 32-bit `0xRRGGBBAA` integers (xterm's `rgba` format).
 * The shader wants normalized `vec4<f32>` components, so we also expose a
 * conversion to a `[r, g, b, a]` tuple in the 0..1 range.
 */

import { Attributes } from "./attributes.js";

/** A terminal color palette, all entries as packed `0xRRGGBBAA` integers. */
export interface Palette {
  foreground: number;
  background: number;
  cursor: number;
  cursorAccent: number;
  selectionBackground: number;
  /** 256-entry ANSI palette (indices 0..15 are the P16 colors). */
  ansi: number[];
}

/** Pack 8-bit channels into a `0xRRGGBBAA` integer. */
export function toRgba(r: number, g: number, b: number, a = 0xff): number {
  // `>>> 0` keeps the result an unsigned 32-bit integer.
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

export function redChannel(rgba: number): number {
  return (rgba >> 24) & 0xff;
}
export function greenChannel(rgba: number): number {
  return (rgba >> 16) & 0xff;
}
export function blueChannel(rgba: number): number {
  return (rgba >> 8) & 0xff;
}
export function alphaChannel(rgba: number): number {
  return rgba & 0xff;
}

/** Convert a packed `0xRRGGBBAA` to normalized `[r, g, b, a]` in 0..1. */
export function rgbaToFloats(rgba: number): [number, number, number, number] {
  return [
    redChannel(rgba) / 255,
    greenChannel(rgba) / 255,
    blueChannel(rgba) / 255,
    alphaChannel(rgba) / 255,
  ];
}

/**
 * Alpha-blend `fg` over `bg` (both `0xRRGGBBAA`), returning an opaque result.
 * Mirrors xterm's `rgba.blend`.
 */
export function blend(bg: number, fg: number): number {
  const fgA = alphaChannel(fg) / 255;
  if (fgA === 1) {
    return fg;
  }
  const fgR = redChannel(fg);
  const fgG = greenChannel(fg);
  const fgB = blueChannel(fg);
  const bgR = redChannel(bg);
  const bgG = greenChannel(bg);
  const bgB = blueChannel(bg);
  const r = bgR + Math.round((fgR - bgR) * fgA);
  const g = bgG + Math.round((fgG - bgG) * fgA);
  const b = bgB + Math.round((fgB - bgB) * fgA);
  return toRgba(r, g, b, 0xff);
}

/**
 * Resolve a packed cell attribute integer (`fg` or `bg`) into a concrete
 * `0xRRGGBBAA` color using the supplied palette.
 *
 * @param attr   The cell's `fg` or `bg` attribute integer.
 * @param palette Active color palette.
 * @param isFg   Whether this is a foreground (true) or background (false)
 *               attribute — only affects how DEFAULT color mode resolves.
 */
export function resolveColor(attr: number, palette: Palette, isFg: boolean): number {
  switch (attr & Attributes.CM_MASK) {
    case Attributes.CM_RGB:
      // RGB room holds 0xRRGGBB; append full alpha.
      return (((attr & Attributes.RGB_MASK) << 8) | 0xff) >>> 0;
    case Attributes.CM_P16:
    case Attributes.CM_P256:
      return palette.ansi[attr & Attributes.PCOLOR_MASK] ?? (isFg ? palette.foreground : palette.background);
    case Attributes.CM_DEFAULT:
    default:
      return isFg ? palette.foreground : palette.background;
  }
}
