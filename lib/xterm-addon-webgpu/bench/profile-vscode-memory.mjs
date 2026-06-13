#!/usr/bin/env node
/**
 * Snapshot VS Code's process-tree memory, grouped by process type, for
 * apples-to-apples renderer A/B (webgl vs webgpu vs dom).
 *
 *   node lib/xterm-addon-webgpu/bench/profile-vscode-memory.mjs [label]
 *
 * Method for a fair comparison:
 *   1. Fully quit VS Code (⌘Q), relaunch, open your usual windows/tabs.
 *   2. Let it settle ~45s (atlases warm, GC settles).
 *   3. Run this with a label, e.g. `... profile-vscode-memory.mjs webgpu`.
 *   4. Switch alterminal.renderer, reload all windows (or restart), settle, run
 *      again with a different label.
 *   5. Compare — the GPU and renderer rows are where a renderer change shows up.
 *
 * Note: this is the whole VS Code footprint, not just Alterminal's slice; keep
 * the window/tab layout identical between runs so the delta is the renderer.
 * macOS only (uses `ps`); RSS overcounts shared libraries, so treat it as a
 * relative signal between identical layouts, not an absolute.
 */
import { execSync } from "node:child_process";

const label = process.argv[2] || new Date().toISOString();

// pid, rss(KB), full command — only VS Code's tree (Code.app + its helpers).
const raw = execSync("ps -axo pid=,rss=,command=", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const cats = {
  main: { rss: 0, n: 0 },
  gpu: { rss: 0, n: 0 },
  renderer: { rss: 0, n: 0 },
  extensionHost: { rss: 0, n: 0 },
  utility: { rss: 0, n: 0 },
  other: { rss: 0, n: 0 },
};

const isVSCode = (cmd) => /Visual Studio Code\.app|Code Helper/.test(cmd);

for (const line of raw.split("\n")) {
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
  if (!m) continue;
  const rssKB = Number(m[2]);
  const cmd = m[3];
  if (!isVSCode(cmd)) continue;
  if (/profile-vscode-memory/.test(cmd)) continue; // skip ourselves

  let cat;
  if (/--type=gpu-process/.test(cmd) || /Code Helper \(GPU\)/.test(cmd)) cat = "gpu";
  else if (/--type=renderer/.test(cmd) || /Code Helper \(Renderer\)/.test(cmd)) cat = "renderer";
  else if (/--type=utility/.test(cmd) && /extensionHost|ptyHost/.test(cmd)) cat = "extensionHost";
  else if (/--type=utility/.test(cmd) || /Code Helper \(Plugin\)/.test(cmd)) cat = "utility";
  else if (/Visual Studio Code\.app\/Contents\/MacOS\/(Electron|Code)/.test(cmd) && !/--type=/.test(cmd)) cat = "main";
  else cat = "other";

  cats[cat].rss += rssKB;
  cats[cat].n += 1;
}

const mb = (kb) => (kb / 1024).toFixed(0).padStart(7) + " MB";
let total = 0;
console.log(`\n=== VS Code memory snapshot — "${label}" ===`);
console.log("category          procs        RSS");
console.log("--------------------------------------");
for (const [k, v] of Object.entries(cats)) {
  if (v.n === 0) continue;
  total += v.rss;
  console.log(`${k.padEnd(16)}  ${String(v.n).padStart(5)}  ${mb(v.rss)}`);
}
console.log("--------------------------------------");
console.log(`${"TOTAL".padEnd(16)}  ${"".padStart(5)}  ${mb(total)}`);
console.log("\n(GPU + renderer rows are where a renderer A/B shows up.)\n");
