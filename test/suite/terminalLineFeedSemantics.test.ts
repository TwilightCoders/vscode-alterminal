import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

/**
 * Regression guard for the ncurses "smear to column 0" bug.
 *
 * xterm.js's `convertEol: true` option remaps incoming bare LF (`\n`,
 * 0x0A) to CR+LF — i.e. forces the cursor to column 0 on every line
 * feed. That contradicts the VT spec, where bare LF is IND (move down,
 * preserve the column) and column 0 is reached only via explicit CR,
 * NEL (`\eE`), or LNM mode 20 (`\e[20h`).
 *
 * ncurses (and any cursor-optimizing TUI) emits sequences like
 * `\e[6G  \n\n\b\b<content>` — column 6, write two spaces (→col 8),
 * `\n\n` to move down two rows preserving column 8, then `\b\b` to
 * land on column 6. With `convertEol: true`, the `\n\n` resets to
 * column 0, the backspaces clamp at 0, and the focused row's chrome
 * (`❯`, `[●]`, etc.) gets drawn at the far left edge instead of
 * inside the panel. Reported by the potty (claudepilot) launchpad —
 * smears in alterminal, clean in VS Code's built-in terminal because
 * VS Code does not enable convertEol.
 *
 * The PTY's line discipline (`termios.ONLCR`) already maps `\n` to
 * `\r\n` on output for "cooked" output; programs that want raw IND
 * (ncurses in particular) bypass that. The terminal must NOT
 * re-impose CR-on-LF after the fact.
 *
 * If a future change re-adds `convertEol: true`, this guard fires.
 */
suite("terminal: bare-LF semantics (IND, not CRLF)", () => {
  const root = path.resolve(__dirname, "../../../..");
  const TERMINAL_SOURCE = fs.readFileSync(
    path.join(root, "src/webview/terminal.ts"),
    "utf8",
  );

  test("convertEol is not enabled (would break ncurses-style cursor optimization)", () => {
    // Look for `convertEol: true` in the xterm constructor options.
    // Whitespace-tolerant; ignores commented-out occurrences.
    const lines = TERMINAL_SOURCE.split("\n").filter((l) => !/^\s*\/\//.test(l));
    const body = lines.join("\n");
    assert.ok(
      !/convertEol\s*:\s*true/.test(body),
      "xterm option `convertEol: true` remaps bare LF to CRLF and breaks any TUI that uses LF as IND (e.g. ncurses moving the cursor down while preserving the column). Leave it false / unset.",
    );
  });

  test("if convertEol is mentioned at all, it must be false (or commented)", () => {
    // Defensive belt-and-suspenders: forbid truthy assignment in any shape.
    const lines = TERMINAL_SOURCE.split("\n").filter((l) => !/^\s*\/\//.test(l));
    for (const line of lines) {
      const m = /convertEol\s*:\s*([^,}\s]+)/.exec(line);
      if (m) {
        assert.equal(
          m[1].trim(),
          "false",
          `convertEol must be false (got: ${m[1].trim()}) — see line "${line.trim()}"`,
        );
      }
    }
  });
});
