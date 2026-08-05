// The album picker's "Add" commit (v4 handoff §3, §14).
//
// WHAT RETIRED HERE: the `btn.textContent = "Adding 3 of 12…"` mutation. A
// control is not a progress bar — progress is DETERMINATE, carries exact
// counts, and rides the frame's ONE status line, which is also where the
// outcome lands when the run finishes. The picker panel keeps its geometry
// throughout and simply goes busy, so nothing under the pointer moves.
//
// The commit also earns an UNDO (§3, the status line's one inline text
// action): every id that actually landed is remembered, and undoing removes
// exactly those from the album again. An album refers to a photograph where it
// lives, so both directions are pure membership — nothing moves and nothing is
// copied either way.
import { act, notice, writeTarget } from "./outcomes.ts";
import type { Album } from "./types.ts";

/** What one pass over the picked ids did, in the four terms a write can end in. */
interface AddTally {
  /** The ids that actually landed — what Undo takes back. */
  added: string[];
  parked: number;
  queued: number;
  skipped: number;
}

/** Fire `add-to-album` for each id in order, narrating exact counts as it goes.
 *  Recursive rather than a loop with an `await` in it — the same shape the
 *  upload pipeline uses, and for the same reason: the ordering is the user's
 *  selection order and that contract stays explicit. */
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

/** Take back exactly what landed. Same recursion, same ordering contract. */
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

/** The status line's sentence for one completed pass. */
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
  // Album membership lives in the album's own scope, and this app only authors
  // albums in the member's own (issue #599) — so does adding to one. A target
  // that cannot be written says why instead of firing a refused write.
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
