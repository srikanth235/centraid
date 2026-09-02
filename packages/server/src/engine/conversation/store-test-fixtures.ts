// Shared fixtures for the ConversationStore unit tests: a real vault.db on a
// fresh temp dir, so every store gets an isolated SQLite file (WAL and all)
// rather than a shared in-memory handle. Test-only module — imported by
// store.test.ts / store-items.test.ts, never shipped.

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { makeLedgerDbProvider } from "../stores/gateway-db.js";
import type { DatabaseProvider } from "../stores/gateway-db.js";
import { ledgerDbFileIn } from "../stores/ledger-db.test-fixtures.js";
import { ConversationStore } from "./store.js";

export function newProvider(): DatabaseProvider {
  const dir = tempDirSync("centraid-conv-store-");
  return makeLedgerDbProvider(ledgerDbFileIn(dir));
}

export function newStore(): ConversationStore {
  return new ConversationStore(newProvider());
}
