// Emptying the trash (v4 handoff §4.5 / proto:4800-4803) — the one thing this
// app does that a member cannot take back.
//
// NO UNDO GRAMMAR HERE. Every other batch in this app narrates through
// `notice(summary, undoFn)`; this one must never pass that second argument,
// because there is nothing on the other side of it. The word "Undo" appearing
// once beside a permanent deletion would be worse than no narration at all.
// The confirmation is the whole safety story, and it happens BEFORE this
// module is ever called (components/EmptyTrash.tsx).
//
// ORDER MATTERS. `media_asset.source_asset_id` (issue #711) is a real
// FK: the vault refuses to purge a photograph while an edited copy still
// names it as its source, because NULLing the copy's lineage would forge
// "camera original" and cascading would destroy a photograph the member never
// trashed. So a trash holding both an edit and its original must purge the
// edit FIRST — `emptyTrashOrder` is that ordering, and without it a member
// would have to press the control twice for no reason they could see.
import { act, narrate, notice } from "./outcomes.ts";
import type { Asset } from "./types.ts";

/**
 * The trash, ordered so a derived copy is always purged before the source it
 * names. Stable: assets with no lineage among the set keep the shelf's own
 * order (newest trashed first).
 *
 * Depth-first over the lineage edges, with a `visiting` guard so a cycle —
 * which the schema's `source_asset_id <> asset_id` CHECK cannot fully rule
 * out across two rows — degrades to "some order" rather than a stack
 * overflow. A cycle would make one of the pair unpurgeable, and the vault
 * says so; it must not make the whole control hang.
 */
export function emptyTrashOrder(trash: readonly Asset[]): Asset[] {
  const byId = new Map(trash.map((asset) => [asset.asset_id, asset]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const ordered: Asset[] = [];
  const visit = (asset: Asset): void => {
    if (done.has(asset.asset_id) || visiting.has(asset.asset_id)) return;
    visiting.add(asset.asset_id);
    // Everything in this set that was derived FROM this asset goes first.
    for (const candidate of trash) {
      if (candidate.source_asset_id === asset.asset_id) visit(candidate);
    }
    visiting.delete(asset.asset_id);
    done.add(asset.asset_id);
    ordered.push(asset);
  };
  for (const asset of trash) visit(byId.get(asset.asset_id) ?? asset);
  return ordered;
}

/** How the run went, in the numbers the summary sentence is built from. */
export interface EmptyTrashResult {
  purged: number;
  /** Refused by the vault — a lineage still points at them, most often. */
  kept: number;
  queued: number;
}

export interface EmptyTrashCallbacks {
  refresh: () => Promise<void>;
  setBusy?: (on: boolean) => void;
}

/**
 * Delete every photograph in `trash` forever, serially, narrating exact
 * progress on the frame's one status line (§14 — counts, never a spinner).
 *
 * Serial by contract, like every other batch here: each `purge-asset` is a
 * separate consent-checked invocation, and the vault's lineage refusal
 * depends on the previous one having landed.
 */
export async function runEmptyTrash(
  trash: readonly Asset[],
  { refresh, setBusy }: EmptyTrashCallbacks
): Promise<EmptyTrashResult> {
  const targets = emptyTrashOrder(trash);
  setBusy?.(true);
  const result: EmptyTrashResult = { purged: 0, kept: 0, queued: 0 };
  let lastBad: VaultOutcome | undefined = undefined;
  const purgeNext = async (i: number): Promise<void> => {
    const asset = targets[i];
    if (!asset) return;
    notice(`Deleting ${i + 1} of ${targets.length}…`, undefined, {
      done: i,
      total: targets.length,
    });
    const outcome = await act(
      "purge-asset",
      { asset_id: asset.asset_id },
      asset.scope_id
    );
    if (outcome?.status === "executed") result.purged += 1;
    else if (outcome?.status === "queued" || outcome?.status === "in-flight")
      result.queued += 1;
    else {
      result.kept += 1;
      lastBad = outcome;
    }
    return purgeNext(i + 1);
  };
  await purgeNext(0);
  setBusy?.(false);
  await refresh();
  notice(emptyTrashSummary(result));
  // The last refusal's own words, after the summary — a member who kept two
  // photographs deserves the vault's reason, not just the count.
  if (lastBad) narrate(lastBad);
  return result;
}

/** The summary sentence. Never carries an Undo — there is nothing to undo. */
export function emptyTrashSummary(result: EmptyTrashResult): string {
  const parts: string[] = [];
  if (result.purged > 0) {
    parts.push(
      `Deleted ${result.purged} ${result.purged === 1 ? "photograph" : "photographs"} forever`
    );
  }
  if (result.queued > 0) parts.push(`${result.queued} saved offline`);
  if (result.kept > 0) parts.push(`${result.kept} kept`);
  return parts.join(" · ") || "Nothing to delete";
}
