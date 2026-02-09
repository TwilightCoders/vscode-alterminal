/**
 * Tab Title Provider
 *
 * Purpose:
 * - Manages tab title templating and formatting
 * - Handles token-based template system (PS1-style)
 * - Provides real-time title updates based on process changes
 *
 * Responsibilities:
 * - Parse and render title templates with token substitution
 * - Handle conditional logic and default values in templates
 * - Manage built-in tokens (process, directory, time, etc.)
 * - Provide configuration interface for custom templates
 *
 * Key Features:
 * - Token system: {n}, {p}, {cwd}, {time}, {id}, etc.
 * - Conditional rendering: {p?text} shows text only if process running
 * - Default values: {p:shell} shows "shell" if no process
 * - Complex conditionals: {p?{p}:idle} shows process name or "idle"
 * - Extensible token registration system
 *
 * Template Examples:
 * - "{n} • {p}" → "Terminal • node"
 * - "{cwd}{p? ~ {p}}" → "my-app ~ python"
 * - "{p?🟢:💤} {n}" → "🟢 Terminal"
 */

import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { TemplateEngine } from "../utils/templateEngine";
import * as path from "path";

export interface TabContext {
  tabId: number;
  tabName: string;
  baseTabName: string;
  processName?: string;
  processId?: number;
  fullCommand?: string;
  oscTitle?: string;
  workingDirectory?: string;
  lastExitCode?: number;
  timestamp: Date;
}

export interface TemplateToken {
  key: string;
  getValue: (context: TabContext) => string | null;
  description: string;
  example: string;
}

export class TabTitleProvider {
  private tokens: Map<string, TemplateToken> = new Map();
  private config: vscode.WorkspaceConfiguration;

  constructor() {
    this.config = vscode.workspace.getConfiguration("alterminal");
    this.registerBuiltinTokens();
  }

  /**
   * Render a title template with the given context
   */
  render(template: string, context: TabContext): string {
    try {
      const result = TemplateEngine.render(template, (key) => {
        const token = this.tokens.get(key);
        return token?.getValue(context) ?? null;
      });
      return this.truncateIfNeeded(result);
    } catch (error) {
      Logger.error("Template rendering error:", error);
      // Fallback to basic format
      return context.processName
        ? `${context.baseTabName} • ${context.processName}`
        : context.baseTabName;
    }
  }

  /**
   * Get the current template from configuration
   */
  getTemplate(): string {
    return this.config.get<string>("tabTitle.template", "{base}{p? • {p}}");
  }

  /**
   * Update configuration (refreshes from VS Code settings)
   */
  updateConfiguration(): void {
    this.config = vscode.workspace.getConfiguration("alterminal");
  }

  /**
   * Get all available tokens for documentation/UI
   */
  getAvailableTokens(): TemplateToken[] {
    return Array.from(this.tokens.values());
  }

  /**
   * Validate a template string
   */
  validateTemplate(template: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check for unmatched braces
    const openBraces = (template.match(/{/g) || []).length;
    const closeBraces = (template.match(/}/g) || []).length;

    if (openBraces !== closeBraces) {
      errors.push("Unmatched braces in template");
    }

    // Check for unknown tokens
    const tokenPattern = /{([^}]+)}/g;
    let match;
    while ((match = tokenPattern.exec(template)) !== null) {
      const tokenContent = match[1];
      const baseToken = tokenContent.split("?")[0].split(":")[0];

      if (!this.tokens.has(baseToken)) {
        errors.push(`Unknown token: {${baseToken}}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // Truncate result if it exceeds max length
  private truncateIfNeeded(text: string): string {
    const maxLength = this.config.get<number>("tabTitle.maxLength", 50);
    const truncateMode = this.config.get<string>(
      "tabTitle.truncateMode",
      "end",
    );

    if (text.length <= maxLength) {
      return text;
    }

    switch (truncateMode) {
      case "start":
        return "…" + text.substring(text.length - maxLength + 1);
      case "middle":
        const halfLength = Math.floor((maxLength - 1) / 2);
        return (
          text.substring(0, halfLength) +
          "…" +
          text.substring(text.length - halfLength)
        );
      case "end":
      default:
        return text.substring(0, maxLength - 1) + "…";
    }
  }

  /**
   * Register all built-in tokens
   */
  private registerBuiltinTokens(): void {
    // Process tokens
    this.tokens.set("p", {
      key: "p",
      getValue: (ctx) => ctx.processName || null,
      description: "Current process name",
      example: "node, python, git",
    });

    this.tokens.set("pid", {
      key: "pid",
      getValue: (ctx) => ctx.processId?.toString() || null,
      description: "Process ID",
      example: "12345",
    });

    this.tokens.set("cmd", {
      key: "cmd",
      getValue: (ctx) => ctx.fullCommand || null,
      description: "Full command line",
      example: "npm run dev",
    });

    this.tokens.set("title", {
      key: "title",
      getValue: (ctx) => ctx.oscTitle || null,
      description: "Terminal-reported title (via OSC escape sequence)",
      example: "user@host:~/project, vim file.txt",
    });

    // Tab tokens
    this.tokens.set("n", {
      key: "n",
      getValue: (ctx) => ctx.tabName,
      description: "Tab name/label",
      example: "Terminal, API Server",
    });

    this.tokens.set("base", {
      key: "base",
      getValue: (ctx) => ctx.baseTabName,
      description: "Base tab name (without process)",
      example: "Terminal",
    });

    this.tokens.set("id", {
      key: "id",
      getValue: (ctx) => ctx.tabId.toString(),
      description: "Tab ID number",
      example: "1, 2, 3",
    });

    // Directory tokens
    this.tokens.set("cwd", {
      key: "cwd",
      getValue: (ctx) => {
        if (!ctx.workingDirectory) return null;
        return path.basename(ctx.workingDirectory);
      },
      description: "Current working directory basename",
      example: "my-project",
    });

    this.tokens.set("path", {
      key: "path",
      getValue: (ctx) => ctx.workingDirectory || null,
      description: "Full current working directory path",
      example: "/Users/name/projects/my-app",
    });

    // Time tokens
    this.tokens.set("time", {
      key: "time",
      getValue: (ctx) => {
        return ctx.timestamp.toLocaleTimeString("en-US", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        });
      },
      description: "Current time (HH:MM)",
      example: "14:30",
    });

    this.tokens.set("date", {
      key: "date",
      getValue: (ctx) => {
        return ctx.timestamp.toLocaleDateString("en-US", {
          month: "2-digit",
          day: "2-digit",
        });
      },
      description: "Current date (MM/DD)",
      example: "07/22",
    });

    this.tokens.set("timestamp", {
      key: "timestamp",
      getValue: (ctx) => Math.floor(ctx.timestamp.getTime() / 1000).toString(),
      description: "Unix timestamp",
      example: "1690000000",
    });

    // Status tokens
    this.tokens.set("status", {
      key: "status",
      getValue: (ctx) => {
        return ctx.processName ? "running" : "idle";
      },
      description: "Process status",
      example: "running, idle",
    });

    this.tokens.set("exit", {
      key: "exit",
      getValue: (ctx) => ctx.lastExitCode?.toString() || null,
      description: "Last process exit code",
      example: "0, 1, 127",
    });
  }
}
