/**
 * Self-contained WebGPU render-capture harness (test-electron entry point).
 *
 * Opens a webview panel inside the real Electron VS Code (Chromium → working
 * WebGPU, unlike headless Chrome), loads the actual built webgpu addon over a
 * fresh xterm Terminal, writes a fixed glyph test pattern, and reads the
 * rendered canvas back to a PNG on disk. Lets us SEE the renderer's output
 * (box-drawing connectivity, block fills, etc.) without a human screenshotting.
 *
 * Run via `npm run capture`. Output: /tmp/alterminal-webgpu-capture.png
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

const OUT_PNG = "/tmp/alterminal-webgpu-capture.png";

// One glyph category per line — mirrors the printf test pattern we used by hand.
const TEST_PATTERN = [
  // Glyph reference: block/box geometry should fill the cell and tile cleanly.
  "\x1b[32m████████\x1b[38;5;238m████████\x1b[0m  block-char progress bar",
  "░▒▓█  shades   ▁▂▃▄▅▆▇█  lower eighths   ▏▎▍▌▋▊▉█  left eighths",
  "┌─┬─┐  ┏━┳━┓   ╭─┬─╮      box-drawing (light / heavy / rounded)",
  "├─┼─┤  ┣━╋━┫   │ │ │",
  "└─┴─┘  ┗━┻━┛   ╰─┴─╯",
  "Ag normal text — gjpqy descenders, baseline check",
].join("\r\n");

export function run(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ext = path.resolve(__dirname, "..", "..", "..", ".."); // out/test/test/capture → repo root
    const nm = vscode.Uri.file(path.join(ext, "node_modules"));
    const lib = vscode.Uri.file(path.join(ext, "lib"));

    const panel = vscode.window.createWebviewPanel(
      "webgpuCapture",
      "WebGPU Capture",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [nm, lib] },
    );

    const w = panel.webview;
    const xtermCss = w.asWebviewUri(vscode.Uri.joinPath(nm, "@xterm", "xterm", "css", "xterm.css"));
    const xtermJs = w.asWebviewUri(vscode.Uri.joinPath(nm, "@xterm", "xterm", "lib", "xterm.js"));
    const addonJs = w.asWebviewUri(
      vscode.Uri.joinPath(lib, "xterm-addon-webgpu", "dist", "webgpu-addon.umd.js"),
    );

    const done = (err?: Error) => {
      clearTimeout(timer);
      panel.dispose();
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => done(new Error("capture timed out (no message from webview)")), 120000);

    w.onDidReceiveMessage((msg) => {
      if (msg?.type === "log") {
        console.log("  [webview]", msg.text);
        return;
      }
      if (msg?.type === "probe") {
        console.log("  [probe]", JSON.stringify(msg.probe, null, 2));
        return;
      }
      if (msg?.type !== "captured") return;
      console.log(`  [capture] hasCanvas=${msg.hasCanvas} ${msg.w}x${msg.h} dataUrlLen=${msg.dataUrl?.length ?? 0} err=${msg.err ?? "none"}`);
      if (!msg.dataUrl) {
        done(new Error(`no dataUrl (hasCanvas=${msg.hasCanvas}, err=${msg.err})`));
        return;
      }
      try {
        const b64 = msg.dataUrl.replace(/^data:image\/png;base64,/, "");
        fs.writeFileSync(OUT_PNG, Buffer.from(b64, "base64"));
        console.log(`  [capture] wrote ${OUT_PNG} (${fs.statSync(OUT_PNG).size} bytes)`);
        done();
      } catch (e) {
        done(e as Error);
      }
    });

    w.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="${xtermCss}" />
<style>
  html, body { margin: 0; background: #1e1e1e; }
  #term { padding: 8px; }
</style>
</head>
<body>
<div id="term"></div>
<script src="${xtermJs}"></script>
<script src="${addonJs}"></script>
<script>
  const vscode = acquireVsCodeApi();
  const log = (text) => vscode.postMessage({ type: "log", text });
  window.addEventListener("error", (e) => log("error: " + (e.message || e)));
  (async () => {
    try {
      const term = new Terminal({
        cols: 60, rows: 10,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 14,
        theme: { background: "#1e1e1e" },
      });
      term.open(document.getElementById("term"));
      const addon = new WebgpuAddon.WebgpuAddon();
      if (addon.onContextLoss) addon.onContextLoss(() => log("onContextLoss fired (WebGPU init failed)"));
      term.loadAddon(addon);
      term.write(${JSON.stringify(TEST_PATTERN)});
      log("wrote pattern; waiting for render…");
      // Give the async WebGPU device init + a render tick time to settle.
      await new Promise((r) => setTimeout(r, 2500));

      // STRESS: hammer the atlas with tens of thousands of unique glyphs to
      // drive it past full and force LRU evict-and-repack cycles, then redraw
      // the test pattern. If eviction is correct the pattern stays clean; if it
      // corrupted atlas state, the redraw would be garbled.
      let evictions = 0, hardResets = 0;
      try {
        const atlas = addon._shared && addon._shared.atlas;
        if (atlas) {
          for (let i = 0; i < 1000; i++) {
            // Advance frames periodically so earlier glyphs become stale and
            // thus evictable — mirrors real per-frame rendering. (Hammering in
            // one frame would mark everything current → nothing evictable.)
            if (i % 500 === 0) atlas.beginFrame();
            const code = 0x20000 + i; // supplementary-plane codepoints, all unique
            atlas.getOrAllocate({ code, bg: 0, fg: 0, ext: 0 }, String.fromCodePoint(code), false, false);
          }
          evictions = atlas.evictionCount; hardResets = atlas.hardResetCount;
          log("stress done: evictions=" + evictions + " hardResets=" + hardResets);
        }
      } catch (e) { log("stress error: " + e); }
      term.refresh(0, term.rows - 1); // force a full redraw of the pattern
      await new Promise((r) => setTimeout(r, 800));

      // Probe: cell box vs each glyph's rasterized size/offset. Reveals whether
      // line glyphs span the full cell (connect) or fall short (gaps).
      try {
        const renderer = addon._renderer;
        const m = renderer && renderer._metrics;
        const cv = document.querySelector(".xterm-webgpu-canvas");
        const atlas = addon._shared && addon._shared.atlas;
        const rcfg = addon._shared && addon._shared.rasterizer && addon._shared.rasterizer._config;
        const rasterizer = rcfg ? {
          deviceCharHeight: rcfg.deviceCharHeight, deviceCellHeight: rcfg.deviceCellHeight,
          baseline: rcfg.baseline, fontSize: rcfg.fontSize, dpr: rcfg.devicePixelRatio,
        } : null;
        const dims = term._core && term._core._renderService && term._core._renderService.dimensions;
        const xtermDims = dims ? {
          cssCellW: dims.css && dims.css.cell && dims.css.cell.width,
          cssCellH: dims.css && dims.css.cell && dims.css.cell.height,
          devCellW: dims.device && dims.device.cell && dims.device.cell.width,
          devCellH: dims.device && dims.device.cell && dims.device.cell.height,
        } : null;
        const chars = [["block","█",0x2588],["vline","│",0x2502],["hline","─",0x2500],["cross","┼",0x253c],["lhalf","▌",0x258c]];
        const glyphs = {};
        if (atlas) for (const c of chars) {
          const g = atlas.getOrAllocate({ code: c[2], bg: 0, fg: 0, ext: 0 }, c[1], false, false);
          glyphs[c[0]] = g ? { sx: g.size.x, sy: g.size.y, ox: g.offset.x, oy: g.offset.y } : null;
        }
        vscode.postMessage({ type: "probe", probe: {
          cellW: m && m.deviceCellWidth, cellH: m && m.deviceCellHeight,
          cols: m && m.cols, rows: m && m.rows, dpr: m && m.devicePixelRatio,
          canvasW: cv && cv.width, canvasH: cv && cv.height,
          evictions, hardResets, xtermDims, rasterizer, glyphs,
        } });
      } catch (e) { vscode.postMessage({ type: "probe", probe: { error: String(e) } }); }

      const canvas = document.querySelector(".xterm-webgpu-canvas");
      let dataUrl = null, err = null;
      try { dataUrl = canvas ? canvas.toDataURL("image/png") : null; }
      catch (e) { err = String(e); }
      vscode.postMessage({
        type: "captured", dataUrl, err,
        hasCanvas: !!canvas,
        w: canvas && canvas.width, h: canvas && canvas.height,
      });
    } catch (e) {
      vscode.postMessage({ type: "captured", dataUrl: null, err: String(e), hasCanvas: false });
    }
  })();
</script>
</body>
</html>`;
  });
}
