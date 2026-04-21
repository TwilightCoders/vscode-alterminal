import * as vscode from "vscode";

/**
 * Read a setting with inheritance from VS Code's built-in terminal settings.
 *
 * Resolution order:
 *   1. `alterminal.<alterminalKey>` — if explicitly set by user/workspace
 *   2. `terminal.integrated.<terminalKey>` — inherited from VS Code's terminal
 *   3. `fallback` — if neither is configured and VS Code has no default
 *
 * "Explicitly set" means the user has written the key to settings at any
 * scope (user, workspace, workspace folder). A value that matches the
 * extension's declared default from package.json does NOT count as
 * explicit — that way our declared defaults don't shadow the user's
 * terminal.integrated.* configuration.
 */
export function getInheritedSetting<T>(
  alterminalKey: string,
  terminalIntegratedKey: string,
  fallback: T,
): T {
  const aConfig = vscode.workspace.getConfiguration("alterminal");
  const inspect = aConfig.inspect<T>(alterminalKey);

  const explicitlySet =
    inspect !== undefined &&
    (inspect.globalValue !== undefined ||
      inspect.workspaceValue !== undefined ||
      inspect.workspaceFolderValue !== undefined);

  if (explicitlySet) {
    const value = aConfig.get<T>(alterminalKey);
    if (value !== undefined) return value;
  }

  const tConfig = vscode.workspace.getConfiguration("terminal.integrated");
  const tValue = tConfig.get<T>(terminalIntegratedKey);
  if (tValue !== undefined) return tValue;

  return fallback;
}
