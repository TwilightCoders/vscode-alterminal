/**
 * Tab Icon Picker — webview-side modal.
 *
 * Renders a searchable grid of all VS Code codicons. Replaces the 12-item
 * QuickPick the host used to show. On selection, invokes
 * onSelect(tabId, "$(icon-name)") — the caller applies the icon and persists.
 *
 * Shell (overlay/dialog/header/× close, backdrop + Esc dismissal) comes from
 * {@link BaseModal}; this class only builds the search + grid body. Single
 * instance per webview — opening while mounted refocuses the search.
 */

import { CODICON_NAMES } from "../generated/codicons.js";
import { BaseModal } from "./baseModal.js";

export type IconPickerSelectHandler = (tabId: number, icon: string) => void;

export class IconPickerModal extends BaseModal {
  private currentTabId: number | null = null;
  private search: HTMLInputElement | null = null;
  private grid: HTMLElement | null = null;

  constructor(private readonly onSelect: IconPickerSelectHandler) {
    super("icon-picker", "Choose tab icon");
  }

  open(tabId: number): void {
    this.currentTabId = tabId;
    this.mount();
  }

  protected buildBody(dialog: HTMLElement): void {
    const search = document.createElement("input");
    search.type = "text";
    search.className = "icon-picker-search";
    search.placeholder = "Search icons…";
    search.autocapitalize = "off";
    search.autocomplete = "off";
    search.spellcheck = false;

    const grid = document.createElement("div");
    grid.className = "icon-picker-grid";

    const empty = document.createElement("div");
    empty.className = "icon-picker-empty";
    empty.textContent = "No icons match";
    empty.style.display = "none";

    const status = document.createElement("div");
    status.className = "icon-picker-status";
    status.textContent = `${CODICON_NAMES.length} icons · click to select · Esc to cancel`;

    dialog.append(search, grid, empty, status);

    // Populate full grid up front. ~500 tiny cells is well within what the
    // browser handles without virtualization; jank-free.
    const fragment = document.createDocumentFragment();
    for (const name of CODICON_NAMES) {
      fragment.appendChild(this.buildCell(name));
    }
    grid.appendChild(fragment);

    const filter = (query: string) => {
      const q = query.trim().toLowerCase();
      let visible = 0;
      for (const cell of Array.from(grid.children) as HTMLElement[]) {
        const match = !q || (cell.dataset.name ?? "").includes(q);
        cell.style.display = match ? "" : "none";
        if (match) visible++;
      }
      empty.style.display = visible === 0 ? "" : "none";
      status.textContent = q
        ? `${visible} of ${CODICON_NAMES.length} match · click to select · Esc to cancel`
        : `${CODICON_NAMES.length} icons · click to select · Esc to cancel`;
    };

    search.addEventListener("input", (e) => filter((e.target as HTMLInputElement).value));

    grid.addEventListener("click", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>(".icon-picker-cell");
      if (!cell?.dataset.name) return;
      this.selectAndClose(cell.dataset.name);
    });

    this.search = search;
    this.grid = grid;
  }

  protected onShown(): void {
    this.search?.focus();
  }

  protected onReopen(): void {
    this.search?.focus();
  }

  protected onClose(): void {
    this.currentTabId = null;
    this.search = null;
    this.grid = null;
  }

  protected onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      // Enter selects the first visible cell — quick search→pick flow.
      const first = this.grid?.querySelector<HTMLElement>(
        '.icon-picker-cell:not([style*="display: none"])',
      );
      if (first?.dataset.name) {
        e.preventDefault();
        this.selectAndClose(first.dataset.name);
      }
    }
  }

  private buildCell(name: string): HTMLElement {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "icon-picker-cell";
    cell.dataset.name = name;
    cell.title = name;

    const icon = document.createElement("span");
    icon.className = `codicon codicon-${name}`;
    cell.appendChild(icon);

    return cell;
  }

  private selectAndClose(name: string): void {
    const tabId = this.currentTabId;
    this.close();
    if (tabId === null) return;
    this.onSelect(tabId, `$(${name})`);
  }
}
