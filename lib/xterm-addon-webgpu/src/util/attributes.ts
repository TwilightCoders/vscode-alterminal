/**
 * xterm.js cell-attribute bit layout.
 *
 * These constants mirror xterm.js's `common/buffer/Constants.ts` exactly. They
 * are part of xterm's stable in-memory wire format for a cell's packed `fg`,
 * `bg` and `ext` attribute integers (each a u32). We redeclare them here rather
 * than import from xterm internals because those modules are not part of the
 * published package surface.
 *
 * Derived from xterm.js, Copyright (c) 2019 The xterm.js authors, MIT License.
 */

/** Masks for the `content` integer of a buffer cell. */
export const enum Content {
  /** bits 1..21 — Unicode codepoint (max 0x10FFFF). */
  CODEPOINT_MASK = 0x1fffff,
  /** bit 22 — set when the cell holds combined (multi-codepoint) content. */
  IS_COMBINED_MASK = 0x200000,
  /** bits 1..22 — any string content at all. */
  HAS_CONTENT_MASK = 0x3fffff,
  /** bits 23..24 — wcwidth value (0..2). */
  WIDTH_MASK = 0xc00000,
  WIDTH_SHIFT = 22,
}

/** Color + RGB layout shared by the `fg` and `bg` attribute integers. */
export const enum Attributes {
  /** bits 1..8 — blue (RGB), or palette color index (P16/P256). */
  BLUE_MASK = 0xff,
  BLUE_SHIFT = 0,
  PCOLOR_MASK = 0xff,
  PCOLOR_SHIFT = 0,
  /** bits 9..16 — green (RGB). */
  GREEN_MASK = 0xff00,
  GREEN_SHIFT = 8,
  /** bits 17..24 — red (RGB). */
  RED_MASK = 0xff0000,
  RED_SHIFT = 16,
  /** bits 25..26 — color mode: DEFAULT (0) | P16 (1) | P256 (2) | RGB (3). */
  CM_MASK = 0x3000000,
  CM_DEFAULT = 0,
  CM_P16 = 0x1000000,
  CM_P256 = 0x2000000,
  CM_RGB = 0x3000000,
  /** bits 1..24 — RGB room. */
  RGB_MASK = 0xffffff,
}

/** Flags carried in the upper bits of the `fg` attribute integer. */
export const enum FgFlags {
  INVERSE = 0x4000000,
  BOLD = 0x8000000,
  UNDERLINE = 0x10000000,
  BLINK = 0x20000000,
  INVISIBLE = 0x40000000,
  STRIKETHROUGH = 0x80000000,
}

/** Flags carried in the upper bits of the `bg` attribute integer. */
export const enum BgFlags {
  ITALIC = 0x4000000,
  DIM = 0x8000000,
  HAS_EXTENDED = 0x10000000,
  PROTECTED = 0x20000000,
  OVERLINE = 0x40000000,
}

/** Flags carried in the `ext` attribute integer (present when HAS_EXTENDED). */
export const enum ExtFlags {
  /** bits 27..29 — underline style (see {@link UnderlineStyle}). */
  UNDERLINE_STYLE = 0x1c000000,
  /** bits 30..32 — a per-glyph variant offset (e.g. dotted-underline phase). */
  VARIANT_OFFSET = 0xe0000000,
}

export const enum UnderlineStyle {
  NONE = 0,
  SINGLE = 1,
  DOUBLE = 2,
  CURLY = 3,
  DOTTED = 4,
  DASHED = 5,
}

export const NULL_CELL_CODE = 0;
export const WHITESPACE_CELL_CODE = 32;

/** Extract the underline style enum from a cell's `ext` integer. */
export function extractUnderlineStyle(ext: number): UnderlineStyle {
  return (ext & ExtFlags.UNDERLINE_STYLE) >> 26;
}

/** Extract the color mode (DEFAULT/P16/P256/RGB) from an `fg`/`bg` integer. */
export function colorMode(attr: number): number {
  return attr & Attributes.CM_MASK;
}
