// Batch commands over the current selection (delete/restore/add-to-album).
// Called directly by SelectionBar.tsx's SelectionBarView — `refresh`,
// `setBarBusy` and `exitSelectMode` are the only app.tsx-owned pieces these
// need, passed in per call the same way assets-actions.ts's helpers are.
import { toast } from './kit.js';
import { act, narrate } from './outcomes.ts';
import type { Album } from './types.ts';

interface BatchCallbacks {
  refresh: () => Promise<void>;
  setBarBusy: (on: boolean) => void;
  exitSelectMode: () => void;
}

export async function runBatchDelete(
  ids: string[],
  progressEl: HTMLElement | null,
  { refresh, setBarBusy, exitSelectMode }: BatchCallbacks,
): Promise<void> {
  setBarBusy(true);
  let parked = 0;
  let queued = 0;
  let failed = 0;
  let lastBad: VaultOutcome | undefined = undefined;
  const trashedIds: string[] = []; // what actually landed in the trash — Undo's manifest
  for (let i = 0; i < ids.length; i += 1) {
    progressEl!.textContent = `Deleting ${i + 1} of ${ids.length}…`;
    const outcome = await act('delete-asset', { asset_id: ids[i] });
    if (outcome?.status === 'executed') trashedIds.push(ids[i]!);
    else if (outcome?.status === 'parked') parked += 1;
    else if (outcome?.status === 'queued' || outcome?.status === 'in-flight') queued += 1;
    else {
      failed += 1;
      lastBad = outcome;
    }
  }
  setBarBusy(false);
  exitSelectMode();
  await refresh();
  const ok = trashedIds.length;
  const parts: string[] = [];
  if (ok > 0) parts.push(`Moved ${ok} ${ok === 1 ? 'item' : 'items'} to trash`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (queued > 0) parts.push(`${queued} saved offline`);
  if (failed > 0) parts.push(`${failed} failed`);
  const summary = parts.join(' · ') || 'Nothing to do';
  if (ok > 0) {
    toast(summary, { undoLabel: 'Undo', onUndo: () => runBatchRestore(trashedIds, { refresh }) });
  } else {
    toast(summary);
  }
  if (lastBad) narrate(lastBad);
}

export async function runBatchRestore(
  ids: string[],
  { refresh }: { refresh: () => Promise<void> },
): Promise<void> {
  let ok = 0;
  let bad = 0;
  let queued = 0;
  let lastBad: VaultOutcome | undefined = undefined;
  for (const id of ids) {
    const outcome = await act('restore', { asset_id: id });
    if (outcome?.status === 'executed') ok += 1;
    else if (outcome?.status === 'queued' || outcome?.status === 'in-flight') queued += 1;
    else {
      bad += 1;
      lastBad = outcome;
    }
  }
  await refresh();
  const parts: string[] = [];
  if (ok > 0) parts.push(`Restored ${ok} ${ok === 1 ? 'item' : 'items'}`);
  if (queued > 0) parts.push(`${queued} saved offline`);
  if (bad > 0) parts.push(`${bad} not restored`);
  toast(parts.join(' · ') || 'Nothing to restore');
  if (lastBad) narrate(lastBad);
}

export async function runBatchAddToAlbum(
  ids: string[],
  album: Album,
  progressEl: HTMLElement | null,
  { refresh, setBarBusy, exitSelectMode }: BatchCallbacks,
): Promise<void> {
  setBarBusy(true);
  let ok = 0;
  let parked = 0;
  let queued = 0;
  let skipped = 0;
  for (let i = 0; i < ids.length; i += 1) {
    progressEl!.textContent = `Adding ${i + 1} of ${ids.length}…`;
    const outcome = await act('add-to-album', { album_id: album.album_id, asset_id: ids[i] });
    if (outcome?.status === 'executed') ok += 1;
    else if (outcome?.status === 'parked') parked += 1;
    else if (outcome?.status === 'queued' || outcome?.status === 'in-flight') queued += 1;
    else skipped += 1; // usually "already in the album" — a precondition, not an error
  }
  setBarBusy(false);
  exitSelectMode();
  await refresh();
  const parts: string[] = [];
  if (ok > 0) parts.push(`Added ${ok} to “${album.title ?? 'Album'}”`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (queued > 0) parts.push(`${queued} saved offline`);
  if (skipped > 0) parts.push(`${skipped} already there`);
  toast(parts.join(' · ') || 'Nothing to add');
}
