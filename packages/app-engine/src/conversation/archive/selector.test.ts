// Conversation-band archival selector edges + referencedHashes union (issue
// #438). Split from archive.test.ts (500-line repo-hygiene cap); shared
// fixtures in test-fixtures.ts.

import { describe, expect, it } from 'vitest';
import { makeJournalDbProvider } from '../../stores/gateway-db.js';
import { ConversationStore } from '../store.js';
import { runConversationArchival } from './index.js';
import {
  MemoryBlobSink,
  countTurns,
  daysAgo,
  now,
  openTempJournal,
  seedAttachment,
  seedConversation,
  seedTurn,
} from './test-fixtures.js';
// ── selector edges ──────────────────────────────────────────────────────────

describe('selector edges', () => {
  it('keeps a live automation thread’s newest turn and any unfinished turn', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, {
      id: 'a/x',
      kind: 'automation',
      automationId: 'a/x',
      updatedAt: now,
    });
    seedTurn(journal, {
      turnId: 't0',
      conversationId: 'a/x',
      seq: 0,
      startedAt: daysAgo(120),
      model: 'm',
    });
    seedTurn(journal, {
      turnId: 't1',
      conversationId: 'a/x',
      seq: 1,
      startedAt: daysAgo(119),
      endedAt: null,
    }); // unfinished, old
    seedTurn(journal, {
      turnId: 't2',
      conversationId: 'a/x',
      seq: 2,
      startedAt: daysAgo(118),
      model: 'm',
    }); // newest

    runConversationArchival({ journal, blobSink, custodyProven: () => true }, { nowMs: now });
    // Only t0 was eligible (t1 unfinished breaks the range before the newest t2,
    // and t2 is the live head) — so only one turn pruned.
    const remaining = (
      journal.prepare(`SELECT id FROM turns WHERE conversation_id = 'a/x' ORDER BY seq`).all() as {
        id: string;
      }[]
    ).map((r) => r.id);
    expect(remaining).toEqual(['t1', 't2']);
    journal.close();
  });

  it('a pinned turn (replay fixture) is never archived and breaks the range', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, {
      id: 'a/x',
      kind: 'automation',
      automationId: 'a/x',
      updatedAt: now,
    });
    seedTurn(journal, {
      turnId: 't0',
      conversationId: 'a/x',
      seq: 0,
      startedAt: daysAgo(120),
      model: 'm',
    });
    seedTurn(journal, {
      turnId: 't1',
      conversationId: 'a/x',
      seq: 1,
      startedAt: daysAgo(119),
      pinned: true,
      model: 'm',
    });
    seedTurn(journal, {
      turnId: 't2',
      conversationId: 'a/x',
      seq: 2,
      startedAt: daysAgo(118),
      model: 'm',
    });
    seedTurn(journal, {
      turnId: 't3',
      conversationId: 'a/x',
      seq: 3,
      startedAt: daysAgo(1),
      model: 'm',
    }); // live head

    const r = runConversationArchival(
      { journal, blobSink, custodyProven: () => true },
      { nowMs: now },
    );
    // Two ranges: [t0] and [t2] (t1 pinned splits them; t3 is the live head).
    expect(r.segmentsWritten).toBe(2);
    expect(r.turnsPruned).toBe(2);
    const remaining = (
      journal.prepare(`SELECT id FROM turns WHERE conversation_id = 'a/x' ORDER BY seq`).all() as {
        id: string;
      }[]
    ).map((x) => x.id);
    expect(remaining).toEqual(['t1', 't3']); // pinned + live head survive
    journal.close();
  });

  it('a chat conversation still active (not wholly idle) is untouched', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    // updated_at is recent even though its turns are old — an active thread.
    seedConversation(journal, { id: 'c1', kind: 'chat', appId: 'app', updatedAt: daysAgo(1) });
    seedTurn(journal, {
      turnId: 't0',
      conversationId: 'c1',
      seq: 0,
      startedAt: daysAgo(120),
      model: 'm',
    });
    const r = runConversationArchival(
      { journal, blobSink, custodyProven: () => true },
      { nowMs: now },
    );
    expect(r.segmentsWritten).toBe(0);
    expect(countTurns(journal, 'c1')).toBe(1);
    journal.close();
  });

  it('a chat conversation containing a pinned turn does not archive', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, { id: 'c1', kind: 'chat', appId: 'app', updatedAt: daysAgo(120) });
    seedTurn(journal, {
      turnId: 't0',
      conversationId: 'c1',
      seq: 0,
      startedAt: daysAgo(120),
      model: 'm',
    });
    seedTurn(journal, {
      turnId: 't1',
      conversationId: 'c1',
      seq: 1,
      startedAt: daysAgo(119),
      pinned: true,
      model: 'm',
    });
    const r = runConversationArchival(
      { journal, blobSink, custodyProven: () => true },
      { nowMs: now },
    );
    expect(r.segmentsWritten).toBe(0);
    expect(countTurns(journal, 'c1')).toBe(2);
    journal.close();
  });

  it('an in-flight retry family protects the turn being retried', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, {
      id: 'a/x',
      kind: 'automation',
      automationId: 'a/x',
      updatedAt: now,
    });
    seedTurn(journal, {
      turnId: 't0',
      conversationId: 'a/x',
      seq: 0,
      startedAt: daysAgo(120),
      model: 'm',
    });
    // t1 is an unfinished retry of t0 — t0 must not archive out from under it.
    seedTurn(journal, {
      turnId: 't1',
      conversationId: 'a/x',
      seq: 1,
      startedAt: daysAgo(119),
      endedAt: null,
      retryOf: 't0',
    });
    seedTurn(journal, {
      turnId: 't2',
      conversationId: 'a/x',
      seq: 2,
      startedAt: daysAgo(1),
      model: 'm',
    });
    const r = runConversationArchival(
      { journal, blobSink, custodyProven: () => true },
      { nowMs: now },
    );
    expect(r.segmentsWritten).toBe(0); // t0 protected, t1 unfinished, t2 live head
    expect(countTurns(journal, 'a/x')).toBe(3);
    journal.close();
  });

  it('re-running never double-archives an already-covered range (idempotent) and leaves automation_state', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, {
      id: 'a/x',
      kind: 'automation',
      automationId: 'a/x',
      updatedAt: now,
    });
    seedTurn(journal, {
      turnId: 't0',
      conversationId: 'a/x',
      seq: 0,
      startedAt: daysAgo(120),
      model: 'm',
    });
    seedTurn(journal, {
      turnId: 't1',
      conversationId: 'a/x',
      seq: 1,
      startedAt: daysAgo(1),
      model: 'm',
    });
    journal
      .prepare(
        `INSERT INTO automation_state (automation_id, key, value_json, updated_at) VALUES ('a/x','cursor','1',?)`,
      )
      .run(now);

    const first = runConversationArchival(
      { journal, blobSink, custodyProven: () => false },
      { nowMs: now },
    );
    const second = runConversationArchival(
      { journal, blobSink, custodyProven: () => false },
      { nowMs: now },
    );
    expect(first.segmentsWritten).toBe(1);
    expect(second.segmentsWritten).toBe(0); // seq 0 already covered
    expect(
      (journal.prepare(`SELECT COUNT(*) AS n FROM conversation_archive`).get() as { n: number }).n,
    ).toBe(1);
    // automation_state is never touched.
    expect(
      (
        journal
          .prepare(`SELECT COUNT(*) AS n FROM automation_state WHERE automation_id = 'a/x'`)
          .get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    journal.close();
  });
});

