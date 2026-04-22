import * as assert from "assert";
import {
  BellNotificationHost,
  BellNotificationService,
} from "../../src/managers/bellNotificationService";

type TimerHandle = ReturnType<typeof setTimeout>;

class FakeBellNotificationHost implements BellNotificationHost {
  public readonly notifications: Array<{ action: string; message: string }> = [];
  public readonly postedMessages: any[] = [];
  public indicator = "\u{1F514}";
  public nowValue = 0;
  public openTerminalCalls = 0;
  public titleIndicator = "";
  public notificationSelection: string | undefined;

  private nextTimerId = 1;
  private readonly timers = new Map<number, { callback: () => void; dueAt: number }>();

  public clearTimer(timer: TimerHandle): void {
    this.timers.delete(Number(timer));
  }

  public getBellIndicator(): string {
    return this.indicator;
  }

  public getWebview() {
    return {
      postMessage: async (message: any) => {
        this.postedMessages.push(message);
        return true;
      },
    } as any;
  }

  public now(): number {
    return this.nowValue;
  }

  public async openTerminal(): Promise<void> {
    this.openTerminalCalls += 1;
  }

  public setTimer(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextTimerId++;
    this.timers.set(id, { callback, dueAt: this.nowValue + delayMs });
    return id as unknown as TimerHandle;
  }

  public setTitleIndicator(value: string): void {
    this.titleIndicator = value;
  }

  public showNotification(message: string, action: string): Promise<string | undefined> {
    this.notifications.push({ action, message });
    return Promise.resolve(this.notificationSelection);
  }

  public advance(ms: number): void {
    const target = this.nowValue + ms;

    while (true) {
      const next = this.nextDueTimer(target);
      if (!next) break;
      this.nowValue = next.dueAt;
      this.timers.delete(next.id);
      next.callback();
    }

    this.nowValue = target;
  }

  private nextDueTimer(target: number) {
    let next:
      | { callback: () => void; dueAt: number; id: number }
      | undefined;

    for (const [id, timer] of this.timers.entries()) {
      if (timer.dueAt > target) continue;
      if (!next || timer.dueAt < next.dueAt) {
        next = { id, ...timer };
      }
    }

    return next;
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

suite("BellNotificationService", () => {
  test("debounces multiple bells into one notification", async () => {
    const host = new FakeBellNotificationHost();
    host.notificationSelection = "Go to Terminal";
    const service = new BellNotificationService(host);

    service.handleBellSound(1, "Build");
    host.advance(1000);
    service.handleBellSound(2, "Logs");

    assert.strictEqual(host.titleIndicator, "\u{1F514}2");
    assert.strictEqual(host.notifications.length, 0);

    host.advance(3000);
    await flushMicrotasks();

    assert.deepStrictEqual(host.notifications, [
      { action: "Go to Terminal", message: "2 terminals: Build, Logs" },
    ]);
    assert.strictEqual(host.openTerminalCalls, 1);
    assert.strictEqual(host.titleIndicator, "");

    host.advance(200);
    await flushMicrotasks();

    assert.deepStrictEqual(host.postedMessages, [
      { command: "switchToTab", tabId: 2 },
    ]);
  });

  test("suppresses repeat notifications during cooldown", () => {
    const host = new FakeBellNotificationHost();
    const service = new BellNotificationService(host);

    service.handleBellSound(1, "Build");
    host.advance(3000);

    assert.deepStrictEqual(host.notifications, [
      { action: "Go to Terminal", message: "Build" },
    ]);
    assert.strictEqual(host.titleIndicator, "\u{1F514}");

    host.advance(1000);
    service.handleBellSound(1, "Build");
    host.advance(3000);

    assert.strictEqual(host.notifications.length, 1);
    assert.strictEqual(host.titleIndicator, "\u{1F514}");
  });

  test("defers clear while the bell grace window is active", () => {
    const host = new FakeBellNotificationHost();
    const service = new BellNotificationService(host);

    service.handleBellSound(1, "Build");
    service.clearBellIndicator();

    assert.strictEqual(host.notifications.length, 0);
    assert.strictEqual(host.titleIndicator, "\u{1F514}");

    host.advance(1999);
    assert.strictEqual(host.titleIndicator, "\u{1F514}");

    host.advance(1);
    assert.strictEqual(host.titleIndicator, "");
  });
});
