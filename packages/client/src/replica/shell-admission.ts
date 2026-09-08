// WHAT A WRITER IS TOLD, AND WHEN (#880, #922 G3).
//
// `session.write()` returns a PROMISE, and what that promise settles to is the
// member's answer: saved, sending, queued, refused. The rules are small and
// each of them was a bug first:
//
//   A WRITER MUST NEVER WAIT FOREVER. The outbox drains in order, so an intent
//   behind a failed head is not claimed until the retry — and its writer is
//   settled on its DURABLE ADMISSION rather than left awaiting a send that will
//   not happen for minutes.
//
//   AND IT MUST NOT BE ANSWERED BEFORE IT ASKED. The drain can settle an intent
//   between the enqueue and the caller registering its waiter, and the answer
//   would then land on nobody. The registration BARRIER is what closes that
//   window: a drain waits for every in-flight `write()` to finish registering
//   before it resolves anything.
//
// A MODULE OF ITS OWN because it is the one piece of the session that is pure
// bookkeeping over promises — no seat, no queue, no transport — and it is the
// piece a reader has to hold entirely in mind to trust the write path.

export interface AdmissionWaiter<Result> {
  resolve: (result: Result) => void;
  reject: (error: unknown) => void;
}

export class AdmissionWaiters<Result extends { status: string }> {
  readonly #waiters = new Map<string, Set<AdmissionWaiter<Result>>>();
  #registrations = 0;
  #barrier: Promise<void> | undefined;
  #release: (() => void) | undefined;

  constructor(
    /** Called for each settled result, so the seat can be caught up. */
    private readonly onSettled: (result: Result) => void = () => undefined
  ) {}

  /** Register a waiter for one intent. The caller awaits the promise. */
  await(intentId: string): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      const waiters = this.#waiters.get(intentId) ?? new Set();
      waiters.add({ resolve, reject });
      this.#waiters.set(intentId, waiters);
    });
  }

  resolve(intentId: string, result: Result): void {
    const waiters = this.#waiters.get(intentId);
    if (!waiters) return;
    this.#waiters.delete(intentId);
    this.onSettled(result);
    for (const waiter of waiters) waiter.resolve(structuredClone(result));
  }

  reject(intentId: string, error: unknown): void {
    const waiters = this.#waiters.get(intentId);
    if (!waiters) return;
    this.#waiters.delete(intentId);
    for (const waiter of waiters) waiter.reject(error);
  }

  rejectAll(error: unknown): void {
    // Snapshot the ids first: `reject` deletes as it goes, and mutating the
    // map under its own iterator drops every other waiter.
    const pending = Array.from(this.#waiters.keys());
    for (const intentId of pending) this.reject(intentId, error);
  }

  /** Settle everyone still waiting on their durable admission (#880). */
  resolveAllAsQueued(
    reason: string,
    queued: (intentId: string) => Result
  ): void {
    const pending = Array.from(this.#waiters.keys());
    for (const intentId of pending)
      this.resolve(intentId, { ...queued(intentId), reason } as Result);
  }

  /** A `write()` has enqueued and is about to register; hold the drain. */
  beginRegistration(): void {
    if (this.#registrations === 0) {
      this.#barrier = new Promise((resolve) => {
        this.#release = resolve;
      });
    }
    this.#registrations += 1;
  }

  finishRegistration(): void {
    this.#registrations -= 1;
    if (this.#registrations !== 0) return;
    const release = this.#release;
    this.#release = undefined;
    this.#barrier = undefined;
    release?.();
  }

  /** Wait until no `write()` is mid-registration. Re-checks: one may start. */
  async settleRegistrations(): Promise<void> {
    if (!this.#barrier) return;
    await this.#barrier;
    return this.settleRegistrations();
  }
}
