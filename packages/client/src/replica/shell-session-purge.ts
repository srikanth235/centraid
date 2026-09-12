// A SCOPE'S STORAGE, DELETED, DURABLY (#599, #922 C6).
//
// Unpair, revoke, remove a gateway, switch vaults: the copy has to go, and the
// deletion has to survive the process that started it. The order is the whole
// of the argument:
//
//   MARK TERMINAL FIRST. A crash between "decided to delete" and "deleted"
//   must not leave a member's vault on a device they revoked — so the intent to
//   purge is written durably BEFORE anything is removed, and
//   `TerminalReplicaPurgeRetryLoop` finishes whatever did not.
//
//   THEN DELETE THE FILE, WHICH IS THE WHOLE OF IT. It used to be two stores —
//   an OPFS database and an IndexedDB outbox beside it — deleted separately,
//   each able to fail on its own. Since #996 the outbox is a table in the
//   seat's file, so one unlink takes both and there is no half-purged state to
//   describe.
//
//   ONLY THEN UNREGISTER. The inventory row is the proof the purge is owed; it
//   is dropped last, so a failure anywhere above leaves the debt recorded.
//
// AND BEFORE ANY OF THAT, QUIESCE AND EXPORT (#1014, C25/P24; R-1014-12).
// This used to purge the queue and then the seat with no quiesce at all: an
// in-flight drain went on writing into a store whose file was being unlinked,
// and the member's unsent intents went with it while they were told only that
// the vault had been removed. So the drain is stopped first, whatever is
// unsent is written beside the file as JSON, and the COUNT comes back to the
// caller — which is what turns "removed" into "removed, and N unsent changes
// were saved here".

import { ReplicaProtocolError } from "./errors.js";
import type { IntentQueue } from "./intents.js";
import { opfsRevokedOutboxSink } from "./opfs-revoked-outbox.js";
import { saveUnsentBeforePurge } from "./revoked-outbox.js";
import type { RevokedOutboxSink } from "./revoked-outbox.js";
import type { SessionSeat } from "./seat/session-seat.js";
import {
  deferTerminalReplicaPurge,
  markReplicaIdentityTerminal,
  unregisterRememberedReplicaIdentity,
} from "./storage-manifest.js";
import type { ReplicaIdentityInventory } from "./storage-manifest.js";
import { terminalPurgeRetryLoop } from "./terminal-purge.js";
import type { ReplicaIdentity } from "./types.js";

export interface ShellScopePurge {
  readonly identity: ReplicaIdentity;
  readonly seat: SessionSeat;
  readonly queue: IntentQueue | undefined;
  /**
   * Stop the drain and wait for what is in flight. Absent in a caller that has
   * no drain to stop (a suite, a scope that never opened one).
   */
  readonly quiesce?: () => Promise<void>;
  /**
   * Where the unsent export goes. Defaults to OPFS; a browser without it gets
   * no sink, and the policy then reports the count with `saved: false`.
   */
  readonly sink?: RevokedOutboxSink | undefined;
  /** False for a scope that never asked to be remembered: nothing is tracked. */
  readonly remembered: boolean;
  readonly indexedDbFactory?: IDBFactory | undefined;
  readonly inventory?: ReplicaIdentityInventory | undefined;
}

export interface ShellScopePurgeResult {
  /** Unsent intents this purge took from the member. Zero is the good case. */
  readonly unsent: number;
  /** False when the count is all the caller can honestly report. */
  readonly saved: boolean;
}

export async function purgeShellScope(
  scope: ShellScopePurge
): Promise<ShellScopePurgeResult> {
  // QUIESCE FIRST. A drain mid-send against a file that is about to be
  // unlinked writes its transport failure into a store that will not exist.
  await scope.quiesce?.().catch(() => undefined);
  const exported = await saveUnsentBeforePurge({
    vaultId: scope.identity.vaultId,
    intents: (await scope.queue?.list().catch(() => [])) ?? [],
    sink: scope.sink ?? opfsRevokedOutboxSink(),
  });
  const inventoryOptions = {
    ...(scope.indexedDbFactory
      ? { indexedDbFactory: scope.indexedDbFactory }
      : {}),
    ...(scope.inventory ? { inventory: scope.inventory } : {}),
  };
  let terminalTracked = false;
  if (scope.remembered) {
    terminalTracked = await markReplicaIdentityTerminal(
      scope.identity,
      inventoryOptions
    );
    if (!terminalTracked) {
      throw new ReplicaProtocolError(
        "Could not durably schedule remembered replica purge"
      );
    }
  }
  try {
    await scope.queue?.purge();
    await scope.seat.purge();
    if (scope.remembered)
      await unregisterRememberedReplicaIdentity(
        scope.identity,
        inventoryOptions
      );
    return { unsent: exported.count, saved: exported.saved };
  } catch (error) {
    if (terminalTracked) {
      await deferTerminalReplicaPurge(scope.identity, inventoryOptions).catch(
        () => undefined
      );
    }
    terminalPurgeRetryLoop.wake();
    throw error;
  }
}
