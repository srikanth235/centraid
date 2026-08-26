// Picker Add commit (v4 handoff §3, §14): progress NEVER lands on the
// control — determinate counts ride the frame's one status line, and Undo
// removes exactly the ids that landed.
import { act, notice, writeTarget } from "./outcomes.ts";
import type { Album } from "./types.ts";

/** What one pass over the picked ids did. */
interface AddTally {
  /** What Undo takes back. */
  added: string[];
  parked: number;
  queued: number;
  skipped: number;
}

async function addEach(
  ids: readonly string[],
  album: Album,
  scope: string | null,
  tally: AddTally,
  i = 0
): Promise<AddTally> {
  const assetId = ids[i];
  if (assetId === undefined) return tally;
  notice(`Adding ${i + 1} of ${ids.length}…`);
  const outcome = await act(
    "add-to-album",
    { album_id: album.album_id, asset_id: assetId },
    scope
  );
  if (outcome?.status === "executed") tally.added.push(assetId);
  else if (outcome?.status === "parked") tally.parked += 1;
  else if (outcome?.status === "queued" || outcome?.status === "in-flight")
    tally.queued += 1;
  else tally.skipped += 1;
  return addEach(ids, album, scope, tally, i + 1);
}

async function removeEach(
  ids: readonly string[],
  album: Album,
  scope: string | null,
  i = 0
): Promise<void> {
  const assetId = ids[i];
  if (assetId === undefined) return;
  await act(
    "remove-from-album",
    { album_id: album.album_id, asset_id: assetId },
    scope
  );
  return removeEach(ids, album, scope, i + 1);
}

function addOutcomeText(tally: AddTally, title: string): string {
  const parts: string[] = [];
  if (tally.added.length > 0)
    parts.push(`Added ${tally.added.length} to “${title}”`);
  if (tally.parked > 0) parts.push(`${tally.parked} awaiting approval`);
  if (tally.queued > 0) parts.push(`${tally.queued} saved offline`);
  if (tally.skipped > 0) parts.push(`${tally.skipped} already there`);
  return parts.join(" · ") || "Nothing to add";
}

export async function submitPicker(
  album: Album,
  ids: string[],
  {
    refresh,
    closePicker,
  }: { refresh: () => Promise<void>; closePicker: () => void }
): Promise<void> {
  // Albums live in the member's own scope (#599); a disabled target says why.
  const target = writeTarget("own");
  if (target.disabled) {
    notice(target.reason);
    return;
  }
  const scope = target.scopeId;
  const title = album.title ?? "Album";
  const tally = await addEach(ids, album, scope, {
    added: [],
    parked: 0,
    queued: 0,
    skipped: 0,
  });
  closePicker();
  await refresh();
  const undone = [...tally.added];
  notice(
    addOutcomeText(tally, title),
    undone.length > 0
      ? () => {
          void (async () => {
            await removeEach(undone, album, scope);
            await refresh();
            notice(`Removed ${undone.length} from “${title}”`);
          })();
        }
      : undefined
  );
}
