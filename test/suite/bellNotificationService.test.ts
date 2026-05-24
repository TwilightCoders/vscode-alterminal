import * as assert from "assert";
import {
  BellNotificationHost,
  BellNotificationService,
} from "../../src/managers/bellNotificationService";

type TimerHandle = ReturnType<typeof setTimeout>;

class FakeBellNotificationHost implements BellNotificationHost {
  public readonly publishedBells: string[] = [];
  public indicator = "\u{1F514}";
  public nowValue = 0;
  public titleIndicator = "";
  public windowFocused = false;

  private nextTimerId = 1;
  private readonly timers = new Map<number, { callback: () => void; dueAt: number }>();

  public clearTimer(timer: TimerHandle): void {
    this.timers.delete(Number(timer));
  }

  public getBellIndicator(): string {
    return this.indicator;
  }

  public isWindowFocused(): boolean {
    return this.windowFocused;
  }

  public now(): number {
    return this.nowValue;
  }

  public publishBell(body: string): void {
    this.publishedBells.push(body);
  }

  public setTimer(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextTimerId++;
    this.timers.set(id, { callback, dueAt: this.nowValue + delayMs });
    return id as unknown as TimerHandle;
  }

  public setTitleIndicator(value: string): void {
    this.titleIndicator = value;
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
  test("debounces multiple bells into one published bell", async () => {
    const host = new FakeBellNotificationHost();
    const service = new BellNotificationService(host);

    service.handleBellSound(1, "Build");
    host.advance(1000);
    service.handleBellSound(2, "Logs");

    assert.strictEqual(host.titleIndicator, "\u{1F514}2");
    assert.strictEqual(host.publishedBells.length, 0);

    host.advance(3000);
    await flushMicrotasks();

    assert.deepStrictEqual(host.publishedBells, ["2 terminals: Build, Logs"]);
    assert.strictEqual(host.titleIndicator, "\u{1F514}2");
  });

  test("does not raise title or publish when window is focused", async () => {
    const host = new FakeBellNotificationHost();
    host.windowFocused = true;
    const service = new BellNotificationService(host);

    service.handleBellSound(1, "Build");
    host.advance(3000);
    await flushMicrotasks();

    // Window is focused — user is present, the per-tab icon is enough.
    assert.strictEqual(host.titleIndicator, "");
    assert.strictEqual(host.publishedBells.length, 0);
  });

  test("raises title bell when window is unfocused", () => {
    const host = new FakeBellNotificationHost();
    host.windowFocused = false;
    const service = new BellNotificationService(host);

    service.handleBellSound(1, "Build");

    assert.strictEqual(host.titleIndicator, "\u{1F514}");
  });

  test("suppresses publish if window gains focus during debounce", async () => {
    const host = new FakeBellNotificationHost();
    host.windowFocused = false;
    const service = new BellNotificationService(host);

    service.handleBellSound(1, "Build");
    // User switches into this window before the debounced publish fires.
    host.windowFocused = true;
    host.advance(3000);
    await flushMicrotasks();

    assert.strictEqual(host.publishedBells.length, 0);
  });

  test("suppresses repeat publishes during cooldown", () => {
    const host = new FakeBellNotificationHost();
    const service = new BellNotificationService(host);

    service.handleBellSound(1, "Build");
    host.advance(3000);

    assert.deepStrictEqual(host.publishedBells, ["Build"]);
    assert.strictEqual(host.titleIndicator, "\u{1F514}");

    host.advance(1000);
    service.handleBellSound(1, "Build");
    host.advance(3000);

    assert.strictEqual(host.publishedBells.length, 1);
    assert.strictEqual(host.titleIndicator, "\u{1F514}");
  });

  test("defers clear while the bell grace window is active", () => {
    const host = new FakeBellNotificationHost();
    const service = new BellNotificationService(host);

    service.handleBellSound(1, "Build");
    service.clearBellIndicator();

    assert.strictEqual(host.publishedBells.length, 0);
    assert.strictEqual(host.titleIndicator, "\u{1F514}");

    host.advance(1999);
    assert.strictEqual(host.titleIndicator, "\u{1F514}");

    host.advance(1);
    assert.strictEqual(host.titleIndicator, "");
  });
});
