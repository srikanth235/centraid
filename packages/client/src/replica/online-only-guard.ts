import { OnlineOnlyError } from './online-only-error.js';

/** Sticky even when query handler code catches the capability failure. */
export class OnlineOnlyGuard {
  #error: OnlineOnlyError | undefined;

  mark(reason: string | OnlineOnlyError): OnlineOnlyError {
    const error = typeof reason === 'string' ? new OnlineOnlyError(reason) : reason;
    this.#error ??= error;
    return error;
  }

  get required(): boolean {
    return this.#error !== undefined;
  }

  assertLocal(): void {
    if (this.#error) throw this.#error;
  }
}
