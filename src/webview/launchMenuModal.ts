/**
 * Launch Menu Modal
 *
 * Webview-side modal that mirrors the host quick-pick content:
 * - Detected shells
 * - Saved commands
 * - Template-variable help
 * - Edit saved commands action
 *
 * The modal is intentionally simple: the host owns command data and saved
 * command execution, while the webview owns rendering and shell/custom
 * command launch actions.
 */

import type { LaunchMenuData, SavedCommand } from "../shared/messages.js";

export interface LaunchMenuModalCallbacks {
  launchShell: (shellPath: string) => void;
  launchCustomCommand: (command: string) => void;
  launchSavedCommand: (launchCommand: string, label?: string) => void;
  openSavedCommandsSettings: () => void;
}

type LaunchItemKind = "shell" | "saved" | "custom" | "help" | "settings";

export class LaunchMenuModal {
  private overlay: HTMLElement | null = null;
  private dialog: HTMLElement | null = null;
  private search: HTMLInputElement | null = null;
  private list: HTMLElement | null = null;
  private empty: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private data: LaunchMenuData | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(private readonly callbacks: LaunchMenuModalCallbacks) {}

  public setData(data: LaunchMenuData): void {
    this.data = data;
    if (this.overlay) {
      this.render();
    }
  }

  public open(): void {
    if (this.overlay) {
      this.search?.focus();
      this.search?.select();
      return;
    }

    const overlay = document.createElement("div");
    overlay.className = "launch-menu-overlay";

    const dialog = document.createElement("div");
    dialog.className = "launch-menu-dialog";

    const title = document.createElement("div");
    title.className = "launch-menu-title";
    title.textContent = "New Terminal";

    const search = document.createElement("input");
    search.type = "text";
    search.className = "launch-menu-search";
    search.placeholder = "Select a shell, saved command, or type a command";
    search.autocapitalize = "off";
    search.autocomplete = "off";
    search.spellcheck = false;

    const list = document.createElement("div");
    list.className = "launch-menu-list";

    const empty = document.createElement("div");
    empty.className = "launch-menu-empty";
    empty.textContent = "Loading launch options…";

    const status = document.createElement("div");
    status.className = "launch-menu-status";

    dialog.append(title, search, list, empty, status);
    overlay.appendChild(dialog);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        this.close();
      }
    });

    search.addEventListener("input", () => this.render());
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.handleSearchEnter();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    };
    document.addEventListener("keydown", this.keyHandler);

    document.body.appendChild(overlay);

    this.overlay = overlay;
    this.dialog = dialog;
    this.search = search;
    this.list = list;
    this.empty = empty;
    this.status = status;
    this.render();

    requestAnimationFrame(() => {
      this.search?.focus();
      this.search?.select();
    });
  }

  public close(): void {
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    this.overlay?.remove();
    this.overlay = null;
    this.dialog = null;
    this.search = null;
    this.list = null;
    this.empty = null;
    this.status = null;
  }

  private render(): void {
    if (!this.list || !this.empty || !this.status || !this.search) {
      return;
    }

    const query = this.search.value.trim().toLowerCase();
    const data = this.data;
    const shells = data?.shells ?? [];
    const savedCommands = data?.savedCommands ?? [];
    const hasData = !!data;
    const safeQuery = this.search.value.trim();

    this.list.replaceChildren();

    if (!hasData) {
      this.empty.style.display = "block";
      this.empty.textContent = "Loading launch options…";
      this.status.textContent = "";
      return;
    }

    const canLaunchCustom = safeQuery.length > 0;

    if (canLaunchCustom && !savedCommands.some((cmd) => cmd.command === safeQuery)) {
      const customItem = this.buildCustomCommandItem(safeQuery);
      customItem.style.display = "";
      this.list.appendChild(customItem);
    }

    const shellItems = shells.map((shell) => {
      const item = this.buildShellItem(shell);
      item.style.display = this.matchesShellQuery(shell, query) ? "" : "none";
      return item;
    });
    this.appendSection("Shells", shellItems);

    if (savedCommands.length > 0) {
      const savedItems = savedCommands.map((cmd) => {
        const item = this.buildSavedCommandItem(cmd);
        item.style.display = this.matchesSavedQuery(cmd, query) ? "" : "none";
        return item;
      });
      this.appendSection("Saved Commands", savedItems);
    }

    const infoItem = this.buildInfoItem(
      "Template Variables",
      "{workspace}  {workspacePath}  {user}  {platform}  {env.VAR}",
      "Use these in commands to adapt per-workspace. Supports {key:default} and {key?then:else}.",
      "help",
    );
    infoItem.style.display = "";
    this.list.appendChild(infoItem);

    const settingsItem = this.buildSettingsItem();
    settingsItem.style.display = "";
    this.list.appendChild(settingsItem);

    const launchableItems = Array.from(
      this.list.querySelectorAll<HTMLElement>(
        ".launch-menu-item[data-launch-kind='custom'], .launch-menu-item[data-launch-kind='shell'], .launch-menu-item[data-launch-kind='saved']",
      ),
    ).filter((item) => item.style.display !== "none");

    if (launchableItems.length === 0) {
      this.empty.style.display = "block";
      this.empty.textContent = "No launch options match";
    } else {
      this.empty.style.display = "none";
    }

    this.status.textContent = canLaunchCustom
      ? `${launchableItems.length} launchable option${launchableItems.length === 1 ? "" : "s"} visible · Enter launches typed command · Esc cancels`
      : `${launchableItems.length} launchable option${launchableItems.length === 1 ? "" : "s"} visible · click to launch · Esc cancels`;
  }

  private appendSection(title: string, items: HTMLElement[]): void {
    if (!this.list) return;
    const visibleItems = items.filter((item) => item.style.display !== "none");
    if (visibleItems.length === 0) {
      return;
    }

    const section = document.createElement("section");
    section.className = "launch-menu-section";

    const heading = document.createElement("div");
    heading.className = "launch-menu-section-title";
    heading.textContent = title;
    section.appendChild(heading);

    const body = document.createElement("div");
    body.className = "launch-menu-section-body";
    for (const item of items) {
      body.appendChild(item);
    }
    section.appendChild(body);
    this.list.appendChild(section);
  }

  private buildCustomCommandItem(command: string): HTMLElement {
    const item = this.buildItem(
      "custom",
      "$(play) Run: " + command,
      "(new command)",
      "Press Enter to launch",
    );
    item.dataset.searchText = command.toLowerCase();
    item.addEventListener("click", () => this.launchCustom(command));
    return item;
  }

  private buildShellItem(shell: { label: string; path: string; isDefault: boolean }): HTMLElement {
    const item = this.buildItem(
      "shell",
      `$(terminal) ${shell.label}${shell.isDefault ? " (default)" : ""}`,
      shell.path,
      shell.isDefault ? "Launch a new shell tab" : "Launch shell in a new tab",
    );
    item.dataset.shellPath = shell.path;
    item.dataset.searchText = `${shell.label} ${shell.path}`.toLowerCase();
    item.addEventListener("click", () => this.launchShell(shell.path));
    return item;
  }

  private buildSavedCommandItem(cmd: SavedCommand): HTMLElement {
    const usedCount = cmd.count ?? 0;
    const lastUsed = cmd.lastUsed ? new Date(cmd.lastUsed).toLocaleDateString() : "Never";
    const detailParts = [`Used ${usedCount} time${usedCount === 1 ? "" : "s"}`, `Last ${lastUsed}`];
    if (cmd.cwd) {
      detailParts.push(`cwd: ${cmd.cwd}`);
    }

    const item = this.buildItem(
      "saved",
      `$(terminal) ${cmd.label || cmd.command}`,
      cmd.command,
      detailParts.join(" • "),
    );
    item.dataset.launchCommand = cmd.command;
    item.dataset.searchText = `${cmd.label || ""} ${cmd.command} ${cmd.cwd || ""}`.toLowerCase();
    if (cmd.label) {
      item.dataset.launchLabel = cmd.label;
    }
    item.addEventListener("click", () => this.launchSaved(cmd.command, cmd.label));
    return item;
  }

  private buildInfoItem(title: string, description: string, detail: string, kind: LaunchItemKind): HTMLElement {
    return this.buildItem(kind, `$(symbol-variable) ${title}`, description, detail, false);
  }

  private buildSettingsItem(): HTMLElement {
    const item = this.buildItem(
      "settings",
      "$(edit) Edit Saved Commands…",
      "",
      "Open settings to add, remove, or modify saved commands",
    );
    item.addEventListener("click", () => {
      this.close();
      this.callbacks.openSavedCommandsSettings();
    });
    return item;
  }

  private buildItem(
    kind: LaunchItemKind,
    label: string,
    description: string,
    detail: string,
    interactive = true,
  ): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `launch-menu-item launch-menu-item-${kind}`;
    button.dataset.launchKind = kind;

    const icon = document.createElement("span");
    icon.className = "launch-menu-item-icon";
    const iconName = this.extractIconName(label);
    if (iconName) {
      icon.classList.add("codicon", `codicon-${iconName}`);
    }

    const content = document.createElement("div");
    content.className = "launch-menu-item-content";

    const title = document.createElement("div");
    title.className = "launch-menu-item-label";
    title.textContent = this.stripIconPrefix(label);

    const desc = document.createElement("div");
    desc.className = "launch-menu-item-description";
    desc.textContent = description;

    const info = document.createElement("div");
    info.className = "launch-menu-item-detail";
    info.textContent = detail;

    content.append(title);
    if (description) {
      content.appendChild(desc);
    }
    if (detail) {
      content.appendChild(info);
    }

    button.append(icon, content);
    if (!interactive) {
      button.disabled = true;
      button.classList.add("launch-menu-item-static");
    }

    return button;
  }

  private matchesShellQuery(shell: { label: string; path: string }, query: string): boolean {
    if (!query) return true;
    return `${shell.label} ${shell.path}`.toLowerCase().includes(query);
  }

  private matchesSavedQuery(cmd: SavedCommand, query: string): boolean {
    if (!query) return true;
    return `${cmd.label || ""} ${cmd.command} ${cmd.cwd || ""}`.toLowerCase().includes(query);
  }

  private handleSearchEnter(): void {
    const value = this.search?.value.trim() ?? "";
    if (!value) {
      this.launchDefaultShell();
      return;
    }

    const matchingSaved = this.data?.savedCommands.find((cmd) => cmd.command === value);
    if (matchingSaved) {
      this.launchSaved(matchingSaved.command, matchingSaved.label);
      return;
    }

    this.launchCustom(value);
  }

  private launchDefaultShell(): void {
    const data = this.data;
    const defaultShell = data?.shells.find((shell) => shell.isDefault) ?? data?.shells[0];
    if (!defaultShell) {
      return;
    }
    this.close();
    this.callbacks.launchShell(defaultShell.path);
  }

  private launchShell(shellPath: string): void {
    this.close();
    this.callbacks.launchShell(shellPath);
  }

  private launchCustom(command: string): void {
    this.close();
    this.callbacks.launchCustomCommand(command);
  }

  private launchSaved(command: string, label?: string): void {
    this.close();
    this.callbacks.launchSavedCommand(command, label);
  }

  private extractIconName(label: string): string | null {
    const match = label.match(/\$\(([^)]+)\)/);
    return match ? match[1] : null;
  }

  private stripIconPrefix(label: string): string {
    return label.replace(/^\$\([^)]+\)\s*/, "");
  }
}
