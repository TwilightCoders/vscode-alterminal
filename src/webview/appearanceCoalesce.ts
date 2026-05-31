/**
 * Compute which xterm `terminal.options` keys to write when an
 * `alterminal.*` appearance config update arrives at a live terminal.
 *
 * The xterm constructor uses `appearance.X || fallback` for several keys
 * (fontFamily, fontWeight, fontWeightBold, fontSize, lineHeight,
 * wordSeparators), where empty string / 0 means "no override". Pushing
 * such a value over the construction-time fallback silently breaks the
 * terminal — `fontFamily = ""` in particular makes the canvas font
 * assignment a no-op, leaving xterm to measure and rasterize against the
 * browser default `10px sans-serif`. The visible artifact is huge
 * letter-spacing (small glyphs in normal-sized cells).
 *
 * This function returns ONLY the keys whose effective value should be
 * written, so callers can do `for (k of result) opts[k] = result[k]`
 * without re-implementing the truthy-vs-strict semantics.
 *
 * Semantics per key, mirroring the xterm constructor:
 *   - fontFamily, fontWeight, fontWeightBold, fontSize, lineHeight,
 *     wordSeparator: TRUTHY-skip (empty string / 0 / undefined / null
 *     all mean "no override" — preserve construction-time fallback).
 *   - letterSpacing, minimumContrastRatio, cursorBlink, cursorStyle,
 *     smoothScrollDuration: STRICT-skip (only undefined / null skip;
 *     0 / false are legitimate values).
 */
export interface AppearanceInput {
  cursorBlinking?: unknown;
  cursorStyle?: unknown;
  fontSize?: unknown;
  fontFamily?: unknown;
  fontWeight?: unknown;
  fontWeightBold?: unknown;
  lineHeight?: unknown;
  letterSpacing?: unknown;
  minimumContrastRatio?: unknown;
  wordSeparators?: unknown;
  smoothScrolling?: unknown;
}

export function coalesceAppearance(
  current: Record<string, unknown>,
  appearance: AppearanceInput,
): Record<string, unknown> {
  const writes: Record<string, unknown> = {};
  const setIfChanged = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (current[key] !== value) writes[key] = value;
  };
  const setIfTruthy = (key: string, value: unknown): void => {
    if (!value) return;
    if (current[key] !== value) writes[key] = value;
  };

  setIfChanged("cursorBlink", appearance.cursorBlinking);
  setIfChanged("cursorStyle", appearance.cursorStyle);
  setIfTruthy("fontSize", appearance.fontSize);
  setIfTruthy("fontFamily", appearance.fontFamily);
  setIfTruthy("fontWeight", appearance.fontWeight);
  setIfTruthy("fontWeightBold", appearance.fontWeightBold);
  setIfTruthy("lineHeight", appearance.lineHeight);
  setIfChanged("letterSpacing", appearance.letterSpacing);
  setIfChanged("minimumContrastRatio", appearance.minimumContrastRatio);
  setIfTruthy("wordSeparator", appearance.wordSeparators);
  if (typeof appearance.smoothScrolling === "boolean") {
    setIfChanged("smoothScrollDuration", appearance.smoothScrolling ? 125 : 0);
  }
  return writes;
}
