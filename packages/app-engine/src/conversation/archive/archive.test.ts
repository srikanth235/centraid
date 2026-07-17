// Conversation-band archival engine (issue #438). Real journal.db on a temp
// file (so incremental_vacuum can reclaim pages) + an in-memory content-
// addressed blob sink standing in for the vault CAS door. No mocks of the SQL.

import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { makeJournalDbProvider, openJournalDb } from '../../stores/gateway-db.js';
import { ConversationStore } from '../store.js';
import { runConversationArchival, readArchivedConversationSegment } from './index.js';
import type { BlobSink } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const daysAgo = (d: number): number => now - d * DAY_MS;

class MemoryBlobSink implements BlobSink {
  readonly store = new Map<string, Buffer>();
  ingestSync(bytes: Buffer): { sha256: string; byteSize: number } {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!this.store.has(sha256)) this.store.set(sha256, Buffer.from(bytes));
    return { sha256, byteSize: bytes.length };
  }
  has(sha: string): boolean {
    return this.store.has(sha);
  }
  get(sha: string): Buffer | undefined {
    return this.store.get(sha);
  }
}

function openTempJournal(): { journal: DatabaseSync; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'centraid-conv-archive-'));
  const dbPath = path.join(dir, 'journal.db');
  return { journal: openJournalDb(dbPath), dbPath };
}

function seedConversation(
  journal: DatabaseSync,
  a: {
    id: string;
    kind: 'chat' | 'build' | 'automation';
    appId?: string | null;
    automationId?: string | null;
    title?: string;
    updatedAt: number;
  },
): void {
  journal
    .prepare(
      `INSERT INTO conversations (id, kind, user_id, app_id, automation_id, title, created_at, updated_at)
       VALUES (?, ?, 'u1', ?, ?, ?, ?, ?)`,
    )
    .run(a.id, a.kind, a.appId ?? null, a.automationId ?? null, a.title ?? '', a.updatedAt, a.updatedAt);
}

interface SeedTurnArgs {
  turnId: string;
  conversationId: string;
  seq: number;
  startedAt: number;
  endedAt?: number | null;
  ok?: boolean;
  pinned?: boolean;
  retryOf?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  stepCount?: number;
  toolCount?: number;
  model?: string;
}

