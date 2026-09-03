import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  ConversationStore,
  makeLedgerDbProvider,
} from "@centraid/server/engine";
import type { DatabaseProvider } from "@centraid/server/engine";

interface LedgerEntry {
  store: ConversationStore;
  close: () => void;
}

const entries = new Map<string, LedgerEntry>();

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
