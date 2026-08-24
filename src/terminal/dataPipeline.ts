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
// - CSI 1 t / CSI 5 t: XTWINOPS de-iconify / raise-window-to-front. VS Code's
//   integrated terminal honours these and pulls focus to ITS terminal. We match
//   ONLY the single-param raise/restore ops ([15]t) — never SGR (...m), erase
//   (...J), cursor (...H), iconify (CSI 2 t), or multi-param XTWINOPS (CSI 10;5 t).
export const FILTER_PATTERN = /\x1b(?:\](?:633|133|7|9|1337);[^\x07\x1b]*(?:\x07|\x1b\\)|\[\?1004[hl]|\[[15]t)/g;

// GENUINE "raise / focus this window" requests. When suppression is on we
// don't merely drop these — we redirect: focus OUR panel view instead of
// letting VS Code grab its integrated terminal. Kept deliberately narrow
// (no shell-integration noise, which fires on every prompt) so focus never
// thrashes. Covers XTWINOPS raise/de-iconify and iTerm2 RequestAttention
// (only affirmative variants — "no" cancels attention, so it doesn't grab).
export const FOCUS_REQUEST_PATTERN =
  /\x1b(?:\[[15]t|\]1337;RequestAttention=(?:yes|once|fireworks)(?:\x07|\x1b\\))/g;

// Diagnostic-only: every focus-relevant escape worth attributing an observed
// steal to — whether or not we strip it. Excludes OSC 9;9 (ConEmu CWD) which
// is high-frequency noise, not a focus signal. Captures OSC 9 notifications,
// OSC 777, OSC 1337, DEC ?1004 focus reporting, and ANY CSI window op (…t).
export const FOCUS_SUSPECT_PATTERN =
  /\x1b(?:\](?:9;(?!9;)|777;|1337;)[^\x07\x1b]*(?:\x07|\x1b\\)|\[\?1004[hl]|\[[0-9;]*t)/g;

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
 * True iff `data` contains a GENUINE "raise / focus this window" request.
 * The caller redirects this to Alterminal's own view (alterminalView.focus)
 * rather than letting VS Code honour it on its integrated terminal. Narrow
 * by design — shell-integration / CWD sequences fire every prompt and must
 * NOT trigger a focus grab.
 */
export function detectFocusRequest(data: string): boolean {
  FOCUS_REQUEST_PATTERN.lastIndex = 0;
  return FOCUS_REQUEST_PATTERN.test(data);
}

/**
 * Diagnostic: list the focus-relevant escape sequences present in `data`,
 * with control bytes escaped for display (ESC → "\e", BEL → "\a"). Used to
 * attribute an observed focus steal to the actual bytes on the wire instead
 * of guessing. Returns [] for ordinary output.
 */
export function describeFocusSuspects(data: string): string[] {
  FOCUS_SUSPECT_PATTERN.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = FOCUS_SUSPECT_PATTERN.exec(data)) !== null) {
    out.push(m[0].replace(/\x1b/g, "\\e").replace(/\x07/g, "\\a"));
  }
  return out;
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
    const decoded = decodeURIComponent(new URL(lastUrl).pathname);
    return normalizeOsc7Path(decoded);
  } catch {
    return null;
  }
}

/**
 * A file URI's pathname always starts with "/", which is correct on POSIX but
 * produces "/C:/Users/me" for a Windows cwd — not a usable path. Strip the
 * leading slash for drive-letter paths and restore backslash separators.
 *
 * Deliberately narrow: the authority component is NOT treated as a UNC host,
 * because our own POSIX integration scripts put $HOSTNAME there
 * (file://$HOSTNAME$PWD), so reading it as a share would corrupt every
 * non-Windows path. Only the drive-letter shape is rewritten; everything else
 * is returned untouched.
 */
export function normalizeOsc7Path(pathname: string): string {
  if (/^\/[A-Za-z]:(\/|$)/.test(pathname)) {
    return pathname.slice(1).replace(/\//g, "\\");
  }
  return pathname;
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
