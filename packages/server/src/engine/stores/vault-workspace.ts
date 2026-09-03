import type { DatabaseProvider } from "./gateway-db.js";

export interface VaultWorkspace {
  vaultId: string;
  ownerPartyId: string;
  appsDir: string;
  journal: DatabaseProvider;
  ledgerDbFile: string;
  harnessSessionDir: string;
}

export type WorkspaceProvider = () => VaultWorkspace;