function seedTurn(journal: DatabaseSync, a: SeedTurnArgs): void {
  const ended = a.endedAt === undefined ? a.startedAt + 1000 : a.endedAt;
  journal
    .prepare(
      `INSERT INTO turns (id, conversation_id, seq, trigger, retry_of, ok, pinned, started_at, ended_at,
         total_input_tokens, total_output_tokens, total_cost_usd, step_count, tool_count)
       VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      a.turnId,
      a.conversationId,
      a.seq,
      a.retryOf ?? null,
      a.ok === false ? 0 : 1,
      a.pinned ? 1 : 0,
      a.startedAt,
      ended,
      a.inputTokens ?? 0,
      a.outputTokens ?? 0,
      a.costUsd ?? 0,
      a.stepCount ?? 0,
      a.toolCount ?? 0,
    );
  journal
    .prepare(
      `INSERT INTO items (id, turn_id, ordinal, kind, role, text, ok, started_at)
       VALUES (?, ?, 0, 'message_in', 'user', ?, 1, ?)`,
    )
    .run(`${a.turnId}-msg`, a.turnId, `input ${a.turnId}`, a.startedAt);
  if (a.model !== undefined) {
    journal
      .prepare(
        `INSERT INTO items (id, turn_id, ordinal, kind, model, input_tokens, output_tokens, cost_usd, ok, started_at)
         VALUES (?, ?, 1, 'step', ?, ?, ?, ?, 1, ?)`,
      )
      .run(`${a.turnId}-step`, a.turnId, a.model, a.inputTokens ?? 0, a.outputTokens ?? 0, a.costUsd ?? 0, a.startedAt);
  }
}

function seedAttachment(journal: DatabaseSync, turnId: string, hash: string): void {
  journal
    .prepare(
      `INSERT INTO attachments (id, item_id, hash, mime, size_bytes, created_at)
       VALUES (?, ?, ?, 'image/png', 10, ?)`,
    )
    .run(`${turnId}-att`, `${turnId}-msg`, hash, now);
}

function countTurns(journal: DatabaseSync, conversationId: string): number {
  return Number(
    (journal.prepare(`SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?`).get(conversationId) as {
      n: number;
    }).n,
  );
}

// ── prune-before-custody is structurally impossible ────────────────────────

describe('custody-gated prune', () => {
  it('never deletes raw rows while custody is unproven, even across many runs', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, { id: 'a/digest', kind: 'automation', automationId: 'a/digest', updatedAt: now });
    // Three aged finished turns + one fresh live turn (the newest, seq 3).
    seedTurn(journal, { turnId: 't0', conversationId: 'a/digest', seq: 0, startedAt: daysAgo(120), model: 'm' });
    seedTurn(journal, { turnId: 't1', conversationId: 'a/digest', seq: 1, startedAt: daysAgo(119), model: 'm' });
    seedTurn(journal, { turnId: 't2', conversationId: 'a/digest', seq: 2, startedAt: daysAgo(118), model: 'm' });
    seedTurn(journal, { turnId: 't3', conversationId: 'a/digest', seq: 3, startedAt: daysAgo(1), model: 'm' });

    const never = (): boolean => false;
    for (let i = 0; i < 3; i++) {
      const r = runConversationArchival({ journal, blobSink, custodyProven: never }, { nowMs: now });
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
    seedConversation(journal, { id: 'a/digest', kind: 'automation', automationId: 'a/digest', updatedAt: now });
    seedTurn(journal, { turnId: 't0', conversationId: 'a/digest', seq: 0, startedAt: daysAgo(120), model: 'm' });
    seedTurn(journal, { turnId: 't1', conversationId: 'a/digest', seq: 1, startedAt: daysAgo(119), model: 'm' });
    seedTurn(journal, { turnId: 't2', conversationId: 'a/digest', seq: 2, startedAt: daysAgo(1), model: 'm' }); // live head

    runConversationArchival({ journal, blobSink, custodyProven: () => false }, { nowMs: now });
    expect(countTurns(journal, 'a/digest')).toBe(3);

    const always = (): boolean => true;
    const pruned = runConversationArchival({ journal, blobSink, custodyProven: always }, { nowMs: now });
    expect(pruned.segmentsPruned).toBe(1);
    expect(pruned.turnsPruned).toBe(2); // seq 0..1 gone
    expect(countTurns(journal, 'a/digest')).toBe(1); // only the live head remains
    // Items of the pruned turns CASCADE away.
    expect(
      (journal.prepare(`SELECT COUNT(*) AS n FROM items WHERE turn_id IN ('t0','t1')`).get() as { n: number }).n,
    ).toBe(0);
    const latch = journal.prepare(`SELECT pruned_at FROM conversation_archive`).get() as {
      pruned_at: number | null;
    };
    expect(latch.pruned_at).not.toBeNull();

    // Idempotent: re-running prunes nothing new (the latch is set).
    const again = runConversationArchival({ journal, blobSink, custodyProven: always }, { nowMs: now });
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
    seedConversation(journal, { id: 'c1', kind: 'chat', appId: 'app', title: 'Old chat', updatedAt: daysAgo(120) });
    seedTurn(journal, { turnId: 't0', conversationId: 'c1', seq: 0, startedAt: daysAgo(120), inputTokens: 5, model: 'm' });
    seedAttachment(journal, 't0', 'a'.repeat(64));
    const srcTurn = journal.prepare(`SELECT * FROM turns WHERE id = 't0'`).get();
    const srcItems = journal.prepare(`SELECT * FROM items WHERE turn_id = 't0' ORDER BY ordinal`).all();
    const srcAtt = journal.prepare(`SELECT * FROM attachments WHERE item_id = 't0-msg'`).all();

    const r = runConversationArchival({ journal, blobSink, custodyProven: () => false }, { nowMs: now });
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
    const before = (journal.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    const r = runConversationArchival({ journal, blobSink, custodyProven: () => true }, { nowMs: now });
    expect(r.turnsPruned).toBe(200);
    expect(r.reclaim.ranVacuum).toBe(true);
    expect(r.reclaim.mode).toBe('incremental');
    journal.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const after = (journal.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    expect(after).toBeLessThan(before);
    journal.close();
  });
});

// ── selector edges ──────────────────────────────────────────────────────────

describe('selector edges', () => {
  it('keeps a live automation thread’s newest turn and any unfinished turn', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, { id: 'a/x', kind: 'automation', automationId: 'a/x', updatedAt: now });
    seedTurn(journal, { turnId: 't0', conversationId: 'a/x', seq: 0, startedAt: daysAgo(120), model: 'm' });
    seedTurn(journal, { turnId: 't1', conversationId: 'a/x', seq: 1, startedAt: daysAgo(119), endedAt: null }); // unfinished, old
    seedTurn(journal, { turnId: 't2', conversationId: 'a/x', seq: 2, startedAt: daysAgo(118), model: 'm' }); // newest

    runConversationArchival({ journal, blobSink, custodyProven: () => true }, { nowMs: now });
    // Only t0 was eligible (t1 unfinished breaks the range before the newest t2,
    // and t2 is the live head) — so only one turn pruned.
    const remaining = (journal.prepare(`SELECT id FROM turns WHERE conversation_id = 'a/x' ORDER BY seq`).all() as {
      id: string;
    }[]).map((r) => r.id);
    expect(remaining).toEqual(['t1', 't2']);
    journal.close();
  });

  it('a pinned turn (replay fixture) is never archived and breaks the range', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, { id: 'a/x', kind: 'automation', automationId: 'a/x', updatedAt: now });
    seedTurn(journal, { turnId: 't0', conversationId: 'a/x', seq: 0, startedAt: daysAgo(120), model: 'm' });
    seedTurn(journal, { turnId: 't1', conversationId: 'a/x', seq: 1, startedAt: daysAgo(119), pinned: true, model: 'm' });
    seedTurn(journal, { turnId: 't2', conversationId: 'a/x', seq: 2, startedAt: daysAgo(118), model: 'm' });
    seedTurn(journal, { turnId: 't3', conversationId: 'a/x', seq: 3, startedAt: daysAgo(1), model: 'm' }); // live head

    const r = runConversationArchival({ journal, blobSink, custodyProven: () => true }, { nowMs: now });
    // Two ranges: [t0] and [t2] (t1 pinned splits them; t3 is the live head).
    expect(r.segmentsWritten).toBe(2);
    expect(r.turnsPruned).toBe(2);
    const remaining = (journal.prepare(`SELECT id FROM turns WHERE conversation_id = 'a/x' ORDER BY seq`).all() as {
      id: string;
    }[]).map((x) => x.id);
    expect(remaining).toEqual(['t1', 't3']); // pinned + live head survive
    journal.close();
  });

  it('a chat conversation still active (not wholly idle) is untouched', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    // updated_at is recent even though its turns are old — an active thread.
    seedConversation(journal, { id: 'c1', kind: 'chat', appId: 'app', updatedAt: daysAgo(1) });
    seedTurn(journal, { turnId: 't0', conversationId: 'c1', seq: 0, startedAt: daysAgo(120), model: 'm' });
    const r = runConversationArchival({ journal, blobSink, custodyProven: () => true }, { nowMs: now });
    expect(r.segmentsWritten).toBe(0);
    expect(countTurns(journal, 'c1')).toBe(1);
    journal.close();
  });

  it('a chat conversation containing a pinned turn does not archive', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, { id: 'c1', kind: 'chat', appId: 'app', updatedAt: daysAgo(120) });
    seedTurn(journal, { turnId: 't0', conversationId: 'c1', seq: 0, startedAt: daysAgo(120), model: 'm' });
    seedTurn(journal, { turnId: 't1', conversationId: 'c1', seq: 1, startedAt: daysAgo(119), pinned: true, model: 'm' });
    const r = runConversationArchival({ journal, blobSink, custodyProven: () => true }, { nowMs: now });
    expect(r.segmentsWritten).toBe(0);
    expect(countTurns(journal, 'c1')).toBe(2);
    journal.close();
  });

  it('an in-flight retry family protects the turn being retried', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, { id: 'a/x', kind: 'automation', automationId: 'a/x', updatedAt: now });
    seedTurn(journal, { turnId: 't0', conversationId: 'a/x', seq: 0, startedAt: daysAgo(120), model: 'm' });
    // t1 is an unfinished retry of t0 — t0 must not archive out from under it.
    seedTurn(journal, { turnId: 't1', conversationId: 'a/x', seq: 1, startedAt: daysAgo(119), endedAt: null, retryOf: 't0' });
    seedTurn(journal, { turnId: 't2', conversationId: 'a/x', seq: 2, startedAt: daysAgo(1), model: 'm' });
    const r = runConversationArchival({ journal, blobSink, custodyProven: () => true }, { nowMs: now });
    expect(r.segmentsWritten).toBe(0); // t0 protected, t1 unfinished, t2 live head
    expect(countTurns(journal, 'a/x')).toBe(3);
    journal.close();
  });

  it('re-running never double-archives an already-covered range (idempotent) and leaves automation_state', () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, { id: 'a/x', kind: 'automation', automationId: 'a/x', updatedAt: now });
    seedTurn(journal, { turnId: 't0', conversationId: 'a/x', seq: 0, startedAt: daysAgo(120), model: 'm' });
    seedTurn(journal, { turnId: 't1', conversationId: 'a/x', seq: 1, startedAt: daysAgo(1), model: 'm' });
    journal
      .prepare(`INSERT INTO automation_state (automation_id, key, value_json, updated_at) VALUES ('a/x','cursor','1',?)`)
      .run(now);

    const first = runConversationArchival({ journal, blobSink, custodyProven: () => false }, { nowMs: now });
    const second = runConversationArchival({ journal, blobSink, custodyProven: () => false }, { nowMs: now });
    expect(first.segmentsWritten).toBe(1);
    expect(second.segmentsWritten).toBe(0); // seq 0 already covered
    expect((journal.prepare(`SELECT COUNT(*) AS n FROM conversation_archive`).get() as { n: number }).n).toBe(1);
    // automation_state is never touched.
    expect(
      (journal.prepare(`SELECT COUNT(*) AS n FROM automation_state WHERE automation_id = 'a/x'`).get() as {
        n: number;
      }).n,
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
    seedTurn(journal, { turnId: 'lt0', conversationId: 'live', seq: 0, startedAt: now, model: 'm' });
    seedAttachment(journal, 'lt0', liveHash);
    // An old chat thread whose attachment rides an archived-then-pruned turn.
    seedConversation(journal, { id: 'old', kind: 'chat', appId: 'app', updatedAt: daysAgo(120) });
    seedTurn(journal, { turnId: 'ot0', conversationId: 'old', seq: 0, startedAt: daysAgo(120), model: 'm' });
    seedAttachment(journal, 'ot0', archivedHash);

    runConversationArchival({ journal, blobSink, custodyProven: () => true }, { nowMs: now });
    // The archived turn (and its attachment row) is pruned — but the hash is
    // recorded in conversation_archive.attachment_hashes_json.
    expect((journal.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE hash = ?`).get(archivedHash) as { n: number }).n).toBe(0);

    const store = new ConversationStore(makeJournalDbProvider(dbPath));
    const hashes = store.referencedHashes();
    expect(hashes.has(liveHash)).toBe(true);
    expect(hashes.has(archivedHash)).toBe(true); // still pinned though pruned
    store.close();
    journal.close();
  });
});
