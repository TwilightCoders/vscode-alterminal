/**
 * Tab Icon Picker — webview-side modal.
 *
 * Renders a searchable grid of all VS Code codicons (~525). Replaces the
 * 12-item QuickPick that the host used to show. On selection, invokes
 * onSelect(tabId, "$(icon-name)") — the caller is responsible for
 * applying the icon and persisting state.
 *
 * Single instance per webview — opening while one is mounted is a no-op
 * (the existing one keeps focus). Esc, backdrop click, or selection
 * dismisses it.
 */

import { CODICON_NAMES } from "../generated/codicons.js";

export type IconPickerSelectHandler = (tabId: number, icon: string) => void;

export class IconPickerModal {
  private overlay: HTMLElement | null = null;
  private currentTabId: number | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(private readonly onSelect: IconPickerSelectHandler) {}

  open(tabId: number): void {
    if (this.overlay) {
      // Already open — refocus the search input.
      const search = this.overlay.querySelector<HTMLInputElement>(".icon-picker-search");
      search?.focus();
      return;
    }

    this.currentTabId = tabId;

    const overlay = document.createElement("div");
    overlay.className = "icon-picker-overlay";

    const dialog = document.createElement("div");
    dialog.className = "icon-picker-dialog";

    const title = document.createElement("div");
    title.className = "icon-picker-title";
    title.textContent = "Choose tab icon";

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

    dialog.append(title, search, grid, empty, status);
    overlay.appendChild(dialog);

    // Populate full grid up front. 525 items × tiny cells is well within
    // what the browser handles without virtualization; jank-free.
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

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "Enter") {
        // Enter selects the first visible cell — quick search→pick flow.
        const first = grid.querySelector<HTMLElement>('.icon-picker-cell:not([style*="display: none"])');
        if (first?.dataset.name) {
          e.preventDefault();
          this.selectAndClose(first.dataset.name);
        }
      }
    };
    document.addEventListener("keydown", this.keyHandler);

    document.body.appendChild(overlay);
    this.overlay = overlay;

    // Defer focus so the modal is in the DOM before we steal focus.
    requestAnimationFrame(() => search.focus());
  }

  close(): void {
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    this.overlay?.remove();
    this.overlay = null;
    this.currentTabId = null;
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
