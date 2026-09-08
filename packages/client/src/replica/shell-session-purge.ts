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

import { ReplicaProtocolError } from "./errors.js";
import type { IntentQueue } from "./intents.js";
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
  /** False for a scope that never asked to be remembered: nothing is tracked. */
  readonly remembered: boolean;
  readonly indexedDbFactory?: IDBFactory | undefined;
  readonly inventory?: ReplicaIdentityInventory | undefined;
}

export async function purgeShellScope(scope: ShellScopePurge): Promise<void> {
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
