import { BellDetector } from "../../src/terminal/bellDetector";
import {
  filterVSCodeSequences,
  extractCwdFromOsc7,
  extractUserVars,
  replaceBelWithST,
} from "../../src/terminal/dataPipeline";
import { MockWebview } from "./mockWebview";

/**
 * Lightweight test harness that replicates PtyManager._handlePtyData()
 * without requiring VS Code APIs, PTY processes, or webview infrastructure.
 *
 * Uses the same extracted dataPipeline functions as PtyManager, wired to
 * a MockWebview for message capture and assertion.
 */
export class PtyTestHarness {
  public readonly mockView = new MockWebview();
  public readonly bellDetector = new BellDetector();
  public readonly bellEvents: number[] = [];
  public readonly cwdChanges: Array<{ tabId: number; cwd: string }> = [];
  public readonly userVarChanges: Array<{ tabId: number; vars: Map<string, string> }> = [];

  /**
   * Feed raw PTY data through the pipeline — mirrors PtyManager._handlePtyData().
   */
  feedData(tabId: number, data: string): void {
    const hasEsc = data.indexOf('\x1b') !== -1;

    if (hasEsc) {
      const cwd = extractCwdFromOsc7(data);
      if (cwd) {
        this.cwdChanges.push({ tabId, cwd });
        this.mockView.webview.postMessage({
          command: "cwdChange",
          tabId,
          cwd,
        });
      }

      const userVars = extractUserVars(data);
      if (userVars) {
        this.userVarChanges.push({ tabId, vars: userVars });
        this.mockView.webview.postMessage({
          command: "userVarChange",
          tabId,
        });
      }
    }

    if (this.bellDetector.detect(tabId, data)) {
      this.bellEvents.push(tabId);
      this.mockView.webview.postMessage({
        command: "bell",
        tabId,
      });
    }

    let filteredData = hasEsc ? filterVSCodeSequences(data) : data;
    filteredData = replaceBelWithST(filteredData);
    if (!filteredData) return;

    if (this.mockView.visible) {
      this.mockView.webview.postMessage({
        command: "data",
        data: filteredData,
        tabId,
      });
    }
  }

  /** Reset all captured state */
  reset(): void {
    this.mockView.reset();
    this.bellEvents.length = 0;
    this.cwdChanges.length = 0;
    this.userVarChanges.length = 0;
  }
}
