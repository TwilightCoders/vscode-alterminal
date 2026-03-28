/**
 * Mock WebviewView for testing PtyManager's data pipeline.
 * Captures postMessage calls for assertion.
 */
export class MockWebview {
  public messages: any[] = [];
  public visible = true;

  public webview = {
    postMessage: (msg: any) => {
      this.messages.push(msg);
    },
  };

  /** Show/hide (for testing buffering behavior) */
  public show(_preserveFocus?: boolean): void {
    this.visible = true;
  }

  /** Get all messages of a specific command type */
  messagesOfType(command: string): any[] {
    return this.messages.filter((m) => m.command === command);
  }

  /** Get the last message of a specific type, or undefined */
  lastOfType(command: string): any | undefined {
    const msgs = this.messagesOfType(command);
    return msgs[msgs.length - 1];
  }

  /** Reset captured messages */
  reset(): void {
    this.messages = [];
  }
}
