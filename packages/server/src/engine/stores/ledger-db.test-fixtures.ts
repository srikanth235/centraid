// Test-only. ONE FILE (#916): the conversation ledger is a band of `vault.db`,
// composed by `migrateVault`, so a store can no longer be pointed at a bare
// path and expected to create its own tables. This mints a real, migrated vault
// in `dir` and hands back the path its ledger band lives in — which is what the
// gateway hands the workers in production.

import path from "node:path";

import { openVaultDb } from "@centraid/vault";

/** Dirs already minted in this process — a second migrate would race the
 *  connections the test already holds on the file. */
const minted = new Set<string>();

/** A migrated `vault.db` under `dir`; the opening handle is closed again. */
export function ledgerDbFileIn(dir: string): string {
  const file = path.join(dir, "vault.db");
  if (minted.has(file)) return file;
  minted.add(file);
  openVaultDb({ dir }).close({ skipOptimize: true });
  return file;
}
