import * as assert from "assert";
import {
  appendEvent,
  selectUnseen,
  CrossWindowBellEvent,
} from "../../src/managers/crossWindowBell";

function ev(partial: Partial<CrossWindowBellEvent>): CrossWindowBellEvent {
  return {
    id: partial.id ?? "id",
    originId: partial.originId ?? "origin",
    project: partial.project ?? "proj",
    body: partial.body ?? "Build",
    ts: partial.ts ?? 0,
  };
}

suite("crossWindowBell helpers", () => {
  suite("appendEvent", () => {
    test("appends a new event", () => {
      const out = appendEvent([], ev({ id: "a", ts: 100 }), 100);
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].id, "a");
    });

    test("prunes events older than the TTL", () => {
      const old = ev({ id: "old", ts: 0 });
      const fresh = ev({ id: "fresh", ts: 20_000 });
      const out = appendEvent([old], fresh, 20_000, 15_000);
      assert.deepStrictEqual(out.map((e) => e.id), ["fresh"]);
    });

    test("keeps events within the TTL", () => {
      const recent = ev({ id: "recent", ts: 10_000 });
      const now = ev({ id: "now", ts: 20_000 });
      const out = appendEvent([recent], now, 20_000, 15_000);
      assert.deepStrictEqual(out.map((e) => e.id), ["recent", "now"]);
    });

    test("caps total event count", () => {
      let events: CrossWindowBellEvent[] = [];
      for (let i = 0; i < 30; i++) {
        events = appendEvent(events, ev({ id: `e${i}`, ts: 1000 }), 1000, 15_000, 25);
      }
      assert.strictEqual(events.length, 25);
      // Oldest dropped, newest kept.
      assert.strictEqual(events[events.length - 1].id, "e29");
      assert.strictEqual(events[0].id, "e5");
    });
  });

  suite("selectUnseen", () => {
    test("returns only events newer than lastSeen", () => {
      const events = [
        ev({ id: "old", ts: 100, originId: "other" }),
        ev({ id: "new", ts: 300, originId: "other" }),
      ];
      const out = selectUnseen(events, 200, "me");
      assert.deepStrictEqual(out.map((e) => e.id), ["new"]);
    });

    test("skips events originated by this window", () => {
      const events = [
        ev({ id: "mine", ts: 300, originId: "me" }),
        ev({ id: "theirs", ts: 300, originId: "other" }),
      ];
      const out = selectUnseen(events, 0, "me");
      assert.deepStrictEqual(out.map((e) => e.id), ["theirs"]);
    });

    test("returns empty when nothing is newer", () => {
      const events = [ev({ id: "a", ts: 100, originId: "other" })];
      const out = selectUnseen(events, 100, "me");
      assert.strictEqual(out.length, 0);
    });
  });
});
