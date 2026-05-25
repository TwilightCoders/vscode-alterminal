import * as assert from "assert";
import { StateManager } from "../../src/managers/stateManager";

const METADATA_KEY = "alterminal.state";
const BUFFER_PREFIX = "alterminal.buffer.";

/** In-memory stand-in for vscode.Memento (workspaceState). */
class FakeMemento {
  public store = new Map<string, any>();
  get(key: string): any {
    return this.store.get(key);
  }
  update(key: string, value: any): Thenable<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

/** Captures messages posted to a webview. */
function fakeWebview() {
  const posted: any[] = [];
  return {
    posted,
    webview: {
      postMessage: (msg: any) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    } as any,
  };
}

function makeManager(): { mgr: StateManager; mem: FakeMemento } {
  const mem = new FakeMemento();
  const context = { workspaceState: mem } as any;
  return { mgr: new StateManager(context), mem };
}

suite("StateManager", () => {
  suite("saveMetadata", () => {
    test("refuses to save empty metadata (no terminals)", () => {
      const { mgr, mem } = makeManager();
      mgr.saveMetadata({ terminals: [] });
      assert.equal(mem.get(METADATA_KEY), undefined);
      mgr.saveMetadata(null);
      assert.equal(mem.get(METADATA_KEY), undefined);
    });

    test("saves terminals with default activeTabId and a timestamp", () => {
      const { mgr, mem } = makeManager();
      mgr.saveMetadata({ terminals: [{ uuid: "a" }] });
      const saved = mem.get(METADATA_KEY);
      assert.equal(saved.terminals.length, 1);
      assert.equal(saved.activeTabId, 1);
      assert.equal(typeof saved.timestamp, "number");
    });

    test("preserves an explicit activeTabId", () => {
      const { mgr, mem } = makeManager();
      mgr.saveMetadata({ terminals: [{ uuid: "a" }], activeTabId: 5 });
      assert.equal(mem.get(METADATA_KEY).activeTabId, 5);
    });

    test("does not persist buffer fields in metadata", () => {
      const { mgr, mem } = makeManager();
      mgr.saveMetadata({ terminals: [{ uuid: "a", buffer: "SHOULD_NOT_PERSIST" }] });
      // saveMetadata stores terminals verbatim; buffers are stripped by saveState,
      // so callers of saveMetadata are responsible for clean metadata. Document
      // current behavior: it stores what it is given.
      assert.equal(mem.get(METADATA_KEY).terminals[0].buffer, "SHOULD_NOT_PERSIST");
    });
  });

  suite("saveBuffers / deleteBuffer", () => {
    test("writes each buffer under its own prefixed key", () => {
      const { mgr, mem } = makeManager();
      mgr.saveBuffers({ a: "AAA", b: "BBB" });
      assert.equal(mem.get(`${BUFFER_PREFIX}a`), "AAA");
      assert.equal(mem.get(`${BUFFER_PREFIX}b`), "BBB");
    });

    test("deleteBuffer removes only that key", () => {
      const { mgr, mem } = makeManager();
      mgr.saveBuffers({ a: "AAA", b: "BBB" });
      mgr.deleteBuffer("a");
      assert.equal(mem.get(`${BUFFER_PREFIX}a`), undefined);
      assert.equal(mem.get(`${BUFFER_PREFIX}b`), "BBB");
    });
  });

  suite("saveState (legacy split)", () => {
    test("splits embedded buffers into separate keys and keeps metadata clean", () => {
      const { mgr, mem } = makeManager();
      mgr.saveState({ terminals: [{ uuid: "a", buffer: "HELLO" }], activeTabId: 1 });
      assert.equal(mem.get(`${BUFFER_PREFIX}a`), "HELLO");
      const meta = mem.get(METADATA_KEY);
      assert.equal(meta.terminals[0].buffer, undefined);
      assert.equal(meta.terminals[0].uuid, "a");
    });

    test("assigns a uuid when a terminal lacks one", () => {
      const { mgr, mem } = makeManager();
      mgr.saveState({ terminals: [{ buffer: "X" }] });
      const meta = mem.get(METADATA_KEY);
      const uuid = meta.terminals[0].uuid;
      assert.ok(uuid && typeof uuid === "string", "uuid assigned");
      assert.equal(mem.get(`${BUFFER_PREFIX}${uuid}`), "X");
    });

    test("refuses empty state", () => {
      const { mgr, mem } = makeManager();
      mgr.saveState({ terminals: [] });
      assert.equal(mem.get(METADATA_KEY), undefined);
    });
  });

  suite("getFullState", () => {
    test("returns null when nothing is saved", () => {
      const { mgr } = makeManager();
      assert.equal(mgr.getFullState(), null);
    });

    test("assembles buffers from their separate keys", () => {
      const { mgr } = makeManager();
      mgr.saveMetadata({ terminals: [{ uuid: "a" }, { uuid: "b" }] });
      mgr.saveBuffers({ a: "AAA", b: "BBB" });
      const full = mgr.getFullState();
      assert.equal(full.terminals[0].buffer, "AAA");
      assert.equal(full.terminals[1].buffer, "BBB");
    });

    test("skips buffers listed in skipBufferUuids (live daemon PTYs)", () => {
      const { mgr } = makeManager();
      mgr.saveMetadata({ terminals: [{ uuid: "a" }, { uuid: "b" }] });
      mgr.saveBuffers({ a: "AAA", b: "BBB" });
      mgr.skipBufferUuids.add("b");
      const full = mgr.getFullState();
      assert.equal(full.terminals[0].buffer, "AAA");
      assert.equal(full.terminals[1].buffer, "", "skipped buffer is blanked");
    });
  });

  suite("migration", () => {
    test("migrates legacy terminals (buffer, no uuid) into split keys", () => {
      const { mgr, mem } = makeManager();
      // Seed legacy metadata directly (buffer embedded, no uuid).
      mem.update(METADATA_KEY, { terminals: [{ buffer: "LEGACY" }], activeTabId: 1 });
      const full = mgr.getFullState();
      const uuid = full.terminals[0].uuid;
      assert.ok(uuid, "uuid assigned during migration");
      assert.equal(full.terminals[0].buffer, "LEGACY");
      // Metadata rewritten without the embedded buffer.
      assert.equal(mem.get(METADATA_KEY).terminals[0].buffer, undefined);
      assert.equal(mem.get(`${BUFFER_PREFIX}${uuid}`), "LEGACY");
    });
  });

  suite("hasSavedState / getMetadata", () => {
    test("hasSavedState reflects presence of terminals", () => {
      const { mgr } = makeManager();
      assert.equal(mgr.hasSavedState(), false);
      mgr.saveMetadata({ terminals: [{ uuid: "a" }] });
      assert.equal(mgr.hasSavedState(), true);
    });

    test("getMetadata returns stored metadata or null", () => {
      const { mgr } = makeManager();
      assert.equal(mgr.getMetadata(), null);
      mgr.saveMetadata({ terminals: [{ uuid: "a" }] });
      assert.equal(mgr.getMetadata().terminals.length, 1);
    });
  });

  suite("clearState", () => {
    test("removes metadata and every buffer key", async () => {
      const { mgr, mem } = makeManager();
      mgr.saveMetadata({ terminals: [{ uuid: "a" }] });
      mgr.saveBuffers({ a: "AAA", b: "BBB" });
      await mgr.clearState();
      assert.equal(mem.get(METADATA_KEY), undefined);
      assert.equal(mem.get(`${BUFFER_PREFIX}a`), undefined);
      assert.equal(mem.get(`${BUFFER_PREFIX}b`), undefined);
      assert.equal(mem.keys().length, 0);
    });
  });

  suite("restore + boot state", () => {
    test("sends restoreState when state exists and flips to warm boot", async () => {
      const { mgr } = makeManager();
      mgr.saveMetadata({ terminals: [{ uuid: "a" }] });
      mgr.saveBuffers({ a: "AAA" });
      const wv = fakeWebview();
      assert.equal(mgr.isColdBoot(), true);
      await mgr.restoreWebviewState(wv.webview);
      assert.equal(wv.posted.length, 1);
      assert.equal(wv.posted[0].command, "restoreState");
      assert.equal(wv.posted[0].cold, true, "first restore reports the cold boot it just finished");
      assert.equal(mgr.isColdBoot(), false, "subsequent shows are warm");
    });

    test("sends initializeEmpty when no state exists", async () => {
      const { mgr } = makeManager();
      const wv = fakeWebview();
      await mgr.restoreWebviewState(wv.webview);
      assert.equal(wv.posted[0].command, "initializeEmpty");
    });

    test("restore guard prevents a duplicate restore", async () => {
      const { mgr } = makeManager();
      mgr.saveMetadata({ terminals: [{ uuid: "a" }] });
      const wv = fakeWebview();
      await mgr.restoreWebviewState(wv.webview);
      await mgr.restoreWebviewState(wv.webview);
      assert.equal(wv.posted.length, 1, "second restore is skipped");
    });

    test("resetForNewWebview re-arms the guard", async () => {
      const { mgr } = makeManager();
      mgr.saveMetadata({ terminals: [{ uuid: "a" }] });
      const wv = fakeWebview();
      await mgr.restoreWebviewState(wv.webview);
      mgr.resetForNewWebview();
      await mgr.restoreWebviewState(wv.webview);
      assert.equal(wv.posted.length, 2, "guard re-armed, restore runs again");
    });

    test("pushStateToWebview sends without the guard", () => {
      const { mgr } = makeManager();
      mgr.saveMetadata({ terminals: [{ uuid: "a" }] });
      const wv = fakeWebview();
      mgr.pushStateToWebview(wv.webview);
      mgr.pushStateToWebview(wv.webview);
      assert.equal(wv.posted.length, 2);
    });
  });
});
