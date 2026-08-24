import * as assert from "assert";
import { shellFamilyFor, quoteForShell } from "../../src/terminal/shellQuoting";

suite("shellFamilyFor", () => {
  test("classifies Windows shells by path", () => {
    assert.strictEqual(shellFamilyFor("C:\\Windows\\System32\\cmd.exe", "win32"), "cmd");
    assert.strictEqual(shellFamilyFor("C:\\...\\WindowsPowerShell\\v1.0\\powershell.exe", "win32"), "powershell");
    assert.strictEqual(shellFamilyFor("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32"), "powershell");
  });

  test("a POSIX shell ON Windows is still posix (Git Bash / WSL)", () => {
    // The family follows the shell, not the OS — Git Bash users get POSIX
    // quoting even though process.platform is win32.
    assert.strictEqual(shellFamilyFor("C:\\Program Files\\Git\\bin\\bash.exe", "win32"), "posix");
    assert.strictEqual(shellFamilyFor("/usr/bin/zsh", "win32"), "posix");
  });

  test("classifies unix shells", () => {
    assert.strictEqual(shellFamilyFor("/bin/zsh", "darwin"), "posix");
    assert.strictEqual(shellFamilyFor("/usr/local/bin/fish", "linux"), "posix");
  });

  test("falls back by platform when the shell is unknown or missing", () => {
    assert.strictEqual(shellFamilyFor(undefined, "win32"), "cmd");
    assert.strictEqual(shellFamilyFor(undefined, "darwin"), "posix");
    assert.strictEqual(shellFamilyFor("", "linux"), "posix");
  });
});

suite("quoteForShell", () => {
  test("posix matches the established shellEscape behavior", () => {
    assert.strictEqual(quoteForShell("/usr/bin/zsh", "posix"), "/usr/bin/zsh");
    assert.strictEqual(quoteForShell("hello world", "posix"), "'hello world'");
    assert.strictEqual(quoteForShell("it's", "posix"), "'it'\\''s'");
  });

  test("cmd double-quotes paths with spaces (single quotes are literal there)", () => {
    // The bug this module exists for: POSIX quoting produced
    // 'C:\Users\me\my file.txt', which cmd.exe passes through verbatim,
    // quotes and all.
    assert.strictEqual(
      quoteForShell("C:\\Users\\me\\my file.txt", "cmd"),
      '"C:\\Users\\me\\my file.txt"',
    );
  });

  test("cmd leaves simple paths unquoted", () => {
    assert.strictEqual(quoteForShell("C:\\tmp\\a.txt", "cmd"), "C:\\tmp\\a.txt");
  });

  test("powershell single-quotes and doubles embedded quotes", () => {
    assert.strictEqual(
      quoteForShell("C:\\Users\\me\\my file.txt", "powershell"),
      "'C:\\Users\\me\\my file.txt'",
    );
    assert.strictEqual(quoteForShell("it's here", "powershell"), "'it''s here'");
  });

  test("powershell literal-quoting prevents variable expansion", () => {
    // Single quotes in PowerShell are literal, so a $ in a filename is safe.
    assert.strictEqual(quoteForShell("$HOME file", "powershell"), "'$HOME file'");
  });

  test("no shell family mangles a plain relative path", () => {
    for (const family of ["posix", "cmd", "powershell"] as const) {
      assert.strictEqual(quoteForShell("notes.txt", family), "notes.txt");
    }
  });
});
