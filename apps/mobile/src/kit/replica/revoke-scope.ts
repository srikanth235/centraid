// WHAT "THIS VAULT WAS REMOVED FROM YOUR PHONE" ACTUALLY DOES.
//
// Split out of `ReplicaProvider.tsx` (#1014): the provider's job is to mount
// one vault and publish what it finds, and revocation is a different concern
// with its own ORDER — announce, purge, reclaim, forget — every step of which
// is load-bearing and none of which is about mounting.
//
// THE ORDER IS THE CONTRACT:
//
//   1. ANNOUNCE FIRST. The label is about to be erased along with the rows,
//      and a member told nothing is a vault that vanished silently.
//   2. PURGE THE OPEN ONE THROUGH ITS SESSION. `session.purge()` closes the
//      handle before it unlinks, because a file cannot be replaced under an
//      open SQLite connection.
//   3. RECLAIM A CLOSED ONE BY FILE. A vault this seat is not holding open has
//      no handle at all, so its file family is simply deleted — which is the
//      whole reason one open file is simpler than four.
//   4. FORGET, ALWAYS. The `finally` runs even when the purge threw: a scope
//      left in the cached list is one the next mount tries to open again.

import { saveUnsentBeforePurge } from "@centraid/client/replica/native";
import type { ReplicaIntent } from "@centraid/client/replica/native";

import { nativeRevokedOutboxSink } from "../../lib/replica/revoked-outbox-file";
import { clearPinnedThumbnailPack } from "../../lib/replica/thumbnail-pack";
import type { ReplicaVaultScope } from "../../lib/replica/vault-source";
import type { PublishReplicaValue } from "./replica-context";
import {
  deleteReplicaDatabaseFamily,
  removeCachedScope,
} from "./replica-mount";

export interface RevokedScopeHost {
  readonly gatewayId: string;
  /** The one vault this mount holds open; only it has a session to purge. */
  readonly openVaultId: string;
  readonly scopes: readonly ReplicaVaultScope[];
  /**
   * The mount's session, when the revoked vault is the open one. Quiesced and
   * read BEFORE it is purged (#1014, C25/P24; R-1014-12).
   */
  readonly session: () =>
    | {
        quiesce: () => Promise<void>;
        listIntents: () => Promise<ReplicaIntent[]>;
        purge: () => Promise<void>;
      }
    | undefined;
  /** Told what the purge took, so the member gets a sentence about it. */
  readonly noteUnsent?: (
    scope: ReplicaVaultScope,
    taken: { unsent: number; saved: boolean }
  ) => void;
  readonly note: (scope: ReplicaVaultScope) => void;
  readonly forgetBootstrap: (vaultId: string) => void;
  readonly forgetFreshness: (vaultId: string) => void;
  readonly bootstrapProgress: () => unknown;
  readonly publish: PublishReplicaValue;
}

/** Delete a closed vault's file family. The open one goes through its purge. */
export function reclaimRevokedReplica(scope: ReplicaVaultScope): void {
  deleteReplicaDatabaseFamily(scope.databaseName);
}

/**
 * The mount's ONE entry point for every way a revocation reaches it (#1014,
 * X7/X8): the feed's revoked frame, the seat door's refusal, and the intent
 * drain's. Two of the three used to do something else — the phone re-fetched
 * the vault from the gateway that had just revoked it.
 */
export function revokedScopeReclaimer(
  host: RevokedScopeHost
): (vaultId: string) => Promise<void> {
  return (vaultId) => reclaimRevokedScope(host, vaultId).catch(() => undefined);
}

/** Everything a revocation does to this phone, in the order above. */
export async function reclaimRevokedScope(
  host: RevokedScopeHost,
  vaultId: string
): Promise<void> {
  const scope = host.scopes.find((candidate) => candidate.vaultId === vaultId);
  try {
    if (scope) host.note(scope);
    const session = vaultId === host.openVaultId ? host.session() : undefined;
    if (session) {
      // QUIESCE, EXPORT, THEN PURGE (#1014, C25/P24; R-1014-12). Revocation is
      // about the device's future access, not about the member's past writes:
      // what they authored and were told was saved is written beside the file
      // before the file goes, and the COUNT is the sentence they are owed.
      await session.quiesce();
      const taken = await saveUnsentBeforePurge({
        vaultId,
        intents: await session.listIntents().catch(() => []),
        sink: nativeRevokedOutboxSink(),
      });
      await session.purge();
      if (scope && taken.count > 0)
        host.noteUnsent?.(scope, { unsent: taken.count, saved: taken.saved });
    }
    if (scope) reclaimRevokedReplica(scope);
  } finally {
    host.forgetBootstrap(vaultId);
    clearPinnedThumbnailPack(vaultId);
    host.forgetFreshness(vaultId);
    await removeCachedScope(host.gatewayId, vaultId).catch(() => undefined);
    host.publish((value) => ({
      ...value,
      scopes: (value.scopes ?? []).filter((each) => each.vaultId !== vaultId),
      bootstrapProgress: host.bootstrapProgress() as never,
    }));
  }
}
