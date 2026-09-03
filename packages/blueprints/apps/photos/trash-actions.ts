import { act, narrate, notice } from "./outcomes.ts";
import type { Asset } from "./types.ts";

export function emptyTrashOrder(trash: readonly Asset[]): Asset[] {
  const byId = new Map(trash.map((asset) => [asset.asset_id, asset]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const ordered: Asset[] = [];
  const visit = (asset: Asset): void => {
    if (done.has(asset.asset_id) || visiting.has(asset.asset_id)) return;
    visiting.add(asset.asset_id);
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

export interface EmptyTrashResult {
  purged: number;
  kept: number;
  queued: number;
}

export interface EmptyTrashCallbacks {
  refresh: () => Promise<void>;
  setBusy?: (on: boolean) => void;
}

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
  if (lastBad) narrate(lastBad);
  return result;
}

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
