// Shared fixtures for the conversation-band archival engine tests (issue
// #438): a real journal.db on a temp file (so incremental_vacuum can reclaim
// pages) + an in-memory content-addressed blob sink standing in for the vault
// CAS door. Test-only module — imported by archive.test.ts / selector.test.ts,
// never shipped.

import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openJournalDb } from '../../stores/gateway-db.js';
import type { BlobSink } from './types.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const now = Date.now();
export const daysAgo = (d: number): number => now - d * DAY_MS;

export class MemoryBlobSink implements BlobSink {
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

export function openTempJournal(): { journal: DatabaseSync; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'centraid-conv-archive-'));
  const dbPath = path.join(dir, 'journal.db');
  return { journal: openJournalDb(dbPath), dbPath };
}

export function seedConversation(
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
    .run(
      a.id,
      a.kind,
      a.appId ?? null,
      a.automationId ?? null,
      a.title ?? '',
      a.updatedAt,
      a.updatedAt,
    );
}

export interface SeedTurnArgs {
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

export function seedTurn(journal: DatabaseSync, a: SeedTurnArgs): void {
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
      .run(
        `${a.turnId}-step`,
        a.turnId,
        a.model,
        a.inputTokens ?? 0,
        a.outputTokens ?? 0,
        a.costUsd ?? 0,
        a.startedAt,
      );
  }
}

export function seedAttachment(journal: DatabaseSync, turnId: string, hash: string): void {
  journal
    .prepare(
      `INSERT INTO attachments (id, item_id, hash, mime, size_bytes, created_at)
       VALUES (?, ?, ?, 'image/png', 10, ?)`,
    )
    .run(`${turnId}-att`, `${turnId}-msg`, hash, now);
}

export function countTurns(journal: DatabaseSync, conversationId: string): number {
  return Number(
    (
      journal
        .prepare(`SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?`)
        .get(conversationId) as {
        n: number;
      }
    ).n,
  );
}
