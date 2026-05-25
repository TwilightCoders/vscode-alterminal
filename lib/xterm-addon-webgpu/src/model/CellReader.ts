/**
 * Reconstructs the packed `fg`/`bg`/`ext` attribute integers from xterm's
 * public `IBufferCell` accessors, so the rest of the renderer can operate in
 * the same packed-attribute domain as `@xterm/addon-webgl`.
 *
 * xterm stores attributes packed but only exposes decomposed getters publicly.
 * Rebuilding the packed form here keeps {@link CellColorResolver} and the atlas
 * cache key identical to the WebGL renderer's, while touching only public API.
 */
import { Attributes, BgFlags, ExtFlags, FgFlags } from "../util/attributes.js";
import type { IXtermBufferCell } from "./xtermTypes.js";

export interface IReadCell {
  code: number;
  chars: string;
  width: number;
  /** Packed foreground attribute integer (color mode + RGB/index + flags). */
  fg: number;
  /** Packed background attribute integer. */
  bg: number;
  /** Packed extended attribute integer (underline style, etc.). */
  ext: number;
  bold: boolean;
  italic: boolean;
}

export function readCell(cell: IXtermBufferCell, out: IReadCell): IReadCell {
  out.code = cell.getCode();
  out.chars = cell.getChars();
  out.width = cell.getWidth();

  // Foreground color mode + value.
  let fg: number;
  if (cell.isFgRGB()) {
    fg = Attributes.CM_RGB | (cell.getFgColor() & Attributes.RGB_MASK);
  } else if (cell.isFgPalette()) {
    fg = Attributes.CM_P256 | (cell.getFgColor() & Attributes.PCOLOR_MASK);
  } else {
    fg = Attributes.CM_DEFAULT;
  }
  if (cell.isBold()) fg |= FgFlags.BOLD;
  if (cell.isInverse()) fg |= FgFlags.INVERSE;
  if (cell.isUnderline()) fg |= FgFlags.UNDERLINE;
  if (cell.isInvisible()) fg |= FgFlags.INVISIBLE;
  if (cell.isStrikethrough()) fg |= FgFlags.STRIKETHROUGH;
  if (cell.isBlink()) fg |= FgFlags.BLINK;
  out.fg = fg >>> 0;

  // Background color mode + value.
  let bg: number;
  if (cell.isBgRGB()) {
    bg = Attributes.CM_RGB | (cell.getBgColor() & Attributes.RGB_MASK);
  } else if (cell.isBgPalette()) {
    bg = Attributes.CM_P256 | (cell.getBgColor() & Attributes.PCOLOR_MASK);
  } else {
    bg = Attributes.CM_DEFAULT;
  }
  if (cell.isItalic()) bg |= BgFlags.ITALIC;
  if (cell.isDim()) bg |= BgFlags.DIM;
  if (cell.isOverline()) bg |= BgFlags.OVERLINE;
  out.bg = bg >>> 0;

  // Extended attributes (underline style).
  let ext = 0;
  const style = cell.getUnderlineStyle ? cell.getUnderlineStyle() : 0;
  ext |= (style << 26) & ExtFlags.UNDERLINE_STYLE;
  out.ext = ext >>> 0;

  out.bold = !!(fg & FgFlags.BOLD);
  out.italic = !!(bg & BgFlags.ITALIC);
  return out;
}

export function emptyReadCell(): IReadCell {
  return { code: 0, chars: "", width: 1, fg: 0, bg: 0, ext: 0, bold: false, italic: false };
}
