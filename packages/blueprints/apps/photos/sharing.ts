// *Copy to Sharing*, as one command (v4 handoff §H, CHANGELOG H).
//
// SHARING IS A PLACE A PHOTOGRAPH IS IN, NOT A PERMISSION ATTACHED TO IT. A
// photograph is shared because it sits somewhere shared, and it stops being
// shared the moment it leaves. Nothing carries an ACL of its own, so there is
// no per-photograph permission to audit and nothing to forget to revoke —
// which is why this module fires the shell's own PLACEMENT call
// (`centraid.place`, kind `add`) rather than minting a second asset. A copy
// would give the member two records to keep in step; a placement gives them
// one photograph that is now in two places.
//
// THE DESTINATION IS A POINTER, NOT A PROPERTY. No vault is "the sharing
// vault" — a member may want to share into several — so the destination is
// the member's own pointer (`shareTargetId()`), resolved against the mounted
// scopes. A pointer that names nothing this device can reach does NOT become
// a silent no-op: the action stands disabled with the reason inline.
import type { InlineScope } from "../inline-types.ts";
import { shareDestination } from "./filters.ts";
import { notice } from "./outcomes.ts";
import { mountedScopes, shareTargetId } from "./scopes.ts";
import type { Asset } from "./types.ts";

/**
 * Why there is nowhere to share to right now, or null when the member's
 * pointer resolves to a place this device has mounted.
 *
 * Two different truths, and the member can act on the difference: nothing has
 * ever been chosen, versus the chosen place is not open here. Lifted out of
 * `sharingBlockedReason` because the Sharing shelf asks the same question with
 * no asset in hand (components/Sharing.tsx), and two spellings of one refusal
 * is how a control and a screen start disagreeing about why.
 */
export function shareDestinationReason(
  scopes: readonly InlineScope[],
  targetId: string | undefined
): string | null {
  if (shareDestination(scopes, targetId)) return null;
  return targetId === undefined
    ? "There is nowhere to share to on this device yet."
    : "Where your shares go isn't open on this device.";
}

/** Why *Copy to Sharing* cannot fire right now, or null when it can. Each
 *  branch is a SENTENCE the disabled control carries, never a shrug. */
export function sharingBlockedReason(
  asset: Asset,
  scopes = mountedScopes(),
  targetId = shareTargetId()
): string | null {
  const target = shareDestination(scopes, targetId);
  if (!target) return shareDestinationReason(scopes, targetId);
  if (typeof window.centraid.place !== "function") {
    return `Copying into ${target.label} is not available on this device yet.`;
  }
  if ((asset.scope_id ?? "") === target.id) {
    return `Already in ${target.label}.`;
  }
  if (!target.canWrite) return `${target.label} is read-only for you.`;
  return null;
}

/**
 * Put `asset` into Sharing. Announces its outcome on the frame's ONE status
 * line, with Undo where undo is possible — a placement is reversible by
 * removing it again, so it always is.
 */
export async function copyToSharing(
  asset: Asset,
  refresh: () => Promise<void>,
  scopes = mountedScopes(),
  targetId = shareTargetId()
): Promise<void> {
  const blocked = sharingBlockedReason(asset, scopes, targetId);
  if (blocked) {
    notice(blocked);
    return;
  }
  const target = shareDestination(scopes, targetId)!;
  const source = asset.scope_id ?? scopes[0]?.id ?? "";
  try {
    const result = await window.centraid.place!({
      linkToken: crypto.randomUUID(),
      kind: "add",
      itemType: "media.media_asset",
      itemId: asset.asset_id,
      sourceVaultId: source,
      targetVaultId: target.id,
    });
    if (result.status !== "executed") {
      notice(result.reason ?? `Not copied into ${target.label}.`);
      return;
    }
    await refresh();
    notice(
      `Copied into ${target.label} — it is shared because it sits there, and stops being shared the moment it leaves.`
    );
  } catch (error) {
    notice(
      error instanceof Error
        ? error.message
        : `Not copied into ${target.label}.`
    );
  }
}
