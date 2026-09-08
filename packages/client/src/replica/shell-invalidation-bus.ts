// WHO IS TOLD WHAT CHANGED (#996, W5; #922 E3).
//
// A screen subscribes to the ENTITIES it reads, and is told when they move.
// That is the whole surface, and it is smaller than what it replaced: an
// invalidation used to carry a SHAPE ID, and every subscriber had to hold a
// catalog to know which shapes were its app's. A seat has one vault, so an
// entity names its own rows and a subscriber names the entities it cares about.
//
// A SUBSCRIBER THAT NAMES NOTHING IS TOLD EVERYTHING. Some callers — the inline
// bridge, an app that re-runs its whole board — genuinely want every change,
// and making them enumerate would be a list that silently goes stale as the app
// grows.
//
// A PURGE REACHES EVERYONE, whatever they asked for. It is not a change to some
// rows; it is the plane every read stands on being replaced, and a subscriber
// that filtered it out would go on drawing a vault that is gone.
//
// A FAILING LISTENER MUST NOT STARVE THE OTHERS. One of these is an iframe.

import type { ReplicaDependency, ReplicaInvalidation } from "./types.js";

export class InvalidationBus {
  readonly #listeners = new Set<
    (invalidations: readonly ReplicaInvalidation[]) => void
  >();

  subscribe(
    dependencies: readonly ReplicaDependency[] | undefined,
    listener: (invalidations: readonly ReplicaInvalidation[]) => void
  ): () => void {
    const wanted = new Set((dependencies ?? []).map((d) => d.entity));
    const forward = (invalidations: readonly ReplicaInvalidation[]): void => {
      const relevant = invalidations.filter(
        (invalidation) =>
          invalidation.source === "purge" ||
          wanted.size === 0 ||
          wanted.has(invalidation.entity)
      );
      if (relevant.length > 0) listener(structuredClone(relevant));
    };
    this.#listeners.add(forward);
    return () => this.#listeners.delete(forward);
  }

  emit(invalidations: readonly ReplicaInvalidation[]): void {
    if (invalidations.length === 0) return;
    for (const listener of this.#listeners) {
      try {
        listener(invalidations);
      } catch {
        /* A failed iframe subscriber must not starve local live queries. */
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
