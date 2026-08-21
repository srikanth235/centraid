// The Storage screen's custody arithmetic (issue #711, §12) — pure functions
// over the gateway's rollup, so every number on that screen is unit-testable
// without a DOM, exactly as `storageFacts` (components/Storage.tsx) already is
// for the loaded window.
//
// The division of labour between the two is the point:
//
//   * `storageFacts` describes THE PHOTOGRAPHS LOADED HERE. It is honest about
//     being a window, and it is the only thing that can speak about the trash
//     (a shelf the rollup does not model).
//   * this module describes THE WHOLE LIBRARY, because the gateway counted it.
//     It never guesses; when a scope has no rollup it says which scope, and
//     when no scope has one it says nobody has looked yet.
//
// NOTHING HERE INVENTS A NUMBER. Every field traces to a bucket the vault
// projection wrote (packages/vault/src/blob/custody-rollup.ts). Where the
// projection is silent — why a backup has not run, when it will next, whether
// a connection is failing — this module has no field, and the view has no
// sentence. Absence is reported as absence.
import type { StorageBucket, StorageRollup } from "./queries/storage.ts";

/** One mounted scope's answer, as the store collected it. */
export interface ScopeRollup {
  /** The scope's human label — the ONLY string the view may name it by. */
  label: string;
  /** The rollup this scope returned, or null when the read failed. */
  rollup: StorageRollup | null;
}

/** A count and the bytes it accounts for. */
export interface Totals {
  count: number;
  bytes: number;
}

/**
 * What the whole library's custody looks like, or why it cannot be said.
 *
 * `known` is the gate: false means NOT ONE mounted scope has a computed
 * rollup, and the view must say so rather than render zeroes, which read as
 * "you have nothing" instead of "nothing has been counted".
 */
export interface CustodyFacts {
  known: boolean;
  /** Labels of scopes whose rollup could not be read at all. */
  unread: string[];
  /** Labels of scopes the gateway has mounted but never swept. */
  uncounted: string[];
  /**
   * The OLDEST sweep instant across the scopes that have one — the weakest
   * link, because a total is only as current as its stalest part. Null when
   * nothing has been swept.
   */
  checkedAt: string | null;
  /** Every original the gateway counted, in any custody state. */
  library: Totals;
  /** On the gateway and off it — nothing more to do for these. */
  backedUp: Totals;
  /** Held on the gateway only; this machine never had them or let them go. */
  elsewhere: Totals;
  /** Not yet anywhere but the gateway's own disk. */
  onlyHere: Totals;
  /** Queued to leave, nothing wrong yet. */
  waiting: Totals;
  /** In NEITHER tier — an integrity gap, never a rounding error. */
  missing: Totals;
  /** Locally resident originals with a proven copy elsewhere. */
  freeable: Totals;
  /** Locally resident originals with no such proof — never offered. */
  unproven: Totals;
}

/**
 * The one health verdict the rollup can support. There is deliberately no
 * `failing`: the projection carries no error, no attempt count and no next-run
 * time, so a surface claiming "the last three runs were refused" would be
 * making it up. `missing` is the danger this data CAN prove.
 */
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

/**
 * Fold every mounted scope's rollup into one set of facts.
 *
 * Scopes are summed, not shown side by side: a member asking "what do my
 * photographs cost?" means all of them, and Photos already paints one merged
 * timeline over N scopes. Scopes that could not answer are named instead of
 * being silently treated as empty — a missing scope makes every total below a
 * floor, and the view says which one is absent.
 */
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
      // Mounted and readable, but the sweep has never run here. Its zeroes are
      // not facts about the library, so none of them are added.
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
  // The library is the five CUSTODY-STATE buckets only. `freeable` and
  // `local-unproven` describe the same originals from the disk's point of
  // view, and adding them in would count every photograph twice.
  facts.library = [
    facts.backedUp,
    facts.elsewhere,
    facts.onlyHere,
    facts.waiting,
    facts.missing,
  ].reduce((total, bucket) => sum(total, bucket), ZERO);
  return facts;
}

/**
 * The health verdict, worst first. Order is severity, not size: one photograph
 * whose bytes are in neither tier outranks a thousand merely waiting for an
 * upload, because only one of those is a loss.
 */
export function custodyHealth(facts: CustodyFacts): CustodyHealth {
  if (!facts.known) return "unknown";
  if (facts.missing.count > 0) return "missing";
  if (facts.onlyHere.count > 0) return "only-here";
  if (facts.waiting.count > 0) return "waiting";
  return "held";
}

/**
 * Whether a free-up offer may be shown at all.
 *
 * The projection proved these bytes are held somewhere that is not this disk
 * (`freeable`), so removing the local copy loses nothing. Everything else on
 * the machine is `local-unproven` and is never part of an offer, at any size.
 * A zero-byte `freeable` count is not an offer either — there is nothing to
 * describe, and an offer to free nothing is a control with no effect.
 */
export function freeUpIsOfferable(facts: CustodyFacts): boolean {
  return facts.known && facts.freeable.count > 0 && facts.freeable.bytes > 0;
}
