/*
 * The seat's slice of the #927 work counters — the always-on half of the
 * instrumentation on every client that holds a replica.
 *
 * A THIRD registry beside the gateway's and the engine's, for the same reason
 * they are separate: this code runs in a browser, in a worker and on Hermes,
 * where `@centraid/vault` and `node:*` do not exist. `addCounters` in the
 * contract is what puts the three back together for a consumer that wants one
 * number.
 *
 * WHAT IS COUNTED HERE, and where:
 *   `httpRoundTrips`  — `shell-transport.ts`, one per call into the fetcher.
 *   `invalidations`   — `live-query-registry.ts`, one per invalidation fired.
 *   `reReads`         — `live-query.ts`, one per query execution the invalidation
 *                       actually caused. This IS #922's reads-per-action
 *                       counter; there is not a second one.
 *
 * Monotonic within a process: one totals object, never replaced, never rewound,
 * so any two snapshots diff in one direction and `diffCounters` cannot trip.
 */

import { zeroCounters } from "@centraid/core/protocol";
import type { WorkCounterKey, WorkCounters } from "@centraid/core/protocol";

const totals = zeroCounters();

export function bumpClientWorkCounter(key: WorkCounterKey, amount = 1): void {
  if (amount <= 0) return;
  totals[key] += amount;
}

/** A snapshot; the caller owns the copy and may keep it for a later diff. */
export function clientWorkCounters(): WorkCounters {
  return { ...totals };
}
