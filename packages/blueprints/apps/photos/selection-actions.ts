import { runSelectionBatch } from "../_shared/selection-engine.ts";
// Batch commands over the current selection (v4 handoff §6). Called directly
// by SelectionBar.tsx's SelectionBarView — `refresh`, `setBarBusy` and
// `exitSelectMode` are the only app.tsx-owned pieces these need, passed in per
// call the same way assets-actions.ts's helpers are.
//
// NARRATION GOES THROUGH outcomes.ts, NOT the element layer's `statusLine`. The ONE
// status line is the frame's (`frame.setStatus`, via outcomes.ts's `notice`
// sink) — a batch that drew its own banner would be a second status line the
// handoff's §14/§18 both rule out. `narrate()` already forwards a failed
// outcome's message there; the summaries below call `notice()` directly for
// the same reason.
import { assetKey, parseAssetKey, scopeOfKey } from "./asset-key.ts";
import { act, narrate, notice } from "./outcomes.ts";
import type { Album, Asset } from "./types.ts";

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
  progressRef: { readonly current: HTMLElement | null },
  { refresh, setBarBusy, exitSelectMode }: BatchCallbacks
): Promise<void> {
  setBarBusy(true);
  let parked = 0;
  let queued = 0;
  let failed = 0;
  let lastBad: VaultOutcome | undefined = undefined;
  const trashedKeys: string[] = []; // what actually landed in the trash — Undo's manifest
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
    // Albums live in the member's own scope, so only the asset half travels —
    // an audience row can be filed into an own-scope album, the scope half of
    // its key names where the row is SHOWN from, not where the album lives.
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
    else skipped += 1; // usually "already in the album" — a precondition, not an error
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

/**
 * Favorite the selection (§6's first action). Batch semantics set the heart
 * ON rather than toggling — a mixed selection has no single "current" state
 * to flip, and the member picked this row of tiles to say "these are
 * favorites now", not "flip whatever each one happens to be".
 *
 * Deliberately does not exit selection mode: unlike Trash/Restore/Add to
 * album/Copy to ⟨vault⟩, favoriting leaves every tile exactly where it was, so
 * a member very often follows it with a second action on the same selection.
 */
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

/**
 * Download the selection (§6's fourth action) — a client-side save, never a
 * vault write, so there is no `act()` call and no Undo. An asset with nothing
 * paintable on this device (§14's `gateway` state) is skipped and counted
 * rather than downloading a broken reference; "Load the original" (§7.1) is
 * the explicit-fetch path for that case, not this one.
 */
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

// `runBatchCopyToVault` (the old `copy-into-scope` command path) is gone
// (#726 P6) — it was never backed on the gateway (no such action was ever
// registered; every call silently narrated "not recognised"). The selection
// bar's Share control now opens `_shared/ShareSheet.tsx`, which gives through
// the SAME landed `/edges` door Lightbox's single-asset share already used
// successfully (`window.centraid.place`) — a real fix, not a relabeling.
