import { AsyncLocalStorage } from "node:async_hooks";
import type * as TypeImport_rdfcd1 from "node:http";

export interface VaultRequestContext {
  vaultId: string;
  deviceKey?: string;
  ownerId?: string;
  ownsVault?: boolean;
  grantProfile?: readonly string[];
}

export interface DeviceAccess {
  deviceKeyFor: (req: TypeImport_rdfcd1.IncomingMessage) => string | undefined;
  vaultsFor: (deviceKey: string) => string[];
}

const storage = new AsyncLocalStorage<VaultRequestContext>();

export function runWithVaultContext<T>(
  ctx: VaultRequestContext,
  fn: () => T
): T {
  return storage.run(ctx, fn);
}

export function vaultContext(): VaultRequestContext | undefined {
  return storage.getStore();
}

export const VAULT_HEADER = "x-centraid-vault";
