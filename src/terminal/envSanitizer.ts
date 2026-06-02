/**
 * Shared environment sanitization for spawned shells.
 *
 * Alterminal is a webview, NOT VS Code's integrated terminal — so the shells we
 * spawn should not advertise themselves as VS Code's terminal. VS Code injects
 * a family of env vars into the ext-host process:
 *   - VSCODE_* — including shell-integration vars (VSCODE_SHELL_INTEGRATION /
 *     VSCODE_INJECTION / VSCODE_NONCE) that make the shell emit OSC 633, and IPC
 *     hooks (VSCODE_IPC_HOOK_CLI / VSCODE_GIT_IPC_HANDLE / VSCODE_GIT_ASKPASS_*)
 *     that give tools a live channel back into the workbench.
 *   - ELECTRON_* — Electron runtime hints.
 *   - GIT_ASKPASS / SSH_ASKPASS pointing at VS Code's askpass helper.
 *
 * Direct mode already strips these; the daemon path inherits them. This module
 * is the single predicate both paths share, and the basis of the "what is
 * leaking?" diagnostic.
 */
export function isVscodeInjectedEnvKey(key: string, value: string): boolean {
  if (key.startsWith("VSCODE_") || key.startsWith("ELECTRON_")) {
    return true;
  }
  if ((key === "GIT_ASKPASS" || key === "SSH_ASKPASS") && /vscode|Code/i.test(value)) {
    return true;
  }
  return false;
}

/** Sorted list of VS Code-injected env keys present in `env` (for diagnostics). */
export function listVscodeInjectedEnv(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isVscodeInjectedEnvKey(k, v)) out.push(k);
  }
  return out.sort();
}

/** Copy of `env` with VS Code-injected keys (and undefined values) removed. */
export function sanitizeSpawnEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isVscodeInjectedEnvKey(k, v)) continue;
    out[k] = v;
  }
  return out;
}
