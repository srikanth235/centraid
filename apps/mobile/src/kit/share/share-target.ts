// THE FRAME'S SHARE-TARGET POINTER (issue #712, A1) — mirrors
// `kit/transfer/transfer-policy.ts`'s shape (one record, one owner,
// `Store.hydrate`/`write`) for the reason that module states at its head:
// this is a member-DEVICE setting, not a property of any app.
//
// Web already carries this pointer — `window.centraid.shareTargetVaultId`,
// threaded gateway scopes plane → `useAppScopes.ts` →
// `centraid-inline.ts`'s `InlineCentraidClient.shareTargetVaultId` (issue
// #711 item H). Mobile had NO pointer at all: as
// `apps/mobile/src/apps/photos/photos-vaults.ts` used to say, "where a share
// GOES is not here at all" — the phone asked the member fresh, per item, with
// `AudiencePlacementSheet`. This module is that pointer's mobile home, so a
// future mobile Sharing surface can ask "where do MY shares go by default?"
// the same way the web Sharing shelf already does.
//
// THE DESTINATION IS A POINTER, NOT A PROPERTY — the same doctrine
// `packages/blueprints/apps/photos/sharing.ts` states for web. A member may
// want to share into several vaults, so where their shares land is a choice
// they made, carried beside the mounted scopes, never derived from one.
import { Store } from "../../storage";

/**
 * The persisted key. Namespaced under `frame.` (unlike the transfer policy's
 * grandfathered `photos.` key) because this pointer never had a prior owner
 * to inherit a name from — it is new with issue #712.
 */
export const SHARE_TARGET_KEY = "frame.shareTarget";

/** What the member decided about where their shares go, or nothing yet. */
export interface ShareTarget {
  vaultId: string | null;
}

export const DEFAULT_SHARE_TARGET: ShareTarget = { vaultId: null };

/** Read from durable storage, filling any field a stored record predates. */
export async function hydrateShareTarget(): Promise<ShareTarget> {
  const stored = await Store.hydrate(SHARE_TARGET_KEY, DEFAULT_SHARE_TARGET);
  return { ...DEFAULT_SHARE_TARGET, ...stored };
}

/** Persist the whole record. Callers edit a copy and hand it back entire. */
export function writeShareTarget(next: ShareTarget): void {
  Store.set(SHARE_TARGET_KEY, next);
}

/**
 * A scope this device has mounted, minimally: the shape both the replica
 * provider's `scopes` and a scopes-plane row satisfy. Kept local and tiny
 * rather than importing either concrete type, so this module has no
 * dependency on the replica session or the gateway client.
 */
export interface ShareScope {
  vaultId: string;
}

/**
 * Why there is nowhere to share to right now, or null when the pointer
 * resolves to a vault this device has mounted. Mirrors web's
 * `shareDestinationReason` (`packages/blueprints/apps/photos/sharing.ts`)
 * word for word — two different truths a member can act on: nothing has ever
 * been chosen, versus the chosen place is not open here.
 */
export function shareDestinationReason(
  scopes: readonly ShareScope[],
  targetId: string | undefined
): string | null {
  if (targetId === undefined) {
    return "There is nowhere to share to on this device yet.";
  }
  const reachable = scopes.some((scope) => scope.vaultId === targetId);
  return reachable ? null : "Where your shares go isn't open on this device.";
}
