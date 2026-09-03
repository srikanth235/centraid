import type { DatabaseSync } from "node:sqlite";

import type { Row } from "./types.js";

export interface EligibleRange {
  conversationId: string;
  kind: string;
  seqFrom: number;
  seqTo: number;
  turns: Row[];
}

interface ConversationHead {
  id: string;
  kind: string;
  updated_at: number;
}

function archivedRanges(
  journal: DatabaseSync,
  conversationId: string
): Array<[number, number]> {
  const rows = journal
    .prepare(
      `SELECT seq_from, seq_to FROM conversation_archive WHERE conversation_id = ? ORDER BY seq_from`
    )
    .all(conversationId) as { seq_from: number; seq_to: number }[];
  return rows.map((r) => [r.seq_from, r.seq_to]);
}

function seqAlreadyArchived(
  ranges: Array<[number, number]>,
  seq: number
): boolean {
  for (const [from, to] of ranges) if (seq >= from && seq <= to) return true;
  return false;
}

function retryProtectedTurnIds(
  journal: DatabaseSync,
  conversationId: string
): Set<string> {
  const rows = journal
    .prepare(
      `SELECT retry_of FROM turns
        WHERE conversation_id = ? AND ended_at IS NULL AND retry_of IS NOT NULL`
    )
    .all(conversationId) as { retry_of: string }[];
  return new Set(rows.map((r) => r.retry_of));
}

function toContiguousRanges(
  conversationId: string,
  kind: string,
  eligible: Row[]
): EligibleRange[] {
  const out: EligibleRange[] = [];
  let run: Row[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    out.push({
      conversationId,
      kind,
      seqFrom: run[0]!.seq as number,
      seqTo: run[run.length - 1]!.seq as number,
      turns: run,
    });
    run = [];
  };
  let prevSeq: number | undefined;
  for (const t of eligible) {
    const seq = t.seq as number;
    if (prevSeq !== undefined && seq !== prevSeq + 1) flush();
    run.push(t);
    prevSeq = seq;
  }
  flush();
  return out;
}

export function eligibleRangesForConversation(
  journal: DatabaseSync,
  head: ConversationHead,
  cutoffMs: number
): EligibleRange[] {
  const turns = journal
    .prepare(`SELECT * FROM turns WHERE conversation_id = ? ORDER BY seq ASC`)
    .all(head.id) as Row[];
  if (turns.length === 0) return [];

  const newestSeq = turns[turns.length - 1]!.seq as number;
  const archived = archivedRanges(journal, head.id);
  const retryProtected = retryProtectedTurnIds(journal, head.id);
  const isAutomation = head.kind === "automation";

  if (!isAutomation) {
    if (head.updated_at >= cutoffMs) return [];
    for (const t of turns) {
      if ((t.pinned as number) !== 0) return [];
      if (t.ended_at === null || t.ended_at === undefined) return [];
    }
  }

  const eligible = turns.filter((t) => {
    const seq = t.seq as number;
    const endedAt = t.ended_at as number | null;
    if (endedAt === null || endedAt === undefined) return false; // unfinished
    if (endedAt >= cutoffMs) return false; // still in the window
    if ((t.pinned as number) !== 0) return false; // replay fixture
    if (isAutomation && seq === newestSeq) return false; // keep the live head
    if (retryProtected.has(t.id as string)) return false; // in-flight retry family
    if (seqAlreadyArchived(archived, seq)) return false; // idempotent re-run
    return true;
  });

  return toContiguousRanges(head.id, head.kind, eligible);
}

export function selectEligibleRanges(
  journal: DatabaseSync,
  cutoffMs: number,
  maxConversations: number
): EligibleRange[] {
  const heads = journal
    .prepare(
      `SELECT id, kind, updated_at FROM conversations
        WHERE kind = 'automation' OR updated_at < ?
        ORDER BY updated_at ASC`
    )
    .all(cutoffMs) as unknown as ConversationHead[];

  const ranges: EligibleRange[] = [];
  const touched = new Set<string>();
  for (const head of heads) {
    if (touched.size >= maxConversations && !touched.has(head.id)) break;
    const forConv = eligibleRangesForConversation(journal, head, cutoffMs);
    if (forConv.length === 0) continue;
    touched.add(head.id);
    ranges.push(...forConv);
    if (touched.size >= maxConversations) break;
  }
  return ranges;
}
