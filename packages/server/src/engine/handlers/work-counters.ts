/*
 * The engine's slice of the #927 work counters.
 *
 * A SECOND registry. `@centraid/vault` counts the work it does
 * (statements, rows, durability barriers, payload bytes) and this counts the
 * work the app-handler engine does (worker spawns). The engine must not import
 * `@centraid/vault` — the import-boundary checker aside, `handler-runner.ts`
 * exists to keep module load cheap enough that importing it does not spawn
 * threads (#404), and pulling the whole vault package in for one integer would
 * undo that. The consumer sums the two with `addCounters`, which is exactly the
 * shape the contract in `@centraid/core/protocol` provides for it.
 *
 * Monotonic within a process: one totals object, never replaced, never rewound.
 */

import { zeroCounters } from "@centraid/core/protocol";
import type { WorkCounterKey, WorkCounters } from "@centraid/core/protocol";

const totals = zeroCounters();

export function bumpEngineWorkCounter(key: WorkCounterKey, amount = 1): void {
  if (amount <= 0) return;
  totals[key] += amount;
}

export function engineWorkCounters(): WorkCounters {
  return { ...totals };
}
