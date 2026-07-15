// The album picker's "Add" submit — mutates the progress button directly
// (the same `btn.textContent = …` progress-mutation pattern as upload.js and
// selection-actions.js) and hands `refresh`/`closePicker` back to app.jsx.
import { toast } from './kit.js';
import { act } from './outcomes.js';

export async function submitPicker(e, album, ids, { refresh, closePicker }) {
  const btn = e.currentTarget;
  btn.disabled = true;
  let ok = 0;
  let parked = 0;
  let queued = 0;
  let skipped = 0;
  for (let i = 0; i < ids.length; i += 1) {
    btn.textContent = `Adding ${i + 1} of ${ids.length}…`;
    const outcome = await act('add-to-album', { album_id: album.album_id, asset_id: ids[i] });
    if (outcome?.status === 'executed') ok += 1;
    else if (outcome?.status === 'parked') parked += 1;
    else if (outcome?.status === 'queued' || outcome?.status === 'in-flight') queued += 1;
    else skipped += 1;
  }
  closePicker();
  await refresh();
  const parts = [];
  if (ok > 0) parts.push(`Added ${ok} to “${album.title ?? 'Album'}”`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (queued > 0) parts.push(`${queued} saved offline`);
  if (skipped > 0) parts.push(`${skipped} already there`);
  toast(parts.join(' · ') || 'Nothing to add');
}
