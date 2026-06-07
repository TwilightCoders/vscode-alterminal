import * as assert from "assert";
import { MessageDispatcher } from "../../src/managers/messageDispatcher";

/** A tiny call-recording spy. */
function spy(impl?: (...args: any[]) => any) {
  const calls: any[][] = [];
  const fn = (...args: any[]) => {
    calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  (fn as any).calls = calls;
  return fn as ((...args: any[]) => any) & { calls: any[][] };
}

/** Build a dispatcher wired to fake collaborators, returning the fakes + a
 *  `fire(msg)` that pushes a message through the registered router. */
function makeHarness(opts: { canHandle?: (cmd: string) => boolean } = {}) {
  const fakes = {
    ptyManager: {
      writeToPty: spy(),
      canHandle: opts.canHandle ?? (() => false),
      handleMessage: spy(),
    },
    commandLauncher: {
      handleSaveCommand: spy(),
      handleCheckCommandSaved: spy(),
      handleLaunchSavedCommand: spy(),
    },
    fileOperationHandler: { handleDroppedFile: spy(), handleOpenFile: spy(), handleOpenUrl: spy() },
    tabContextMenuHandler: { handleBufferContentResponse: spy() },
    stateManager: { saveMetadata: spy(), saveBuffers: spy(), deleteBuffer: spy(), saveState: spy() },
    onFormatTabTitle: spy(),
    onWebviewReady: spy(),
    serializerHandleMessage: spy(),
    onInteraction: spy(),
  };

  const posted: any[] = [];
  const webview = {
    postMessage: (m: any) => { posted.push(m); return Promise.resolve(true); },
    onDidReceiveMessage: spy(),
  };
  // Capture the listener that setupMessageRouter registers.
  let listener: (msg: any) => void = () => {};
  webview.onDidReceiveMessage = ((cb: any) => { listener = cb; return { dispose() {} }; }) as any;

  const dispatcher = new MessageDispatcher(
    fakes.ptyManager as any,
    fakes.commandLauncher as any,
    fakes.fileOperationHandler as any,
    fakes.tabContextMenuHandler as any,
    fakes.stateManager as any,
    () => webview as any,
    async () => {},
    fakes.onFormatTabTitle,
    fakes.onWebviewReady,
    fakes.serializerHandleMessage,
    fakes.onInteraction,
  );

  dispatcher.setupMessageRouter({ webview } as any);

  return { fakes, posted, fire: (msg: any) => listener(msg) };
}

suite("MessageDispatcher", () => {
  test("routes `data` to ptyManager.writeToPty", () => {
    const { fakes, fire } = makeHarness();
    fire({ command: "data", data: "ls\n", tabId: 3 });
    assert.deepEqual(fakes.ptyManager.writeToPty.calls[0], ["ls\n", 3]);
  });

  test("coerces non-string `data` to empty string", () => {
    const { fakes, fire } = makeHarness();
    fire({ command: "data", data: undefined, tabId: 1 });
    assert.deepEqual(fakes.ptyManager.writeToPty.calls[0], ["", 1]);
  });

  test("routes metadataUpdate to stateManager.saveMetadata", () => {
    const { fakes, fire } = makeHarness();
    const state = { terminals: [{ uuid: "a" }] };
    fire({ command: "metadataUpdate", state });
    assert.equal(fakes.stateManager.saveMetadata.calls[0][0], state);
  });

  test("routes bufferUpdate to stateManager.saveBuffers", () => {
    const { fakes, fire } = makeHarness();
    const buffers = { a: "AAA" };
    fire({ command: "bufferUpdate", buffers });
    assert.equal(fakes.stateManager.saveBuffers.calls[0][0], buffers);
  });

  test("routes bufferDelete to stateManager.deleteBuffer", () => {
    const { fakes, fire } = makeHarness();
    fire({ command: "bufferDelete", uuid: "dead-beef" });
    assert.equal(fakes.stateManager.deleteBuffer.calls[0][0], "dead-beef");
  });

  test("routes fileDrop to fileOperationHandler.handleDroppedFile with all fields", () => {
    const { fakes, fire } = makeHarness();
    fire({
      command: "fileDrop",
      tabId: 2,
      fileName: "a.txt",
      fileType: "text/plain",
      fileSize: 12,
      fileData: "base64==",
    });
    assert.deepEqual(fakes.fileOperationHandler.handleDroppedFile.calls[0], [
      2, "a.txt", "text/plain", 12, "base64==",
    ]);
  });

  test("routes openFile and openUrl", () => {
    const { fakes, fire } = makeHarness();
    fire({ command: "openFile", filePath: "/tmp/x", terminalId: 7 });
    fire({ command: "openUrl", url: "https://example.com" });
    assert.deepEqual(fakes.fileOperationHandler.handleOpenFile.calls[0], ["/tmp/x", 7]);
    assert.deepEqual(fakes.fileOperationHandler.handleOpenUrl.calls[0], ["https://example.com"]);
  });

  test("routes saveCommand to commandLauncher", () => {
    const { fakes, fire } = makeHarness();
    fire({ command: "saveCommand", tabId: 1, launchCommand: "npm test", tabLabel: "Tests" });
    assert.deepEqual(fakes.commandLauncher.handleSaveCommand.calls[0], [1, "npm test", "Tests"]);
  });

  test("routes launchSavedCommand to commandLauncher", () => {
    const { fakes, fire } = makeHarness();
    fire({ command: "launchSavedCommand", launchCommand: "npm test", label: "Tests" });
    assert.deepEqual(fakes.commandLauncher.handleLaunchSavedCommand.calls[0], ["npm test", "Tests"]);
  });

  test("routes bufferContent to tabContextMenuHandler", () => {
    const { fakes, fire } = makeHarness();
    fire({ command: "bufferContent", tabId: 4, buffer: "scrollback" });
    assert.deepEqual(fakes.tabContextMenuHandler.handleBufferContentResponse.calls[0], [4, "scrollback"]);
  });

  test("routes formatTabTitle to the provided callback", () => {
    const { fakes, fire } = makeHarness();
    const msg = { command: "formatTabTitle", tabId: 1 };
    fire(msg);
    assert.equal(fakes.onFormatTabTitle.calls[0][0], msg);
  });

  test("routes webviewReady to the onWebviewReady callback", () => {
    const { fakes, fire } = makeHarness();
    fire({ command: "webviewReady" });
    assert.equal(fakes.onWebviewReady.calls.length, 1);
  });

  test("stateUpdate saves full state and forwards to the serializer", () => {
    const { fakes, fire } = makeHarness();
    const state = { terminals: [{ uuid: "a" }] };
    const msg = { command: "stateUpdate", state };
    fire(msg);
    assert.equal(fakes.stateManager.saveState.calls[0][0], state);
    assert.equal(fakes.serializerHandleMessage.calls[0][0], msg);
  });

  test("delegates unknown PTY-capable commands to ptyManager.handleMessage", () => {
    const { fakes, fire } = makeHarness({ canHandle: (cmd) => cmd === "resize" });
    const msg = { command: "resize", cols: 80, rows: 24, tabId: 1 };
    fire(msg);
    assert.equal(fakes.ptyManager.handleMessage.calls[0][0], msg);
  });

  test("does not throw on a fully unknown command", () => {
    const { fire } = makeHarness();
    assert.doesNotThrow(() => fire({ command: "totally-unknown" }));
  });

  test("records user interaction for every message", () => {
    const { fakes, fire } = makeHarness();
    fire({ command: "data", data: "a", tabId: 1 });
    fire({ command: "webviewReady" });
    assert.equal(fakes.onInteraction.calls.length, 2);
  });

  test("swallows handler errors (does not break the message pump)", () => {
    const { fakes, fire } = makeHarness();
    // The handler resolves this.stateManager.saveMetadata dynamically at fire
    // time, so swapping it for a throwing impl exercises the try/catch wrapper.
    (fakes.stateManager.saveMetadata as any) = () => {
      throw new Error("boom");
    };
    assert.doesNotThrow(() => fire({ command: "metadataUpdate", state: { terminals: [{}] } }));
  });
});
