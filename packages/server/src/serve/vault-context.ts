/*
 * Per-request vault context (#289). A client addresses a (gateway, vault) pair;
 * the handler chain runs inside this scope so deep provider callbacks land on
 * the right vault. There is no server-global active vault — background work
 * enters a scope explicitly via `runWithVaultContext`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type * as TypeImport_rdfcd1 from "node:http";

export interface VaultRequestContext {
  vaultId: string;
  /** Absence is never an admin wildcard: the composed handler fails closed (#289). */
  deviceKey?: string;
  /** The acting human for authorization and attribution; the id is the key, never the label. */
  ownerId?: string;
  /** The one write predicate (#726); false for a tombstoned binding. */
  ownsVault?: boolean;
  grantProfile?: readonly string[];
}

/** Absent for hosts whose transport carries no device identity (loopback, tests). */
export interface DeviceAccess {
  /** `undefined` = unproved transport; the composed handler then refuses the request. */
  deviceKeyFor: (req: TypeImport_rdfcd1.IncomingMessage) => string | undefined;
  /** Oldest enrollment first. */
  vaultsFor: (deviceKey: string) => string[];
}

const storage = new AsyncLocalStorage<VaultRequestContext>();

export function runWithVaultContext<T>(
  ctx: VaultRequestContext,
  fn: () => T
): T {
  return storage.run(ctx, fn);
}

/** Undefined outside a scoped request or fire. */
export function vaultContext(): VaultRequestContext | undefined {
  return storage.getStore();
}

export const VAULT_HEADER = "x-centraid-vault";
