/*
 * Per-vault world an app-engine runtime operates in (#280). app-engine never opens a vault — stores type against this shape without depending on gateway or vault packages. Consumers re-resolve per call so a vault switch lands without reconstruction.
 */

import type { DatabaseProvider } from "./gateway-db.js";

export interface VaultWorkspace {
  /** Cache key across vault switches (`core_vault.vault_id`). */
  vaultId: string;
  /** Conversations stamp this — the vault owner IS the user; no separate gateway identity (#280). */
  ownerPartyId: string;
  appsDir: string;
  /** Same file as the vault's audit stream; the ledger band is ensured before the handle is handed out. */
  journal: DatabaseProvider;
  ledgerDbFile: string;
  /** Derived cache OUTSIDE the vault dir — `vault.db` is the authoritative ledger. */
  harnessSessionDir: string;
}

export type WorkspaceProvider = () => VaultWorkspace;
