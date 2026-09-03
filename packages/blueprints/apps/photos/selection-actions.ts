import { runSelectionBatch } from "../_shared/selection-engine.ts";
import { assetKey, parseAssetKey, scopeOfKey } from "./asset-key.ts";
import { act, narrate, notice } from "./outcomes.ts";
import type { Album, Asset } from "./types.ts";

interface BatchCallbacks {
  refresh: () => Promise<void>;
  setBarBusy: (on: boolean) => void;
  exitSelectMode: () => void;
}

export async function runBatchDelete(
  keys: string[],
  progressRef: { readonly current: HTMLElement | null },
  { refresh, setBarBusy, exitSelectMode }: BatchCallbacks
): Promise<void> {
  setBarBusy(true);
  let parked = 0;
  let queued = 0;
  let failed = 0;
  let lastBad: VaultOutcome | undefined = undefined;
  const trashedKeys: string[] = []; // landed in trash — Undo's manifest
  const results = await runSelectionBatch(keys, async (key, i) => {
    if (progressRef.current)
      progressRef.current.textContent = `Deleting ${i + 1} of ${keys.length}…`;
    const { assetId } = parseAssetKey(key);
    const outcome = await act(
      "delete-asset",
      { asset_id: assetId },
      scopeOfKey(key)
    );
    return { key, outcome };
  });
  for (const result of results) {
    if (result.status === "rejected") {
      failed += 1;
      continue;
    }
    const { key, outcome } = result.value;
    if (outcome?.status === "executed") trashedKeys.push(key);
    else if (outcome?.status === "parked") parked += 1;
    else if (outcome?.status === "queued" || outcome?.status === "in-flight")
      queued += 1;
    else {
      failed += 1;
      lastBad = outcome;
    }
  }
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
    notice(summary, () => runBatchRestore(trashedKeys, { refresh }));
  } else {
    notice(summary);
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
  const results = await runSelectionBatch(keys, async (key) => {
    const { assetId } = parseAssetKey(key);
    return act("restore", { asset_id: assetId }, scopeOfKey(key));
  });
  for (const result of results) {
    if (result.status === "rejected") {
      bad += 1;
      continue;
    }
    const outcome = result.value;
    if (outcome?.status === "executed") ok += 1;
    else if (outcome?.status === "queued" || outcome?.status === "in-flight")
      queued += 1;
    else {
      bad += 1;
      lastBad = outcome;
    }
  }
  await refresh();
  const parts: string[] = [];
  if (ok > 0) parts.push(`Restored ${ok} ${ok === 1 ? "item" : "items"}`);
  if (queued > 0) parts.push(`${queued} saved offline`);
  if (bad > 0) parts.push(`${bad} not restored`);
  notice(parts.join(" · ") || "Nothing to restore");
  if (lastBad) narrate(lastBad);
}

export async function runBatchAddToAlbum(
  keys: string[],
  album: Album,
  albumScope: string | null,
  progressRef: { readonly current: HTMLElement | null },
  { refresh, setBarBusy, exitSelectMode }: BatchCallbacks
): Promise<void> {
  setBarBusy(true);
  let ok = 0;
  let parked = 0;
  let queued = 0;
  let skipped = 0;
  const results = await runSelectionBatch(keys, async (key, i) => {
    if (progressRef.current)
      progressRef.current.textContent = `Adding ${i + 1} of ${keys.length}…`;
    return act(
      "add-to-album",
      { album_id: album.album_id, asset_id: parseAssetKey(key).assetId },
      albumScope
    );
  });
  for (const result of results) {
    if (result.status === "rejected") {
      skipped += 1;
      continue;
    }
    const outcome = result.value;
    if (outcome?.status === "executed") ok += 1;
    else if (outcome?.status === "parked") parked += 1;
    else if (outcome?.status === "queued" || outcome?.status === "in-flight")
      queued += 1;
    else skipped += 1; // usually already in the album — a precondition, not an error
  }
  setBarBusy(false);
  exitSelectMode();
  await refresh();
  const parts: string[] = [];
  if (ok > 0) parts.push(`Added ${ok} to “${album.title ?? "Album"}”`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (queued > 0) parts.push(`${queued} saved offline`);
  if (skipped > 0) parts.push(`${skipped} already there`);
  notice(parts.join(" · ") || "Nothing to add");
}

export async function runBatchFavorite(
  keys: string[],
  progressRef: { readonly current: HTMLElement | null },
  { refresh, setBarBusy }: Pick<BatchCallbacks, "refresh" | "setBarBusy">
): Promise<void> {
  setBarBusy(true);
  let ok = 0;
  let failed = 0;
  let lastBad: VaultOutcome | undefined = undefined;
  const results = await runSelectionBatch(keys, async (key, i) => {
    if (progressRef.current)
      progressRef.current.textContent = `Favoriting ${i + 1} of ${keys.length}…`;
    const { assetId } = parseAssetKey(key);
    return act(
      "update-asset",
      { asset_id: assetId, favorite: 1 },
      scopeOfKey(key)
    );
  });
  for (const result of results) {
    if (result.status === "rejected") {
      failed += 1;
      continue;
    }
    const outcome = result.value;
    if (outcome?.status === "executed") ok += 1;
    else {
      failed += 1;
      lastBad = outcome;
    }
  }
  setBarBusy(false);
  await refresh();
  const parts: string[] = [];
  if (ok > 0)
    parts.push(`Favorited ${ok} ${ok === 1 ? "photograph" : "photographs"}`);
  if (failed > 0) parts.push(`${failed} failed`);
  notice(parts.join(" · ") || "Nothing to favorite");
  if (lastBad) narrate(lastBad);
}

export async function runBatchDownload(
  keys: string[],
  visible: readonly Asset[],
  progressRef: { readonly current: HTMLElement | null },
  { setBarBusy }: Pick<BatchCallbacks, "setBarBusy">
): Promise<void> {
  setBarBusy(true);
  let ok = 0;
  let skipped = 0;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    if (progressRef.current)
      progressRef.current.textContent = `Downloading ${i + 1} of ${keys.length}…`;
    const asset = visible.find((a) => assetKey(a) === key);
    const uri = asset?.content_uri;
    if (typeof uri !== "string" || uri === "") {
      skipped += 1;
      continue;
    }
    const link = document.createElement("a");
    link.href = uri;
    link.download =
      typeof asset?.title === "string" && asset.title !== ""
        ? asset.title
        : (asset?.asset_id ?? "photo");
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    ok += 1;
  }
  setBarBusy(false);
  const parts: string[] = [];
  if (ok > 0) parts.push(`Downloaded ${ok} ${ok === 1 ? "item" : "items"}`);
  if (skipped > 0) parts.push(`${skipped} not on this device`);
  notice(parts.join(" · ") || "Nothing to download");
}
