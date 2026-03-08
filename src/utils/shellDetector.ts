import * as fs from "fs";
import * as path from "path";
import { Logger } from "./logger";

export interface DetectedShell {
  label: string;
  path: string;
  isDefault: boolean;
}

export class ShellDetector {
  private static _cache: DetectedShell[] | null = null;

  public static detectShells(): DetectedShell[] {
    if (this._cache) return this._cache;

    const shells = process.platform === "win32"
      ? this._detectWindows()
      : this._detectUnix();

    this._cache = shells;
    Logger.info(`Detected ${shells.length} shells: ${shells.map((s) => s.label).join(", ")}`);
    return shells;
  }

  public static clearCache(): void {
    this._cache = null;
  }

  private static _detectUnix(): DetectedShell[] {
    const defaultShell = process.env.SHELL || "/bin/sh";
    const seen = new Map<string, string>(); // basename → full path

    try {
      const etcShells = fs.readFileSync("/etc/shells", "utf8");
      for (const line of etcShells.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        if (!fs.existsSync(trimmed)) continue;

        const basename = path.basename(trimmed);
        // Prefer the path that matches $SHELL, otherwise keep first
        if (!seen.has(basename) || trimmed === defaultShell) {
          seen.set(basename, trimmed);
        }
      }
    } catch {
      // /etc/shells not readable — fall back to common paths
      for (const p of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
        if (fs.existsSync(p)) {
          seen.set(path.basename(p), p);
        }
      }
    }

    const shells: DetectedShell[] = [];
    for (const [label, shellPath] of seen) {
      shells.push({
        label,
        path: shellPath,
        isDefault: shellPath === defaultShell,
      });
    }

    // Sort: default first, then alphabetical
    shells.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

    return shells;
  }

  private static _detectWindows(): DetectedShell[] {
    const shells: DetectedShell[] = [];
    const comspec = process.env.COMSPEC || "cmd.exe";

    // cmd.exe is always available
    shells.push({
      label: "cmd",
      path: comspec,
      isDefault: true,
    });

    // Check for PowerShell Core (pwsh)
    try {
      const { execSync } = require("child_process");
      const pwshPath = execSync("where pwsh.exe", { stdio: "pipe" }).toString().trim().split("\n")[0];
      if (pwshPath) {
        shells.push({ label: "pwsh", path: pwshPath.trim(), isDefault: false });
      }
    } catch { /* not installed */ }

    // Check for Windows PowerShell
    try {
      const { execSync } = require("child_process");
      const psPath = execSync("where powershell.exe", { stdio: "pipe" }).toString().trim().split("\n")[0];
      if (psPath) {
        shells.push({ label: "powershell", path: psPath.trim(), isDefault: false });
      }
    } catch { /* not installed */ }

    // Check for WSL
    try {
      const { execSync } = require("child_process");
      const wslPath = execSync("where wsl.exe", { stdio: "pipe" }).toString().trim().split("\n")[0];
      if (wslPath) {
        shells.push({ label: "wsl", path: wslPath.trim(), isDefault: false });
      }
    } catch { /* not installed */ }

    return shells;
  }
}
