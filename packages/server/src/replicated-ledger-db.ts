/*
 * THE LEDGER BAND IS REPLICATED DATA (#1014, G4/G22).
 *
 * `vault.db` is one file (#916), and the conversation-ledger band inside it —
 * `conversations`, `turns`, `items`, `attachments` — replicates like any other
 * table. But the band is reached by PATH, from worker subprocesses that never
 * hold the gateway's handle, and session capture is per CONNECTION
 * (`replica/log.ts`): nothing the gateway had open ever saw a worker's writes.
 * Every worker-written conversation was expected on the seat and never logged,
 * and the doorbell — keyed by connection handle — rang for none of them.
 *
 * `@centraid/server/engine` cannot fix this itself: engine is the stable core
 * of the server DAG and must not import `@centraid/vault` (oxlint
 * `no-restricted-imports` over `packages/server/src/engine/**`, and
 * `handlers/work-counters.ts` explains why the boundary is worth keeping). So
 * the bracket is installed at the SEAM, here — one module every production
 * opener of the ledger band goes through.
 */

import { makeLedgerDbProvider } from "@centraid/server/engine";
import type { DatabaseProvider } from "@centraid/server/engine";
import { bracketReplicaWrites } from "@centraid/vault";

/** The producer every ledger-band commit is attributed to. */
const LEDGER_PRODUCER = "ledger";

/**
 * The engine's lazy ledger provider, with this connection's writes bracketed.
 *
 * A no-op on a file with no replica plane — a bare database in a test, or a
 * workspace whose vault `migrateVault` has not touched yet.
 */
export function makeReplicatedLedgerDbProvider(
  dbPath: string
): DatabaseProvider {
  const lazy = makeLedgerDbProvider(dbPath);
  return () => bracketReplicaWrites(lazy(), { producer: LEDGER_PRODUCER });
}
