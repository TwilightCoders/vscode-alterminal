#!/usr/bin/env node
// Replay a captured `window.__altLinks` dump through the actual
// xterm-link-provider `computeLink` to reproduce the work-mac
// horizontal-offset bug locally — no GPU, no browser.
//
// USAGE
//   1. On the work mac, hover an offending link. In DevTools console:
//        copy(window.__altLinksJSON())
//      and paste the JSON into a file, e.g. `/tmp/altlinks.json`.
//   2. From the repo root:
//        node lib/xterm-addon-webgpu/bench/link-replay.mjs /tmp/altlinks.json
//
// What it does for each captured link:
//   - Reconstructs a faithful mock buffer from the dump's `cells` array
//     (cell.chars / cell.width preserved verbatim, including any anomalies).
//   - Calls the real `computeLink(y, regex, terminal)` from
//     `xterm-link-provider`.
//   - Compares the library's returned `range.start.x` to the ground-truth
//     cell position recorded in the dump (`truth.col`).
//   - Reports drift; flags anomalies (width=0 cells with chars).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const libPath = resolve(here, "../../../node_modules/xterm-link-provider/lib/esm/index.js");
const { computeLink } = await import(libPath);

const LINK_REGEX_SRC =
  'https?:\\/\\/[^\\s"\'`()\\[\\]{}]+[^\\s"\'`()\\[\\]{}.,:;!?]' +
  '|(?:~|\\.\\..?)?\\/[^\\s"\'`()\\[\\]{}]*[^\\s"\'`()\\[\\]{}\\/.,;:!?]' +
  '|[a-zA-Z0-9_\\-\\.]+\\/[a-zA-Z0-9_\\-\\.\\/]*[a-zA-Z0-9_\\-]';
const linkRegex = new RegExp(`(${LINK_REGEX_SRC})`);

function buildMockTerminal(dump) {
  // Build per-row arrays of cell records sorted by col. The library reads via
  // line.getCell(i, cell) — fill `cell` in place with getChars/getWidth.
  // Library also reads `line.length` and `line.isWrapped`.
  const cols = dump.cols;
  const rowsByAbs = new Map();
  for (const c of dump.cells) {
    if (!rowsByAbs.has(c.rowAbs)) rowsByAbs.set(c.rowAbs, []);
    rowsByAbs.get(c.rowAbs).push(c);
  }
  for (const arr of rowsByAbs.values()) arr.sort((a, b) => a.col - b.col);

  const makeLine = (rowAbs) => {
    const rec = rowsByAbs.get(rowAbs);
    if (!rec) return undefined;
    const isWrapped = rowAbs > dump.originAbs && rec.length > 0; // best effort
    const cellAt = new Map();
    for (const r of rec) cellAt.set(r.col, r);
    return {
      length: cols,
      isWrapped,
      translateToString(trimRight) {
        let s = "";
        let i = 0;
        while (i < cols) {
          const r = cellAt.get(i);
          if (!r) { s += " "; i += 1; continue; }
          const emitted = r.chars.length > 0 ? r.chars : (r.width > 0 ? " " : "");
          s += emitted;
          i += r.width || 1;
        }
        return trimRight ? s.replace(/\s+$/, "") : s;
      },
      getCell(i, target) {
        const r = cellAt.get(i);
        const chars = r?.chars ?? "";
        const width = r?.width ?? 1;
        if (target) {
          target.getChars = () => chars;
          target.getWidth = () => width;
          return target;
        }
        return { getChars: () => chars, getWidth: () => width };
      },
    };
  };

  return {
    cols,
    buffer: {
      active: {
        getNullCell() {
          // Mutable stand-in; library calls getCell(i, cell) which we overwrite.
          return { getChars: () => "", getWidth: () => 1 };
        },
        getLine: (i) => makeLine(i),
      },
    },
  };
}

function replayDump(dump, label) {
  console.log(`\n=== Dump ${label} (providerY=${dump.providerY}, originAbs=${dump.originAbs}, wrapRows=${dump.wrapRows}, cols=${dump.cols}) ===`);
  if (dump.anomalyCount > 0) {
    console.log(`  ⚠ ${dump.anomalyCount} anomalies:`);
    for (const a of dump.anomalies) {
      console.log(`    row=${a.rowAbs} col=${a.col} chars=${JSON.stringify(a.chars)} w=${a.width} :: ${a.anomaly}`);
    }
  }
  console.log(`  lenDelta(lib-walk)=${dump.lenDelta}  libStringLen=${dump.libStringLen}  walkStringLen=${dump.walkStringLen}`);

  const terminal = buildMockTerminal(dump);

  for (const captured of dump.links) {
    const linkText = captured.text;
    const wantCol = captured.truth?.col;
    const wantRow = captured.truth?.rowAbs;
    const libCol = captured.libCell.col;
    const libRow = captured.libCell.rowAbs;

    // The library was originally called with y = dump.providerY (1-based abs).
    // Reproduce that exact call.
    const links = computeLink(dump.providerY, linkRegex, terminal);
    const replay = links.find((l) => l.text === linkText) ?? links[0];

    const replayCol = replay ? (replay.range.start.x - 1) : null;
    const replayRow = replay ? (replay.range.start.y - 1) : null;

    const match =
      replayCol === wantCol && replayRow === wantRow
        ? "✓ matches ground truth"
        : replayCol === libCol && replayRow === libRow
        ? "✓ reproduces lib (still drifted)"
        : "?? diverges from both lib AND truth";

    console.log(`  link: ${JSON.stringify(linkText.slice(0, 60))}`);
    console.log(`    ground-truth cell  = (row=${wantRow}, col=${wantCol})`);
    console.log(`    library produced   = (row=${libRow}, col=${libCol})   drift=${captured.delta}  class=${captured.driftClass}`);
    console.log(`    headless replay    = (row=${replayRow}, col=${replayCol})   ${match}`);
  }
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("usage: node lib/xterm-addon-webgpu/bench/link-replay.mjs <dump.json>");
  process.exit(2);
}
const raw = readFileSync(argv[0], "utf8");
const parsed = JSON.parse(raw);
const dumps = Array.isArray(parsed) ? parsed : [parsed];
dumps.forEach((d, i) => replayDump(d, `${i + 1}/${dumps.length}`));
