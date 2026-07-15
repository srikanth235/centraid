import type { ReplicaDependency, ReplicaInvalidation } from './types.js';

export interface LiveQueryExecution<T> {
  value: T;
  dependencies: ReplicaDependency[];
}

export interface LiveQueryObserver<T> {
  next(value: T): void;
  error?(error: unknown): void;
}

export type LiveQuerySubscriber<T> = LiveQueryObserver<T> | ((value: T) => void);
export type LiveQueryRunner<T> = (signal: AbortSignal) => Promise<LiveQueryExecution<T>>;

/** Awaitable first result plus an ongoing local subscription. */
export class LiveQuery<T> implements PromiseLike<T> {
  readonly #observers = new Set<LiveQueryObserver<T>>();
  readonly #first: Promise<T>;
  readonly #resolveFirst: (value: T) => void;
  readonly #rejectFirst: (error: unknown) => void;
  #firstSettled = false;
  #dependencies = new Set<string>();
  #current: T | undefined;
  #hasCurrent = false;
  #running = false;
  #dirty = true;
  #disposed = false;
  #abort: AbortController | undefined;
  readonly #disposeListeners = new Set<() => void>();

  constructor(private readonly runner: LiveQueryRunner<T>) {
    let resolveFirst!: (value: T) => void;
    let rejectFirst!: (error: unknown) => void;
    this.#first = new Promise<T>((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });
    this.#resolveFirst = resolveFirst;
    this.#rejectFirst = rejectFirst;
    void this.#first.catch(() => undefined);
    void this.run();
  }

  // eslint-disable-next-line unicorn/no-thenable -- (#406) read() intentionally remains await-compatible while adding subscribe(); governance: allow-no-unjustified-suppressions compatibility contract
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.#first.then(onfulfilled, onrejected);
  }

  subscribe(subscriber: LiveQuerySubscriber<T>, emitCurrent = true): () => void {
    const observer = typeof subscriber === 'function' ? { next: subscriber } : subscriber;
    this.#observers.add(observer);
    if (emitCurrent && this.#hasCurrent) observer.next(this.#current as T);
    return () => this.#observers.delete(observer);
  }

  invalidate(invalidation: ReplicaInvalidation): void {
    if (this.#disposed || !this.matches(invalidation)) return;
    this.#dirty = true;
    void this.run();
  }

  refresh(): void {
    if (this.#disposed) return;
    this.#dirty = true;
    void this.run();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abort?.abort();
    this.#observers.clear();
    for (const listener of this.#disposeListeners) listener();
    this.#disposeListeners.clear();
  }

  onDispose(listener: () => void): () => void {
    if (this.#disposed) {
      listener();
      return () => undefined;
    }
    this.#disposeListeners.add(listener);
    return () => this.#disposeListeners.delete(listener);
  }

  private matches(invalidation: ReplicaInvalidation): boolean {
    if (invalidation.source === 'purge') return true;
    if (this.#dependencies.size === 0) return true;
    return this.#dependencies.has(keyOf(invalidation));
  }

  private async run(): Promise<void> {
    if (this.#running || this.#disposed) return;
    this.#running = true;
    try {
      while (this.#dirty && !this.#disposed) {
        this.#dirty = false;
        const abort = new AbortController();
        this.#abort = abort;
        try {
          const execution = await this.runner(abort.signal);
          if (abort.signal.aborted || this.#disposed) return;
          this.#dependencies = new Set(execution.dependencies.map(keyOf));
          this.#current = execution.value;
          this.#hasCurrent = true;
          if (!this.#firstSettled) {
            this.#firstSettled = true;
            this.#resolveFirst(execution.value);
          }
          for (const observer of this.#observers) {
            try {
              observer.next(execution.value);
            } catch {
              /* One subscriber cannot prevent delivery to the others. */
            }
          }
        } catch (error) {
          if (abort.signal.aborted || this.#disposed) return;
          if (!this.#firstSettled) {
            this.#firstSettled = true;
            this.#rejectFirst(error);
          }
          for (const observer of this.#observers) {
            try {
              observer.error?.(error);
            } catch {
              /* One subscriber cannot prevent delivery to the others. */
            }
          }
        } finally {
          if (this.#abort === abort) this.#abort = undefined;
        }
      }
    } finally {
      this.#running = false;
      if (this.#dirty && !this.#disposed) void this.run();
    }
  }
}

function keyOf(dependency: ReplicaDependency): string {
  return `${dependency.shapeId}\u0000${dependency.entity}`;
}
