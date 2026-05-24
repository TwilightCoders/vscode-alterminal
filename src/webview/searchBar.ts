/**
 * SearchBar — UI controller for the floating Find widget. Wraps xterm's
 * SearchAddon on whichever terminal is active when opened.
 *
 * Lifecycle:
 *   open(addon) — show, focus input, run an initial search if the input
 *     already has text (e.g. user re-opens with a previous query).
 *   close()    — clear decorations on the bound addon, hide UI.
 */
const SEARCH_OPTS = {
  decorations: {
    matchBackground: "#88665020",
    activeMatchBackground: "#ffaa00aa",
    matchBorder: "#88665080",
    activeMatchBorder: "#ff8800",
    matchOverviewRuler: "#cc8844",
    activeMatchColorOverviewRuler: "#ff8800",
  },
} as const;

export class SearchBar {
  private root: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private countEl: HTMLElement | null = null;
  private addon: any = null;
  private resultsDisposable: { dispose(): void } | null = null;

  install(): void {
    this.root = document.getElementById("search-bar");
    this.input = document.getElementById("search-input") as HTMLInputElement | null;
    this.countEl = document.getElementById("search-count");
    if (!this.root || !this.input) return;

    this.input.addEventListener("input", () => this.runSearch());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    document.getElementById("search-next")?.addEventListener("click", () => this.runSearch());
    document.getElementById("search-prev")?.addEventListener("click", () => this.runSearch(true));
    document.getElementById("search-close")?.addEventListener("click", () => this.close());
  }

  open(addon: any): void {
    if (!this.root || !this.input) return;
    this.bindAddon(addon);
    this.root.hidden = false;
    this.input.focus();
    this.input.select();
    if (this.input.value) this.runSearch();
  }

  close(): void {
    if (!this.root) return;
    this.root.hidden = true;
    this.addon?.clearDecorations?.();
    this.resultsDisposable?.dispose();
    this.resultsDisposable = null;
    this.addon = null;
    if (this.countEl) this.countEl.textContent = "";
  }

  isOpen(): boolean {
    return !!this.root && !this.root.hidden;
  }

  private bindAddon(addon: any): void {
    if (this.addon === addon) return;
    this.resultsDisposable?.dispose();
    this.addon = addon;
    if (addon?.onDidChangeResults) {
      this.resultsDisposable = addon.onDidChangeResults(
        ({ resultIndex, resultCount }: { resultIndex: number; resultCount: number }) => {
          if (!this.countEl) return;
          this.countEl.textContent =
            resultCount === 0 ? "No matches"
            : resultIndex < 0 ? `${resultCount} matches`
            : `${resultIndex + 1} of ${resultCount}`;
        },
      );
    }
  }

  private runSearch(reverse: boolean = false): void {
    if (!this.addon || !this.input) return;
    const q = this.input.value;
    if (!q) {
      this.addon.clearDecorations?.();
      if (this.countEl) this.countEl.textContent = "";
      return;
    }
    if (reverse) this.addon.findPrevious?.(q, SEARCH_OPTS);
    else this.addon.findNext?.(q, SEARCH_OPTS);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.runSearch(e.shiftKey);
    }
  }
}
