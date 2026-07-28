// Batch commands over the current selection (delete/restore/add-to-album).
// Called directly by SelectionBar.tsx's SelectionBarView — `refresh`,
// `setBarBusy` and `exitSelectMode` are the only app.tsx-owned pieces these
// need, passed in per call the same way assets-actions.ts's helpers are.
import { parseAssetKey, scopeOfKey } from "./asset-key.ts";
import { toast } from "./kit.ts";
import { act, narrate, writeTarget } from "./outcomes.ts";
import type { Album } from "./types.ts";

// A selection spans scopes (issue #599): the merged timeline lets a member
// tick their own photo and a Family one in the same batch. Every id below is
// therefore a COMPOSITE key (asset-key.ts) — `(scope_id, asset_id)` — and each
// command is addressed at the scope carried IN the key it acts on. That is the
// whole point: asset ids are minted per vault and collide across them, so
// resolving a bare id back to a scope by lookup could send a delete to the
// wrong row. A key cannot be ambiguous, so it is what the batch carries.
// Adding to an album is the exception: albums are own-scope (see
// albums-actions.ts), so that batch takes one scope for the whole run.
interface BatchCallbacks {
  refresh: () => Promise<void>;
  setBarBusy: (on: boolean) => void;
  exitSelectMode: () => void;
}

export async function runBatchDelete(
  keys: string[],
  progressEl: HTMLElement | null,
  { refresh, setBarBusy, exitSelectMode }: BatchCallbacks
): Promise<void> {
  setBarBusy(true);
  let parked = 0;
  let queued = 0;
  let failed = 0;
  let lastBad: VaultOutcome | undefined = undefined;
  const trashedKeys: string[] = []; // what actually landed in the trash — Undo's manifest
  // Each action updates the captured Undo manifest, so preserve selection order.
  const deleteNext = async (i: number): Promise<void> => {
    if (i >= keys.length) return;
    progressEl!.textContent = `Deleting ${i + 1} of ${keys.length}…`;
    const key = keys[i]!;
    const { assetId } = parseAssetKey(key);
    const outcome = await act(
      "delete-asset",
      { asset_id: assetId },
      scopeOfKey(key)
    );
    if (outcome?.status === "executed") trashedKeys.push(key);
    else if (outcome?.status === "parked") parked += 1;
    else if (outcome?.status === "queued" || outcome?.status === "in-flight")
      queued += 1;
    else {
      failed += 1;
      lastBad = outcome;
    }
    return deleteNext(i + 1);
  };
  await deleteNext(0);
  setBarBusy(false);
  exitSelectMode();
  await refresh();
  const ok = trashedKeys.length;
  const parts: string[] = [];
  if (ok > 0) parts.push(`Moved ${ok} ${ok === 1 ? "item" : "items"} to trash`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (queued > 0) parts.push(`${queued} saved offline`);
  if (failed > 0) parts.push(`${failed} failed`);
  const summary = parts.join(" · ") || "Nothing to do";
  if (ok > 0) {
    toast(summary, {
      undoLabel: "Undo",
      onUndo: () => runBatchRestore(trashedKeys, { refresh }),
    });
  } else {
    toast(summary);
  }
  if (lastBad) narrate(lastBad);
}

export async function runBatchRestore(
  keys: string[],
  { refresh }: Pick<BatchCallbacks, "refresh">
): Promise<void> {
  let ok = 0;
  let bad = 0;
  let queued = 0;
  let lastBad: VaultOutcome | undefined = undefined;
  // Restore is deliberately serial so its final narration names the last
  // selection failure, as the corresponding delete batch does.
  const restoreNext = async (index: number): Promise<void> => {
    const key = keys[index];
    if (!key) return;
    const { assetId } = parseAssetKey(key);
    const outcome = await act(
      "restore",
      { asset_id: assetId },
      scopeOfKey(key)
    );
    if (outcome?.status === "executed") ok += 1;
    else if (outcome?.status === "queued" || outcome?.status === "in-flight")
      queued += 1;
    else {
      bad += 1;
      lastBad = outcome;
    }
    return restoreNext(index + 1);
  };
  await restoreNext(0);
  await refresh();
  const parts: string[] = [];
  if (ok > 0) parts.push(`Restored ${ok} ${ok === 1 ? "item" : "items"}`);
  if (queued > 0) parts.push(`${queued} saved offline`);
  if (bad > 0) parts.push(`${bad} not restored`);
  toast(parts.join(" · ") || "Nothing to restore");
  if (lastBad) narrate(lastBad);
}

export async function runBatchAddToAlbum(
  keys: string[],
  album: Album,
  progressEl: HTMLElement | null,
  { refresh, setBarBusy, exitSelectMode }: BatchCallbacks
): Promise<void> {
  setBarBusy(true);
  const target = writeTarget("own");
  const albumScope = target.disabled ? null : target.scopeId;
  let ok = 0;
  let parked = 0;
  let queued = 0;
  let skipped = 0;
  // Keep progress and command dispatch in selection order; the UI contract is
  // one visible operation at a time even when the gateway is available.
  const addNext = async (i: number): Promise<void> => {
    if (i >= keys.length) return;
    progressEl!.textContent = `Adding ${i + 1} of ${keys.length}…`;
    // Albums live in the member's own scope, so only the asset half travels —
    // an audience row can be filed into an own-scope album, the scope half of
    // its key names where the row is SHOWN from, not where the album lives.
    const outcome = await act(
      "add-to-album",
      { album_id: album.album_id, asset_id: parseAssetKey(keys[i]!).assetId },
      albumScope
    );
    if (outcome?.status === "executed") ok += 1;
    else if (outcome?.status === "parked") parked += 1;
    else if (outcome?.status === "queued" || outcome?.status === "in-flight")
      queued += 1;
    else skipped += 1; // usually "already in the album" — a precondition, not an error
    return addNext(i + 1);
  };
  await addNext(0);
  setBarBusy(false);
  exitSelectMode();
  await refresh();
  const parts: string[] = [];
  if (ok > 0) parts.push(`Added ${ok} to “${album.title ?? "Album"}”`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (queued > 0) parts.push(`${queued} saved offline`);
  if (skipped > 0) parts.push(`${skipped} already there`);
  toast(parts.join(" · ") || "Nothing to add");
}
