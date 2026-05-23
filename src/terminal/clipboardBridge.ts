/**
 * Clipboard bridge — host-side helper for getting binary content into
 * a TUI app via the system clipboard.
 *
 * Why this exists: terminals are text-only pipes. When the user drags
 * an image into the webview, the bytes can't reach the program running
 * in the PTY (Claude Code, anything) by typing — only text characters
 * survive that path. But many apps already implement clipboard-paste,
 * including image data: Claude Code intercepts Ctrl-V (byte 0x16) and
 * calls the OS clipboard API itself, picking up image bytes directly.
 *
 * So we briefly stage the dropped image on the system clipboard, type
 * the Ctrl-V byte into the PTY for the app to intercept, then restore
 * whatever the user had on the clipboard before. The whole dance is
 * ~300ms; the user's clipboard is touched but returned to original.
 *
 * macOS-only for now (uses osascript). Linux (wl-copy/xclip) and
 * Windows (Set-Clipboard) are additive — same shape, different shell-out.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { Logger } from "../utils/logger";

const execFileP = promisify(execFile);

export class ClipboardBridge {
  /**
   * Capture whatever's on the clipboard as text. Returns null if nothing
   * readable as text (e.g. the user has only an image on the clipboard).
   * We deliberately only save the text representation — restoring binary
   * reps cleanly via osascript is finicky and the common case is text.
   */
  static async saveText(): Promise<string | null> {
    try {
      const { stdout } = await execFileP("osascript", [
        "-e",
        "try",
        "-e",
        "  return the clipboard as text",
        "-e",
        "on error",
        "-e",
        "  return \"\"",
        "-e",
        "end try",
      ]);
      // osascript appends a trailing newline; strip it.
      return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
    } catch (err) {
      Logger.warn("ClipboardBridge.saveText failed:", err);
      return null;
    }
  }

  /**
   * Put a PNG file on the clipboard as an image. Path must exist on disk
   * — osascript reads it with `read POSIX file ... as «class PNGf»`.
   */
  static async setImage(filePath: string): Promise<void> {
    // Path comes from our own tmp write so it's well-behaved, but quote
    // defensively in case macOS ever hands us something with a quote.
    const safe = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `set the clipboard to (read POSIX file "${safe}" as «class PNGf»)`;
    await execFileP("osascript", ["-e", script]);
  }

  /** Restore clipboard to the given text. Empty string clears it. */
  static async setText(text: string): Promise<void> {
    // AppleScript string literals: backslash + double-quote escape.
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await execFileP("osascript", ["-e", `set the clipboard to "${escaped}"`]);
  }

  /**
   * Stage an image on the clipboard, fire `onStaged` (typically: write
   * Ctrl-V byte to the PTY so the app reads), then restore the prior
   * clipboard contents after `restoreAfterMs` ms.
   *
   * Returns when the image has been staged and onStaged has been called.
   * The restore runs out-of-band — failure is logged but not thrown,
   * because by then the consumer has already gotten what they wanted.
   */
  static async pasteImage(
    filePath: string,
    onStaged: () => void,
    restoreAfterMs = 300,
  ): Promise<void> {
    const prior = await this.saveText();
    await this.setImage(filePath);
    onStaged();

    setTimeout(() => {
      this.setText(prior ?? "").catch((err) =>
        Logger.warn("ClipboardBridge restore failed:", err),
      );
    }, restoreAfterMs);
  }
}
