// Storage's custody arithmetic (#711) over the gateway's rollup: the whole
// library, not the loaded window. Absence is reported, never zeroed.
import type { StorageBucket, StorageRollup } from "./queries/storage.ts";

export interface ScopeRollup {
  label: string;
  rollup: StorageRollup | null;
}

export interface Totals {
  count: number;
  bytes: number;
}

/** `known` false means NO scope has a rollup: never render zeroes for it. */
export interface CustodyFacts {
  known: boolean;
  unread: string[];
  uncounted: string[];
  checkedAt: string | null;
  library: Totals;
  backedUp: Totals;
  elsewhere: Totals;
  onlyHere: Totals;
  waiting: Totals;
  missing: Totals;
  freeable: Totals;
  unproven: Totals;
}

/** Deliberately no `failing`: the rollup carries no error data. */
export type CustodyHealth =
  | "unknown"
  | "missing"
  | "only-here"
  | "waiting"
  | "held";

const ZERO: Totals = { count: 0, bytes: 0 };

function sum(a: Totals, b: Totals): Totals {
  return { count: a.count + b.count, bytes: a.bytes + b.bytes };
}

function bucketOf(rollup: StorageRollup, bucket: StorageBucket): Totals {
  return rollup.buckets[bucket];
}

export function custodyFacts(scopes: readonly ScopeRollup[]): CustodyFacts {
  const facts: CustodyFacts = {
    known: false,
    unread: [],
    uncounted: [],
    checkedAt: null,
    library: ZERO,
    backedUp: ZERO,
    elsewhere: ZERO,
    onlyHere: ZERO,
    waiting: ZERO,
    missing: ZERO,
    freeable: ZERO,
    unproven: ZERO,
  };
  for (const scope of scopes) {
    const rollup = scope.rollup;
    if (!rollup) {
      facts.unread.push(scope.label);
      continue;
    }
    if (rollup.computedAt === null) {
      facts.uncounted.push(scope.label);
      continue;
    }
    facts.known = true;
    if (facts.checkedAt === null || rollup.computedAt < facts.checkedAt)
      facts.checkedAt = rollup.computedAt;
    facts.backedUp = sum(facts.backedUp, bucketOf(rollup, "replicated"));
    facts.elsewhere = sum(facts.elsewhere, bucketOf(rollup, "remote-only"));
    facts.onlyHere = sum(facts.onlyHere, bucketOf(rollup, "local-only"));
    facts.waiting = sum(facts.waiting, bucketOf(rollup, "pending-offsite"));
    facts.missing = sum(facts.missing, bucketOf(rollup, "missing"));
    facts.freeable = sum(facts.freeable, bucketOf(rollup, "freeable"));
    facts.unproven = sum(facts.unproven, bucketOf(rollup, "local-unproven"));
  }
  // Five custody-state buckets only: the other two double-count.
  facts.library = [
    facts.backedUp,
    facts.elsewhere,
    facts.onlyHere,
    facts.waiting,
    facts.missing,
  ].reduce((total, bucket) => sum(total, bucket), ZERO);
  return facts;
}

export function custodyHealth(facts: CustodyFacts): CustodyHealth {
  if (!facts.known) return "unknown";
  if (facts.missing.count > 0) return "missing";
  if (facts.onlyHere.count > 0) return "only-here";
  if (facts.waiting.count > 0) return "waiting";
  return "held";
}

export function freeUpIsOfferable(facts: CustodyFacts): boolean {
  return facts.known && facts.freeable.count > 0 && facts.freeable.bytes > 0;
}
