import type { ReplicaInvalidation } from "../../replica/types.js";

/** The page-side shape of one change event (`window.centraid.onChange`). */
export interface InlineChangeDetail {
  tables?: string[];
  source?: string;
  intentId?: string;
  intentState?: string;
  ts?: number;
  scope?: string;
}

/** Wildcard the coordinator emits for bootstrap, commit, purge or scope
 *  teardown: "everything here may have moved". Never a table name. */
const EVERYTHING = "*";

/**
 * ONE APPLIED BATCH IS ONE CHANGE EVENT (#922 D1).
 *
 * The coordinator emits every invalidation an `applyChanges` produced in a
 * single call, so a 40-edit reconnect arrives as one array. Fanning that array
 * out one event per element made the screen re-read forty times for one sync —
 * the count this collapse exists to hold at one per batch per source.
 *
 * NO TIMER, and deliberately so: the owner's own write must reach the screen
 * with nothing between it and the read, so this is a pure function of the array
 * the store already handed over, not a window that waits for a second batch.
 * An invalidation carrying an `intentId` is that owner's write settling, and
 * stays ONE EVENT PER INTENT: the state transition is what the app narrates,
 * and merging two intents would leave one of them unnarrated.
 */
export function collapseInlineChanges(
  invalidations: readonly ReplicaInvalidation[],
  scope: string,
  now: number
): InlineChangeDetail[] {
  const detail = (
    source: string,
    tables: string[],
    intent?: ReplicaInvalidation
  ): InlineChangeDetail => ({
    tables,
    source,
    ...(intent?.intentId ? { intentId: intent.intentId } : {}),
    ...(intent?.intentState ? { intentState: intent.intentState } : {}),
    ts: now,
    ...(scope ? { scope } : {}),
  });
  const narrated: InlineChangeDetail[] = [];
  // Insertion-ordered so the collapsed events keep the batch's source order.
  const merged = new Map<string, { wildcard: boolean; tables: Set<string> }>();
  for (const invalidation of invalidations) {
    const named =
      invalidation.entity && invalidation.entity !== EVERYTHING
        ? invalidation.entity
        : undefined;
    if (invalidation.intentId !== undefined) {
      narrated.push(
        detail(invalidation.source, named ? [named] : [], invalidation)
      );
      continue;
    }
    const group = merged.get(invalidation.source) ?? {
      wildcard: false,
      tables: new Set<string>(),
    };
    if (named === undefined) group.wildcard = true;
    else group.tables.add(named);
    merged.set(invalidation.source, group);
  }
  return [
    // Rows first, settlement after: the narration describes a board the app has
    // already been told to re-read.
    ...[...merged].map(([source, group]) =>
      detail(source, group.wildcard ? [] : [...group.tables])
    ),
    ...narrated,
  ];
}
