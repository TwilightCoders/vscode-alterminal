/**
 * BaseModal — shared shell for webview modals (icon picker, launch menu, …).
 *
 * Owns the parts every modal repeated by hand: the overlay + dialog, a header
 * with a title and a × close button, backdrop-click and Esc dismissal, and the
 * mount/teardown lifecycle (global keydown listener add/remove, body
 * attach/detach). Subclasses fill the body via {@link buildBody} and react via
 * the lifecycle hooks.
 *
 * Class naming: the overlay/dialog keep a per-modal prefix (`<prefix>-overlay`,
 * `<prefix>-dialog`) so each modal's specific CSS (width, alignment, body
 * layout) is untouched; the shared header/title/close use `modal-*` classes so
 * their styling lives in one place.
 */
export abstract class BaseModal {
  protected overlay: HTMLElement | null = null;
  protected dialog: HTMLElement | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    private readonly prefix: string,
    private readonly titleText: string,
  ) {}

  protected get isOpen(): boolean {
    return this.overlay !== null;
  }

  /**
   * Build + mount the modal. If it's already open, defers to {@link onReopen}
   * (typically refocus) and returns — single instance per modal.
   */
  protected mount(): void {
    if (this.overlay) {
      this.onReopen();
      return;
    }

    const overlay = document.createElement("div");
    overlay.className = `${this.prefix}-overlay`;

    const dialog = document.createElement("div");
    dialog.className = `${this.prefix}-dialog`;

    const header = document.createElement("div");
    header.className = "modal-header";

    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = this.titleText;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "modal-close codicon codicon-close";
    close.title = "Close";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this.close());

    header.append(title, close);
    dialog.appendChild(header);
    overlay.appendChild(dialog);

    this.overlay = overlay;
    this.dialog = dialog;

    // Subclass appends its body elements into the dialog (after the header).
    this.buildBody(dialog);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        this.close();
      }
    });

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
        return;
      }
      this.onKeyDown(e);
    };
    document.addEventListener("keydown", this.keyHandler);

    document.body.appendChild(overlay);

    // Defer focus so the modal is in the DOM before we steal focus.
    requestAnimationFrame(() => this.onShown());
  }

  public close(): void {
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    this.overlay?.remove();
    this.overlay = null;
    this.dialog = null;
    this.onClose();
  }

  /** Append the modal's body elements into `dialog` (after the header). */
  protected abstract buildBody(dialog: HTMLElement): void;

  /** After mount, in a rAF (DOM is live). Focus inputs / render here. */
  protected onShown(): void {}

  /** mount() called while already open — refocus the relevant input. */
  protected onReopen(): void {}

  /** Subclass field cleanup on close (the base already removed the DOM). */
  protected onClose(): void {}

  /** A non-Esc keydown while open (Enter, arrows, …). */
  protected onKeyDown(_e: KeyboardEvent): void {}
}
