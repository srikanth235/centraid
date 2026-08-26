/*
 * Per-journal-file ConversationStore memo (#541): a per-call store leaks an fd
 * + 64 MiB mmap each time (fresh provider; close() is a no-op). One handle per
 * journal file for the process lifetime; node:sqlite is sync — no races.
 */

import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  ConversationStore,
  makeJournalDbProvider,
} from "@centraid/server/engine";
import type { DatabaseProvider } from "@centraid/server/engine";

interface JournalEntry {
  store: ConversationStore;
  /** Close the provider's handle, if ever opened. */
  close: () => void;
}

const entries = new Map<string, JournalEntry>();

/**
 * Shared `ConversationStore` for one vault's `journal.db`. NEVER call
 * `close()` on it — released by {@link closeJournalConversationStores}.
 */
export function journalConversationStore(
  journalDbFile: string
): ConversationStore {
  const key = path.resolve(journalDbFile);
  const existing = entries.get(key);
  if (existing) return existing.store;
  const lazy = makeJournalDbProvider(key);
  let opened: DatabaseSync | undefined;
  const tracking: DatabaseProvider = () => {
    opened = lazy();
    return opened;
  };
  const entry: JournalEntry = {
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
export function closeJournalConversationStores(
  journalDbFiles?: readonly string[]
): void {
  const keys =
    journalDbFiles === undefined
      ? [...entries.keys()]
      : journalDbFiles.map((f) => path.resolve(f));
  for (const key of keys) {
    const entry = entries.get(key);
    if (!entry) continue;
    entry.close();
    entries.delete(key);
  }
}
