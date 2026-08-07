// SHARING, AS A MODEL (issue #712, A5; v4 handoff §H, proto:3955-3958).
//
// SHARING IS A PLACE A PHOTOGRAPH IS IN, NOT A PERMISSION ATTACHED TO IT — the
// doctrine `packages/blueprints/apps/photos/sharing.ts` states for web, and the
// reason the shelf below is a FILTER over the one merged timeline rather than a
// second library. A photograph is shared because its row lives in a vault other
// people can reach; it stops being shared the moment it leaves. Nothing carries
// an ACL of its own, so there is no per-photograph permission to audit and
// nothing to forget to revoke.
//
// This module is free of `react-native` and replica imports so the filter, the
// status line and the two refusal sentences can be asserted directly
// (`photos-sharing.test.ts`). `SharingShelf.tsx` renders them.

/** The narrow shape the filter reads — every `PhotoAsset` satisfies it. */
export interface SharedAssetLike {
  deleted: boolean;
  /** Vault whose payload supplied this row's `assetId`. */
  sourceVaultId?: string;
  /** Every vault a sha-deduped timeline item was seen in. */
  scopeIds?: string[];
}

/**
 * The photographs that are IN the sharing place.
 *
 * A merged timeline row can carry several scopes (one sha, seen in two vaults),
 * so membership is "this row is present in the target", not "this row's
 * canonical vault IS the target" — otherwise a photograph the member shared
 * from their own vault would vanish from the shelf that is supposed to prove it
 * is shared. Trashed rows are excluded for the same reason every other shelf
 * excludes them: the trash is its own shelf.
 */
export function sharedAssets<T extends SharedAssetLike>(
  assets: readonly T[],
  targetVaultId: string | undefined
): T[] {
  if (!targetVaultId) return [];
  return assets.filter(
    (asset) =>
      !asset.deleted &&
      (asset.sourceVaultId === targetVaultId ||
        (asset.scopeIds ?? []).includes(targetVaultId))
  );
}

/**
 * The shelf's status line.
 *
 * `audience` is the grant roster (`kit/share/audience.ts`). An EMPTY roster is
 * not "nobody": the read answers `[]` both for a gateway with no device plane
 * and for a transient failure, and it is `[]` before it has answered at all.
 * None of those is evidence about who can see this vault, so the line simply
 * omits the clause. Saying "0 people hold a grant" over an unanswered read
 * would be inventing a roster — and it is the one sentence on this shelf a
 * member might act on by sharing something they should not.
 */
export function sharingStatusLine(count: number, audienceSize: number): string {
  const shelf = `Sharing · ${count}`;
  if (audienceSize <= 0) return shelf;
  return `${shelf} · ${audienceSize} ${
    audienceSize === 1 ? "person holds" : "people hold"
  } a grant`;
}

/**
 * WHY *Remove from Sharing* CANNOT FIRE FROM THE PHONE (A5, stated not hidden).
 *
 * The removal half of the placement spine does not exist anywhere yet. The
 * mobile replica layer's `PlacementIntent.kind` is `"add" | "move"` — there is
 * no remove — and the web's own `runBatchRemoveFromSharing`
 * (`packages/blueprints/apps/photos/selection-actions.ts`) says in its docstring
 * that `remove-from-scope` "is not a registered gateway action yet". So there is
 * no honest write to bind this control to on either client.
 *
 * It renders, disabled, carrying this sentence — the §6 rule for every target a
 * surface cannot serve. A hidden control would let a member believe a
 * photograph in the sharing place can be taken back out from here, which is
 * precisely the belief that matters most on this shelf.
 */
export const NO_REMOVE_FROM_SHARING_REASON =
  "Taking a photograph back out of Sharing is not built yet — on any client. Move it out from your gateway, or trash the copy that sits there.";

/** What the shelf says when the member has nowhere to share to yet. */
export const SHARING_SHELF_EMPTY =
  "Nothing is in Sharing yet. Select photographs anywhere in Photos and choose Copy to Sharing — they are shared because they sit there, and stop being shared the moment they leave.";