// ── referencedHashes union (blob GC keeps archived bytes pinned) ────────────

describe('referencedHashes union', () => {
  it('unions live attachment hashes with hashes in unpruned AND pruned archive rows', () => {
    const { dbPath, journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    const liveHash = 'l'.repeat(64);
    const archivedHash = 'r'.repeat(64);
    // A live chat thread with an attachment (stays live — recent).
    seedConversation(journal, { id: 'live', kind: 'chat', appId: 'app', updatedAt: now });
    seedTurn(journal, {
      turnId: 'lt0',
      conversationId: 'live',
      seq: 0,
      startedAt: now,
      model: 'm',
    });
    seedAttachment(journal, 'lt0', liveHash);
    // An old chat thread whose attachment rides an archived-then-pruned turn.
    seedConversation(journal, { id: 'old', kind: 'chat', appId: 'app', updatedAt: daysAgo(120) });
    seedTurn(journal, {
      turnId: 'ot0',
      conversationId: 'old',
      seq: 0,
      startedAt: daysAgo(120),
      model: 'm',
    });
    seedAttachment(journal, 'ot0', archivedHash);

    runConversationArchival({ journal, blobSink, custodyProven: () => true }, { nowMs: now });
    // The archived turn (and its attachment row) is pruned — but the hash is
    // recorded in conversation_archive.attachment_hashes_json.
    expect(
      (
        journal
          .prepare(`SELECT COUNT(*) AS n FROM attachments WHERE hash = ?`)
          .get(archivedHash) as { n: number }
      ).n,
    ).toBe(0);

    const store = new ConversationStore(makeJournalDbProvider(dbPath));
    const hashes = store.referencedHashes();
    expect(hashes.has(liveHash)).toBe(true);
    expect(hashes.has(archivedHash)).toBe(true); // still pinned though pruned
    store.close();
    journal.close();
  });
});
