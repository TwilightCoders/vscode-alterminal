/**
 * Resolves a cell's raw packed `fg`/`bg`/`ext` attributes into concrete
 * `0xRRGGBBAA` foreground and background colors, applying inverse, invisible,
 * dim and selection overrides.
 *
 * This is a focused, dependency-free port of the parts of
 * `@xterm/addon-webgl`'s `CellColorResolver` that don't require xterm's
 * internal theme/decoration services. The decoration-service overrides
 * (per-cell foreground/background decorations) are intentionally out of scope
 * for the initial renderer and noted for the parity phase.
 */

import { BgFlags, FgFlags } from "../util/attributes.js";
import { blend, resolveColor, type Palette } from "../util/colorUtils.js";

export interface IResolveInput {
  /** Raw cell foreground attribute integer. */
  fg: number;
  /** Raw cell background attribute integer. */
  bg: number;
  /** Whether this cell is within the active selection. */
  selected: boolean;
  /** Whether the terminal is focused (selection uses a dimmer color if not). */
  focused: boolean;
}

export interface IResolvedColors {
  /** Final foreground color, `0xRRGGBBAA`. */
  fg: number;
  /** Final background color, `0xRRGGBBAA`. */
  bg: number;
  /** Whether the dim attribute applies (shader halves fg alpha). */
  dim: boolean;
}

const SELECTION_INACTIVE_ALPHA = 0x80;

export class CellColorResolver {
  public readonly result: IResolvedColors = { fg: 0, bg: 0, dim: false };

  public resolve(input: IResolveInput, palette: Palette): IResolvedColors {
    const { fg, bg } = input;

    let fgRgba = resolveColor(fg, palette, true);
    let bgRgba = resolveColor(bg, palette, false);

    // Inverse: swap fg/bg. Note default-vs-default still swaps meaningfully
    // because resolveColor already mapped DEFAULT to the theme fg/bg.
    if (fg & FgFlags.INVERSE) {
      const tmp = fgRgba;
      fgRgba = (bgRgba | 0xff) >>> 0; // force opaque
      bgRgba = (tmp | 0xff) >>> 0;
    }

    // Invisible: paint fg as bg so the glyph disappears but spacing is kept.
    if (fg & FgFlags.INVISIBLE) {
      fgRgba = bgRgba;
    }

    // Selection: blend the selection color over the resolved background.
    if (input.selected) {
      const sel = input.focused
        ? palette.selectionBackground
        : ((palette.selectionBackground & 0xffffff00) | SELECTION_INACTIVE_ALPHA) >>> 0;
      bgRgba = blend(bgRgba, sel);
    }

    this.result.fg = fgRgba;
    this.result.bg = bgRgba;
    // DIM is stored in the bg flag space but applies to the foreground.
    this.result.dim = !!(bg & BgFlags.DIM);
    return this.result;
  }
}
