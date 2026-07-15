import { LiveQuery } from './live-query.js';
import type { ReplicaInvalidation } from './types.js';

export class LiveQueryRegistry {
  readonly #queries = new Set<LiveQuery<unknown>>();

  track<T>(query: LiveQuery<T>): LiveQuery<T> {
    this.#queries.add(query as LiveQuery<unknown>);
    query.onDispose(() => this.#queries.delete(query as LiveQuery<unknown>));
    return query;
  }

  invalidate(invalidations: ReplicaInvalidation[]): void {
    for (const invalidation of invalidations) {
      for (const query of this.#queries) query.invalidate(invalidation);
    }
  }

  dispose(): void {
    for (const query of this.#queries) query.dispose();
    this.#queries.clear();
  }
}
