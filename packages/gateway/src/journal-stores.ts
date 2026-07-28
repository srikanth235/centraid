/*
 * Per-journal-file `ConversationStore` memo (issue #541 review).
 *
 * `makeJournalDbProvider(file)` mints a FRESH lazy provider every call, so
 * `new ConversationStore(makeJournalDbProvider(file))` opens a brand-new
 * `DatabaseSync` (with a 64 MiB `mmap_size`) the first time it is used —
 * and `ConversationStore.close()` is a documented no-op, because the
 * connection belongs to the host's `DatabaseProvider`. Constructing one per
 * fire / per steering message / per compile therefore leaked one connection,
 * one fd, and 64 MiB of mapped address space per call until the process ran
 * out of descriptors.
 *
 * Every gateway-side ledger reader/writer goes through this memo instead: one
 * handle per journal file for the life of the process, which is what
 * `build-gateway.ts`'s per-vault scheduler/enrichment stores already relied on
 * ad hoc. `node:sqlite` is synchronous, so a shared handle is safe for
 * concurrent callers — there is no interleaving to race.
 */

import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  ConversationStore,
  makeJournalDbProvider,
  type DatabaseProvider,
} from "@centraid/app-engine";

interface JournalEntry {
  store: ConversationStore;
  /** Close the handle the provider opened, if it was ever opened at all. */
  close: () => void;
}

const entries = new Map<string, JournalEntry>();

/**
 * The shared `ConversationStore` for one vault's `journal.db`. Callers must
 * NOT call `close()` on the result — the handle outlives any single request
 * and is released by {@link closeJournalConversationStores} at shutdown.
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

/**
 * Close the journal handles for the given files. Called from the gateway's
 * `stop()` so a graceful shutdown leaves no mapped SQLite connection behind
 * (and so a test that recreates a journal file at the same path is not served
 * a stale handle).
 *
 * Scoped on purpose: two gateways can share one process (desktop profiles,
 * test suites), and one stopping must never close the other's handle. Omitting
 * `journalDbFiles` closes everything and is for a whole-process teardown.
 */
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
