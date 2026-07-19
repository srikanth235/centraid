// Conversation-band archival engine (issue #438): custody-gated prune,
// segment round-trip, and page reclamation. Selector-edge cases live in
// selector.test.ts; shared fixtures in test-fixtures.ts.

import { describe, expect, it } from 'vitest';
import { runConversationArchival, readArchivedConversationSegment } from './index.js';
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
// ── prune-before-custody is structurally impossible ────────────────────────

describe('custody-gated prune', () => {
  it('never deletes raw rows while custody is unproven, even across many runs', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, {
      id: 'a/digest',
      kind: 'automation',
      automationId: 'a/digest',
      updatedAt: now,
    });
    // Three aged finished turns + one fresh live turn (the newest, seq 3).
    seedTurn(journal, {
      turnId: 't0',
      conversationId: 'a/digest',
      seq: 0,
      startedAt: daysAgo(120),
      model: 'm',
    });
    seedTurn(journal, {
      turnId: 't1',
      conversationId: 'a/digest',
      seq: 1,
      startedAt: daysAgo(119),
      model: 'm',
    });
    seedTurn(journal, {
      turnId: 't2',
      conversationId: 'a/digest',
      seq: 2,
      startedAt: daysAgo(118),
      model: 'm',
    });
    seedTurn(journal, {
      turnId: 't3',
      conversationId: 'a/digest',
      seq: 3,
      startedAt: daysAgo(1),
      model: 'm',
    });

    const never = (): boolean => false;
    for (let i = 0; i < 3; i++) {
      const r = runConversationArchival(
        { journal, blobSink, custodyProven: never },
        { nowMs: now },
      );
      // Phase A still runs (once) — the range archives; phase B never prunes.
      expect(r.segmentsPruned).toBe(0);
      expect(r.turnsPruned).toBe(0);
    }
    // Raw rows for the archived range remain fully intact.
    expect(countTurns(journal, 'a/digest')).toBe(4);
    const archiveRows = journal.prepare(`SELECT pruned_at FROM conversation_archive`).all() as {
      pruned_at: number | null;
    }[];
    expect(archiveRows.length).toBe(1); // idempotent — one range, one row
    expect(archiveRows[0]!.pruned_at).toBeNull();
    journal.close();
  });

  it('prunes exactly the archived range once custody flips true, and the latch is idempotent', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, {
      id: 'a/digest',
      kind: 'automation',
      automationId: 'a/digest',
      updatedAt: now,
    });
    seedTurn(journal, {
      turnId: 't0',
      conversationId: 'a/digest',
      seq: 0,
      startedAt: daysAgo(120),
      model: 'm',
    });
    seedTurn(journal, {
      turnId: 't1',
      conversationId: 'a/digest',
      seq: 1,
      startedAt: daysAgo(119),
      model: 'm',
    });
    seedTurn(journal, {
      turnId: 't2',
      conversationId: 'a/digest',
      seq: 2,
      startedAt: daysAgo(1),
      model: 'm',
    }); // live head

    runConversationArchival({ journal, blobSink, custodyProven: () => false }, { nowMs: now });
    expect(countTurns(journal, 'a/digest')).toBe(3);

    const always = (): boolean => true;
    const pruned = runConversationArchival(
      { journal, blobSink, custodyProven: always },
      { nowMs: now },
    );
    expect(pruned.segmentsPruned).toBe(1);
    expect(pruned.turnsPruned).toBe(2); // seq 0..1 gone
    expect(countTurns(journal, 'a/digest')).toBe(1); // only the live head remains
    // Items of the pruned turns CASCADE away.
    expect(
      (
        journal.prepare(`SELECT COUNT(*) AS n FROM items WHERE turn_id IN ('t0','t1')`).get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    const latch = journal.prepare(`SELECT pruned_at FROM conversation_archive`).get() as {
      pruned_at: number | null;
    };
    expect(latch.pruned_at).not.toBeNull();

    // Idempotent: re-running prunes nothing new (the latch is set).
    const again = runConversationArchival(
      { journal, blobSink, custodyProven: always },
      { nowMs: now },
    );
    expect(again.segmentsPruned).toBe(0);
    expect(again.turnsPruned).toBe(0);
    journal.close();
  });
});

// ── segment round-trip ─────────────────────────────────────────────────────

describe('segment round-trip', () => {
  it('decodes the archived segment back into byte-identical source rows', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, {
      id: 'c1',
      kind: 'chat',
      appId: 'app',
      title: 'Old chat',
      updatedAt: daysAgo(120),
    });
    seedTurn(journal, {
      turnId: 't0',
      conversationId: 'c1',
      seq: 0,
      startedAt: daysAgo(120),
      inputTokens: 5,
      model: 'm',
    });
    seedAttachment(journal, 't0', 'a'.repeat(64));
    const srcTurn = journal.prepare(`SELECT * FROM turns WHERE id = 't0'`).get();
    const srcItems = journal
      .prepare(`SELECT * FROM items WHERE turn_id = 't0' ORDER BY ordinal`)
      .all();
    const srcAtt = journal.prepare(`SELECT * FROM attachments WHERE item_id = 't0-msg'`).all();

    const r = runConversationArchival(
      { journal, blobSink, custodyProven: () => false },
      { nowMs: now },
    );
    expect(r.segmentsWritten).toBe(1);
    const sha = r.archived[0]!.segmentSha256;
    const bytes = blobSink.get(sha)!;
    const segment = readArchivedConversationSegment(bytes);

    expect(segment.version).toBe(1);
    expect(segment.conversationId).toBe('c1');
    expect(segment.conversation.title).toBe('Old chat');
    expect(segment.turns).toEqual([srcTurn]);
    expect(segment.items).toEqual(srcItems);
    expect(segment.attachments).toEqual(srcAtt);
    journal.close();
  });
});

// ── vacuum reclaims pages ───────────────────────────────────────────────────

describe('page reclamation', () => {
  it('drops page_count after a custody-proven prune (incremental_vacuum)', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, { id: 'c1', kind: 'chat', appId: 'app', updatedAt: daysAgo(120) });
    // Enough bulky turns to occupy real pages worth reclaiming.
    for (let i = 0; i < 200; i++) {
      seedTurn(journal, {
        turnId: `t${i}`,
        conversationId: 'c1',
        seq: i,
        startedAt: daysAgo(120),
        inputTokens: 100,
        model: 'x'.repeat(200),
      });
    }
    journal.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = (journal.prepare('PRAGMA page_count').get() as { page_count: number })
      .page_count;
    const r = runConversationArchival(
      { journal, blobSink, custodyProven: () => true },
      { nowMs: now },
    );
    expect(r.turnsPruned).toBe(200);
    expect(r.reclaim.ranVacuum).toBe(true);
    expect(r.reclaim.mode).toBe('incremental');
    journal.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const after = (journal.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    expect(after).toBeLessThan(before);
    journal.close();
  });
});
