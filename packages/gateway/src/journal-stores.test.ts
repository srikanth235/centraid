/*
 * The per-journal-file store memo (issue #541 review). The regression this
 * guards: a fresh `makeJournalDbProvider` per fire leaked one `DatabaseSync`
 * (plus a 64 MiB mapping and an fd) every time, because
 * `ConversationStore.close()` is a no-op on a host-owned connection.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, describe, expect, test } from 'vitest';

import { closeJournalConversationStores, journalConversationStore } from './journal-stores.js';

const dirs: string[] = [];
describe('journal-stores', () => {
  afterEach(async () => {
    closeJournalConversationStores();
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function journalFile(): Promise<string> {
    const dir = await tempDir('gw-journal-memo-');
    dirs.push(dir);
    return path.join(dir, 'journal.db');
  }

  test('one journal file yields one shared store, however many callers ask', async () => {
    const file = await journalFile();
    const first = journalConversationStore(file);
    const second = journalConversationStore(file);
    // Path form must not mint a second handle either — the fire path passes a
    // workspace-derived path, the compile path a differently-joined one.
    const third = journalConversationStore(path.join(path.dirname(file), '.', 'journal.db'));
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test('distinct vaults keep distinct stores', async () => {
    const one = await journalFile();
    const two = await journalFile();
    expect(journalConversationStore(two)).not.toBe(journalConversationStore(one));
  });

  test('shutdown closes the handle and a later caller gets a working store', async () => {
    const file = await journalFile();
    const before = journalConversationStore(file);
    const conversationId = before.ensureAutomationConversation(
      'app/auto',
      'app',
      'Auto',
      'claude-code',
    );
    closeJournalConversationStores();
    const after = journalConversationStore(file);
    expect(after).not.toBe(before);
    // The reopened store still reads what the closed one durably wrote — the
    // close released a handle, it did not lose the ledger.
    expect(after.ensureAutomationConversation('app/auto', 'app', 'Auto', 'claude-code')).toBe(
      conversationId,
    );
  });
});
