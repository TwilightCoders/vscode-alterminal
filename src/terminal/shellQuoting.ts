/**
 * Quoting a path for the shell the user is actually looking at.
 *
 * This is deliberately NOT the same thing as `shellEscape` in
 * ptyDaemonClient.ts. Those two serve different contracts and must not be
 * merged:
 *
 *   - `shellEscape` builds a command line for **loomptyd**, which runs it
 *     through a POSIX shell. It stays POSIX no matter what OS the client runs
 *     on — the daemon is the audience, not the local machine.
 *   - `quoteForShell` (here) writes text into the **interactive shell running
 *     in a tab** (drag-and-drop a file, and the path is typed at the prompt).
 *     The audience is whatever shell that tab spawned, so on Windows it may be
 *     cmd.exe or PowerShell — and POSIX single-quoting is wrong for both.
 *
 * Concretely, dropping `C:\Users\me\my file.txt` used to emit
 * `'C:\Users\me\my file.txt'`, which cmd.exe treats as a literal token
 * (it has no concept of single quotes) — a broken path at the prompt.
 */

export type ShellFamily = "posix" | "cmd" | "powershell";

/**
 * Classify a shell by its path. Windows users commonly run a POSIX shell
 * (Git Bash, MSYS, WSL), so the family follows the SHELL, not the OS — only
 * the fallback for an unknown shell is platform-dependent.
 */
export function shellFamilyFor(
  shellPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): ShellFamily {
  const s = (shellPath ?? "").toLowerCase();

  if (s.includes("powershell") || s.includes("pwsh")) return "powershell";
  if (/(^|[\\/])cmd(\.exe)?$/.test(s) || s.includes("comspec")) return "cmd";
  // bash/zsh/fish/sh — including Git Bash + WSL on Windows.
  if (/(^|[\\/])(bash|zsh|fish|sh|dash|ksh)(\.exe)?$/.test(s)) return "posix";

  return platform === "win32" ? "cmd" : "posix";
}

/** POSIX: single-quote, and close/escape/reopen for embedded single quotes. */
function quotePosix(s: string): string {
  if (/^[a-zA-Z0-9_\-./=:@]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * cmd.exe: double quotes. Windows forbids `" < > | : * ? /` in filenames, so a
 * path can never contain the quote character — which is fortunate, because
 * cmd has no way to escape one inside a quoted string.
 */
function quoteCmd(s: string): string {
  if (/^[a-zA-Z0-9_\-.:\\/]+$/.test(s)) return s;
  return '"' + s.replace(/"/g, "") + '"';
}

/**
 * PowerShell: single-quoted strings are literal (no expansion), and an
 * embedded single quote is escaped by doubling it. Unlike Windows paths,
 * arbitrary text here can legitimately contain `'`.
 */
function quotePowerShell(s: string): string {
  if (/^[a-zA-Z0-9_\-.:\\/]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Quote `s` so the given shell family receives it as a single literal token. */
export function quoteForShell(s: string, family: ShellFamily): string {
  switch (family) {
    case "cmd":
      return quoteCmd(s);
    case "powershell":
      return quotePowerShell(s);
    default:
      return quotePosix(s);
  }
}
