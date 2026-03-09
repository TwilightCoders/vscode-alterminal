/**
 * Detects bare BEL characters (\x07) in PTY data streams while correctly
 * ignoring \x07 used as OSC sequence terminators — even when data is
 * chunked across multiple onData events.
 */

// Matches complete OSC sequences: \x1b] ... \x07  or  \x1b] ... \x1b\\
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export class BellDetector {
  private _pendingOsc = new Map<number, boolean>();

  /**
   * Process a chunk of PTY data and return whether a real BEL was detected.
   */
  detect(tabId: number, data: string): boolean {
    if (data.indexOf("\x07") === -1) {
      this._updateOscState(tabId, data);
      return false;
    }

    const wasInOsc = this._pendingOsc.get(tabId) ?? false;

    // Strip complete OSC sequences (their \x07 terminators are not bells)
    let stripped = data.replace(OSC_PATTERN, "");

    // If the previous chunk ended inside an OSC, the first \x07 here
    // is its terminator — remove it before checking for real bells.
    if (wasInOsc) {
      const termIdx = stripped.indexOf("\x07");
      if (termIdx !== -1) {
        stripped = stripped.substring(0, termIdx) + stripped.substring(termIdx + 1);
      }
    }

    this._updateOscState(tabId, data);
    return stripped.indexOf("\x07") !== -1;
  }

  /**
   * Track whether a chunk ends inside an incomplete OSC sequence.
   */
  private _updateOscState(tabId: number, data: string): void {
    const lastOscStart = data.lastIndexOf("\x1b]");
    if (lastOscStart !== -1) {
      const tail = data.substring(lastOscStart);
      this._pendingOsc.set(tabId, tail.indexOf("\x07") === -1 && tail.indexOf("\x1b\\") === -1);
    } else if (this._pendingOsc.get(tabId)) {
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
