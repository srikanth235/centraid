// Batch commands over the current selection (delete/restore/add-to-album).
// Called directly by SelectionBar.jsx's SelectionBarView — `refresh`,
// `setBarBusy` and `exitSelectMode` are the only app.jsx-owned pieces these
// need, passed in per call the same way assets-actions.js's helpers are.
import { toast } from './kit.js';
import { act, narrate } from './outcomes.js';

export async function runBatchDelete(ids, progressEl, { refresh, setBarBusy, exitSelectMode }) {
  setBarBusy(true);
  let parked = 0;
  let failed = 0;
  let lastBad = null;
  const trashedIds = []; // what actually landed in the trash — Undo's manifest
  for (let i = 0; i < ids.length; i += 1) {
    progressEl.textContent = `Deleting ${i + 1} of ${ids.length}…`;
    const outcome = await act('delete-asset', { asset_id: ids[i] });
    if (outcome?.status === 'executed') trashedIds.push(ids[i]);
    else if (outcome?.status === 'parked') parked += 1;
    else {
      failed += 1;
      lastBad = outcome;
    }
  }
  setBarBusy(false);
  exitSelectMode();
  await refresh();
  const ok = trashedIds.length;
  const parts = [];
  if (ok > 0) parts.push(`Moved ${ok} ${ok === 1 ? 'item' : 'items'} to trash`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (failed > 0) parts.push(`${failed} failed`);
  const summary = parts.join(' · ') || 'Nothing to do';
  if (ok > 0) {
    toast(summary, { undoLabel: 'Undo', onUndo: () => runBatchRestore(trashedIds, { refresh }) });
  } else {
    toast(summary);
  }
  if (lastBad) narrate(lastBad);
}

export async function runBatchRestore(ids, { refresh }) {
  let ok = 0;
  let bad = 0;
  let lastBad = null;
  for (const id of ids) {
    const outcome = await act('restore', { asset_id: id });
    if (outcome?.status === 'executed') ok += 1;
    else {
      bad += 1;
      lastBad = outcome;
    }
  }
  await refresh();
  const parts = [];
  if (ok > 0) parts.push(`Restored ${ok} ${ok === 1 ? 'item' : 'items'}`);
  if (bad > 0) parts.push(`${bad} not restored`);
  toast(parts.join(' · ') || 'Nothing to restore');
  if (lastBad) narrate(lastBad);
}

export async function runBatchAddToAlbum(
  ids,
  album,
  progressEl,
  { refresh, setBarBusy, exitSelectMode },
) {
  setBarBusy(true);
  let ok = 0;
  let parked = 0;
  let skipped = 0;
  for (let i = 0; i < ids.length; i += 1) {
    progressEl.textContent = `Adding ${i + 1} of ${ids.length}…`;
    const outcome = await act('add-to-album', { album_id: album.album_id, asset_id: ids[i] });
    if (outcome?.status === 'executed') ok += 1;
    else if (outcome?.status === 'parked') parked += 1;
    else skipped += 1; // usually "already in the album" — a precondition, not an error
  }
  setBarBusy(false);
  exitSelectMode();
  await refresh();
  const parts = [];
  if (ok > 0) parts.push(`Added ${ok} to “${album.title ?? 'Album'}”`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (skipped > 0) parts.push(`${skipped} already there`);
  toast(parts.join(' · ') || 'Nothing to add');
}
