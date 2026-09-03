/*
 * Per-file ConversationStore memo (#541): a per-call store leaks an fd + 64 MiB
 * mmap each time (fresh provider; close() is a no-op). One handle per vault
 * file for the process lifetime; node:sqlite is sync — no races.
 */

import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  ConversationStore,
  makeLedgerDbProvider,
} from "@centraid/server/engine";
import type { DatabaseProvider } from "@centraid/server/engine";

interface LedgerEntry {
  store: ConversationStore;
  /** Close the provider's handle, if ever opened. */
  close: () => void;
}

const entries = new Map<string, LedgerEntry>();

/**
 * Shared `ConversationStore` for one vault's `vault.db` — the ledger band of
 * the one file (#916). NEVER call `close()` on it — released by
 * {@link closeLedgerConversationStores}.
 */
export function ledgerConversationStore(
  ledgerDbFile: string
): ConversationStore {
  const key = path.resolve(ledgerDbFile);
  const existing = entries.get(key);
  if (existing) return existing.store;
  const lazy = makeLedgerDbProvider(key);
  let opened: DatabaseSync | undefined;
  const tracking: DatabaseProvider = () => {
    opened = lazy();
    return opened;
  };

  const entry: LedgerEntry = {
    store: new ConversationStore(tracking),
    close: () => {
      opened?.close();
      opened = undefined;
    },
  };
  entries.set(key, entry);
  return entry.store;
}

/** Close handles for the given files (gateway stop()); omit only for
 *  whole-process teardown — two gateways may share one process. */
export function closeLedgerConversationStores(
  ledgerDbFiles?: readonly string[]
): void {
  const keys =
    ledgerDbFiles === undefined
      ? [...entries.keys()]
      : ledgerDbFiles.map((f) => path.resolve(f));
  for (const key of keys) {
    const entry = entries.get(key);
    if (!entry) continue;
    entry.close();
    entries.delete(key);
  }
}
