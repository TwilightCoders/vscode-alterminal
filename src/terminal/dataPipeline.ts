/**
 * Pure data-processing functions for the PTY data pipeline.
 *
 * These functions extract metadata, filter sequences, and transform
 * terminal data. They have no dependencies on VS Code APIs, PTY handles,
 * or webview references — just regex and string operations.
 */

// Combined pattern for escape sequences to filter out in a single pass:
// - OSC 633: VS Code shell integration protocol
// - OSC 133: FinalTerm shell integration (VS Code also responds to this)
// - OSC 7: Current working directory (can trigger VS Code behavior)
// - OSC 9: Windows Terminal notifications + ConEmu/Cmder CWD (9;9). VS Code's
//   integrated terminal listens for these and steals focus when seen.
// - OSC 1337: iTerm2 protocol (sometimes used by tools)
// - DEC private mode ?1004: Focus reporting (in/out events VS Code may intercept)
export const FILTER_PATTERN = /\x1b(?:\](?:633|133|7|9|1337);[^\x07\x1b]*(?:\x07|\x1b\\)|\[\?1004[hl])/g;

// Extraction patterns (separate from filter because we need capture groups)
export const CWD_OSC_PATTERN = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

// iTerm2 SetUserVar: \x1b]1337;SetUserVar=name=base64value\x07
export const USER_VAR_PATTERN = /\x1b\]1337;SetUserVar=([A-Za-z0-9_]+)=([A-Za-z0-9+/=]*?)(?:\x07|\x1b\\)/g;

/**
 * Filter out escape sequences that can cause VS Code to steal focus.
 * Includes VS Code shell integration sequences and focus reporting mode.
 */
export function filterVSCodeSequences(data: string): string {
  FILTER_PATTERN.lastIndex = 0;
  return data.replace(FILTER_PATTERN, '');
}

/**
 * Extract the most recent working directory from OSC 7 sequences in data.
 * OSC 7 format: \x1b]7;file://hostname/path\x07
 */
export function extractCwdFromOsc7(data: string): string | null {
  CWD_OSC_PATTERN.lastIndex = 0;
  let lastUrl: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = CWD_OSC_PATTERN.exec(data)) !== null) {
    lastUrl = m[1];
  }
  if (!lastUrl) return null;
  try {
    return decodeURIComponent(new URL(lastUrl).pathname);
  } catch {
    return null;
  }
}

/**
 * Extract SetUserVar key-value pairs from OSC 1337 sequences in data.
 */
export function extractUserVars(data: string): Map<string, string> | null {
  let result: Map<string, string> | null = null;
  USER_VAR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = USER_VAR_PATTERN.exec(data)) !== null) {
    const key = match[1];
    const base64Value = match[2];
    try {
      const value = Buffer.from(base64Value, "base64").toString("utf-8");
      if (!result) result = new Map();
      result.set(key, value);
    } catch {
      // Skip invalid base64
    }
  }
  return result;
}

/**
 * Replace BEL (\x07) with ST (\x1b\\) so xterm.js doesn't fire onBell
 * for OSC terminators. BellDetector should run BEFORE this.
 */
export function replaceBelWithST(data: string): string {
  if (data.indexOf("\x07") === -1) return data;
  return data.replace(/\x07/g, "\x1b\\");
}
