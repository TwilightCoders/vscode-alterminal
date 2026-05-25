/**
 * A minimal event emitter, shaped like xterm's `Emitter`/`Event` pair so the
 * addon's public events feel native to xterm consumers — without taking a
 * dependency on xterm's internal `vs/base/common/event` module.
 */
export interface IDisposable {
  dispose(): void;
}

export type Listener<T> = (data: T) => void;
export type Event<T> = (listener: Listener<T>) => IDisposable;

export class Emitter<T> {
  private _listeners = new Set<Listener<T>>();

  public readonly event: Event<T> = (listener: Listener<T>): IDisposable => {
    this._listeners.add(listener);
    return {
      dispose: () => {
        this._listeners.delete(listener);
      },
    };
  };

  public fire(data: T): void {
    for (const listener of [...this._listeners]) {
      listener(data);
    }
  }

  public dispose(): void {
    this._listeners.clear();
  }
}
