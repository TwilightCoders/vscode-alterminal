/**
 * Detects bare BEL characters (\x07) in PTY data streams while correctly
 * ignoring \x07 used as OSC sequence terminators — even when data is
 * chunked across multiple onData events. Also detects "agent needs
 * input" notification escapes (iTerm2 OSC 9, kitty OSC 99, ghostty
 * OSC 777) emitted by tools like Claude Code when they finish a turn
 * and want attention. These count as bells for badging purposes.
 */

// Matches complete OSC sequences: \x1b] ... \x07  or  \x1b] ... \x1b\\
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Matches partial OSC at start of a chunk (no leading \x1b, from a cross-chunk split):
// ]digits; ... \x07  — covers ]8;;\x07, ]7;uri\x07, etc.
const PARTIAL_OSC_PATTERN = /\][0-9]+;[^\x07]*\x07/g;

// Notification escapes from Claude Code / iTerm2-compatible tools.
// OSC 9 with first field non-numeric (or anything but `4;`) is a
// notification; OSC 9;4;<state>;<percent>\x07 is the iTerm2 progress-bar
// sub-protocol and MUST NOT trigger a bell (Claude emits these every
// few seconds during long tool calls — would false-flash constantly).
// OSC 99 is kitty's notification protocol; OSC 777 is ghostty's.
// Both terminator forms are accepted (\x07 or \x1b\\).
const NOTIFY_OSC_PATTERN = /\x1b\](?:9(?!;4;)|99|777);[^\x07\x1b]*(?:\x07|\x1b\\)/;

export class BellDetector {
  private _pendingOsc = new Map<number, boolean>();

  /**
   * Process a chunk of PTY data and return whether a real BEL was detected
   * — either a bare \x07 (traditional bell) or an OSC-9/99/777
   * notification ("agent needs input") emitted by Claude Code et al.
   */
  detect(tabId: number, data: string): boolean {
    // Notification escapes count as bells. Check first because the OSC
    // stripping below would otherwise erase them.
    if (NOTIFY_OSC_PATTERN.test(data)) {
      this._updateOscState(tabId, data);
      return true;
    }

    if (data.indexOf("\x07") === -1) {
      this._updateOscState(tabId, data);
      return false;
    }

    const wasInOsc = this._pendingOsc.get(tabId) ?? false;

    // Strip complete OSC sequences (their \x07 terminators are not bells)
    let stripped = data.replace(OSC_PATTERN, "");

    // If the previous chunk ended inside an OSC (split at \x1b boundary),
    // strip all \x07 up to the end of the partial OSC continuation.
    if (wasInOsc) {
      // Remove everything up to and including the first \x07 (OSC terminator)
      const termIdx = stripped.indexOf("\x07");
      if (termIdx !== -1) {
        stripped = stripped.substring(termIdx + 1);
      }
    }

    // Strip partial OSC sequences at chunk start (]8;;uri\x07 without leading \x1b)
    stripped = stripped.replace(PARTIAL_OSC_PATTERN, "");

    this._updateOscState(tabId, data);
    return stripped.indexOf("\x07") !== -1;
  }

  /**
   * Track whether a chunk ends inside an incomplete OSC sequence.
   * An OSC is "pending" if the chunk ends with \x1b] or \x1b followed
   * by content that hasn't been terminated yet.
   */
  private _updateOscState(tabId: number, data: string): void {
    // Check for \x1b] (standard OSC start)
    const lastOscStart = data.lastIndexOf("\x1b]");
    if (lastOscStart !== -1) {
      const tail = data.substring(lastOscStart);
      this._pendingOsc.set(tabId, tail.indexOf("\x07") === -1 && tail.indexOf("\x1b\\") === -1);
      return;
    }
    // Check if chunk ends with lone \x1b (next chunk starts with ])
    if (data.endsWith("\x1b")) {
      this._pendingOsc.set(tabId, true);
      return;
    }
    if (this._pendingOsc.get(tabId)) {
      if (data.indexOf("\x07") !== -1 || data.indexOf("\x1b\\") !== -1) {
        this._pendingOsc.set(tabId, false);
      }
    }
  }

  /**
   * Clean up state for a disposed tab.
   */
  delete(tabId: number): void {
    this._pendingOsc.delete(tabId);
  }
}
