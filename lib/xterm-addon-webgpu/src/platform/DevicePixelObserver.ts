/**
 * Observes `window.devicePixelRatio` changes (e.g. dragging a window between a
 * Retina and a non-Retina display) and invokes a callback so the renderer can
 * re-rasterize glyphs and resize its backing surface.
 *
 * The `matchMedia("(resolution: Ndppx)")` trick is the standard way to get a
 * change event for DPR; we re-arm the listener after each change because the
 * query is pinned to the old ratio. Ported from `@xterm/addon-webgl`.
 */
export class DevicePixelObserver {
  private _mql?: MediaQueryList;
  private _listener?: () => void;
  private _disposed = false;

  constructor(private readonly _onChange: () => void) {
    this._arm();
  }

  private _arm(): void {
    if (this._disposed || typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    this._mql = window.matchMedia(`screen and (resolution: ${dpr}dppx)`);
    this._listener = () => {
      if (this._disposed) {
        return;
      }
      this._onChange();
      this._disarm();
      this._arm();
    };
    // `addEventListener` is the modern API; older Safari used `addListener`.
    if (this._mql.addEventListener) {
      this._mql.addEventListener("change", this._listener);
    } else {
      (this._mql as unknown as { addListener(cb: () => void): void }).addListener(this._listener);
    }
  }

  private _disarm(): void {
    if (this._mql && this._listener) {
      if (this._mql.removeEventListener) {
        this._mql.removeEventListener("change", this._listener);
      } else {
        (this._mql as unknown as { removeListener(cb: () => void): void }).removeListener(this._listener);
      }
    }
    this._mql = undefined;
    this._listener = undefined;
  }

  public dispose(): void {
    this._disposed = true;
    this._disarm();
  }
}
