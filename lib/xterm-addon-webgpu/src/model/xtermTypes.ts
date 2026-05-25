/**
 * Structural slices of the xterm.js public API that this renderer reads.
 *
 * We declare them locally rather than importing from `@xterm/xterm` so the
 * package compiles standalone (the real types arrive via the `@xterm/xterm`
 * peer dependency at integration time). Every member here is part of xterm's
 * **public** `IBufferCell`/`IBuffer` surface — no internal reach.
 */

/** A single buffer cell, read via xterm's public `IBufferCell` accessors. */
export interface IXtermBufferCell {
  getChars(): string;
  getCode(): number;
  getWidth(): number;

  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  getFgColor(): number;
  getBgColor(): number;

  isBold(): number;
  isItalic(): number;
  isDim(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
  /** Proposed API — requires `allowProposedApi: true` (Alterminal sets it). */
  getUnderlineStyle?(): number;
}

export interface IXtermBufferLine {
  getCell(x: number, cell?: IXtermBufferCell): IXtermBufferCell | undefined;
}

export interface IXtermBuffer {
  readonly cursorX: number;
  readonly cursorY: number;
  readonly baseY: number;
  readonly viewportY: number;
  readonly length: number;
  getLine(y: number): IXtermBufferLine | undefined;
}
