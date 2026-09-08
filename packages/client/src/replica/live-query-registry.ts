import type { LiveQuery } from "./live-query.js";
import type { ReplicaInvalidation } from "./types.js";
import { bumpClientWorkCounter } from "./work-counters.js";

export class LiveQueryRegistry {
  readonly #queries = new Set<LiveQuery<unknown>>();

  track<T>(query: LiveQuery<T>): LiveQuery<T> {
    this.#queries.add(query as LiveQuery<unknown>);
    query.onDispose(() => this.#queries.delete(query as LiveQuery<unknown>));
    return query;
  }

  invalidate(invalidations: ReplicaInvalidation[]): void {
    // #927 P2 / #922 D4: one bump per invalidation FIRED, before fan-out. The
    // matching half is `reReads` in `live-query.ts` — the two together say
    // "this action fired N invalidations and they cost M query executions",
    // which is the number a fan-out regression moves.
    bumpClientWorkCounter("invalidations", invalidations.length);
    for (const invalidation of invalidations) {
      for (const query of this.#queries) query.invalidate(invalidation);
    }
  }

  dispose(): void {
    for (const query of this.#queries) query.dispose();
    this.#queries.clear();
  }
}
