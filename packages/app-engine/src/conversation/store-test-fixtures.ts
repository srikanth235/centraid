// Shared fixtures for the ConversationStore unit tests: a real journal.db on a
// fresh temp dir, so every store gets an isolated SQLite file (WAL and all)
// rather than a shared in-memory handle. Test-only module — imported by
// store.test.ts / store-items.test.ts, never shipped.

import { tempDirSync } from '@centraid/test-kit/temp-dir';
import path from 'node:path';
import { makeJournalDbProvider, type DatabaseProvider } from '../stores/gateway-db.js';
import { ConversationStore } from './store.js';

export function newProvider(): DatabaseProvider {
  const dir = tempDirSync('centraid-conv-store-');
  return makeJournalDbProvider(path.join(dir, 'journal.db'));
}

export function newStore(): ConversationStore {
  return new ConversationStore(newProvider());
}
