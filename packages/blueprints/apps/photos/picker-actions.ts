// The album picker's "Add" submit — mutates the progress button directly
// (the same `btn.textContent = …` progress-mutation pattern as upload.ts and
// selection-actions.ts) and hands `refresh`/`closePicker` back to app.tsx.
import { statusLine } from "./kit.ts";
import { act, writeTarget } from "./outcomes.ts";
import type { Album } from "./types.ts";

export async function submitPicker(
  e: { currentTarget: HTMLButtonElement },
  album: Album,
  ids: string[],
  {
    refresh,
    closePicker,
  }: { refresh: () => Promise<void>; closePicker: () => void }
): Promise<void> {
  const btn = e.currentTarget;
  btn.disabled = true;
  // Album membership lives in the album's own scope, and this app only authors
  // albums in the member's own (issue #599) — so does adding to one.
  const target = writeTarget("own");
  const scope = target.disabled ? null : target.scopeId;
  let ok = 0;
  let parked = 0;
  let queued = 0;
  let skipped = 0;
  const addNext = async (i: number): Promise<void> => {
    if (i >= ids.length) return;
    const assetId = ids[i];
    if (assetId === undefined) return;
    btn.textContent = `Adding ${i + 1} of ${ids.length}…`;
    const outcome = await act(
      "add-to-album",
      { album_id: album.album_id, asset_id: assetId },
      scope
    );
    if (outcome?.status === "executed") ok += 1;
    else if (outcome?.status === "parked") parked += 1;
    else if (outcome?.status === "queued" || outcome?.status === "in-flight")
      queued += 1;
    else skipped += 1;
    return addNext(i + 1);
  };
  await addNext(0);
  closePicker();
  await refresh();
  const parts: string[] = [];
  if (ok > 0) parts.push(`Added ${ok} to “${album.title ?? "Album"}”`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (queued > 0) parts.push(`${queued} saved offline`);
  if (skipped > 0) parts.push(`${skipped} already there`);
  statusLine(parts.join(" · ") || "Nothing to add");
}
