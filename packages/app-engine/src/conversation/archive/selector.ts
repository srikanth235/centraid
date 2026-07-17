// Phase-A eligibility (issue #438 decision 1). Selects the cold turn-ranges a
// conversation can seal away WITHOUT ever touching a live, pinned, in-flight, or
// already-archived turn. Reads only — no lock held, no mutation.

import type { DatabaseSync } from 'node:sqlite';
import type { Row } from './types.js';

/** A contiguous seq-range of one conversation eligible for one segment. */
export interface EligibleRange {
  conversationId: string;
  kind: string;
  seqFrom: number;
  seqTo: number;
  /** Turn rows in the range, ascending by seq. */
  turns: Row[];
}

interface ConversationHead {
  id: string;
  kind: string;
  updated_at: number;
}

/** seq-ranges [from,to] already covered by a conversation_archive row. */
function archivedRanges(journal: DatabaseSync, conversationId: string): Array<[number, number]> {
  const rows = journal
    .prepare(
      `SELECT seq_from, seq_to FROM conversation_archive WHERE conversation_id = ? ORDER BY seq_from`,
    )
    .all(conversationId) as { seq_from: number; seq_to: number }[];
  return rows.map((r) => [r.seq_from, r.seq_to]);
}

function seqAlreadyArchived(ranges: Array<[number, number]>, seq: number): boolean {
  for (const [from, to] of ranges) if (seq >= from && seq <= to) return true;
  return false;
}

/**
 * turn ids protected by an IN-FLIGHT retry family: any turn a still-unfinished
 * turn is retrying (`retry_of`) must not be archived out from under the live
 * retry. Unfinished turns are themselves never eligible (they are not finished).
 */
function retryProtectedTurnIds(journal: DatabaseSync, conversationId: string): Set<string> {
  const rows = journal
    .prepare(
      `SELECT retry_of FROM turns
        WHERE conversation_id = ? AND ended_at IS NULL AND retry_of IS NOT NULL`,
    )
    .all(conversationId) as { retry_of: string }[];
  return new Set(rows.map((r) => r.retry_of));
}

/**
 * Break the conversation's eligible turns into contiguous seq-ranges, splitting
 * at every gap (a non-eligible turn — pinned, unfinished, too young, already
 * archived, retry-protected, or the excluded newest turn). Each contiguous run
 * of eligible turns becomes one segment candidate.
 */
function toContiguousRanges(
  conversationId: string,
  kind: string,
  eligible: Row[],
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

/**
 * Eligible ranges for ONE conversation.
 *   - automation: aged contiguous seq-ranges while the thread stays live, but
 *     NEVER the newest turn (max seq) — the eternal thread keeps its head.
 *   - chat/build: archive nothing unless the WHOLE conversation is idle
 *     (`updated_at < cutoff`) with no unfinished and no pinned turn; then all
 *     of its finished turns archive (the cold thread seals whole).
 * A pinned turn (a replay fixture) is never eligible and breaks the range.
 */
export function eligibleRangesForConversation(
  journal: DatabaseSync,
  head: ConversationHead,
  cutoffMs: number,
): EligibleRange[] {
  const turns = journal
    .prepare(`SELECT * FROM turns WHERE conversation_id = ? ORDER BY seq ASC`)
    .all(head.id) as Row[];
  if (turns.length === 0) return [];

  const newestSeq = turns[turns.length - 1]!.seq as number;
  const archived = archivedRanges(journal, head.id);
  const retryProtected = retryProtectedTurnIds(journal, head.id);
  const isAutomation = head.kind === 'automation';

  if (!isAutomation) {
    // chat/build: whole-conversation gate. Any pinned or unfinished turn, or a
    // conversation touched since the cutoff, keeps the entire thread live.
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

/**
 * Every conversation with at least one candidate range, bounded by
 * `maxConversations`. Automations idle-or-not are scanned (they archive aged
 * ranges); chat/build are pre-filtered to idle threads to keep the scan cheap.
 */
export function selectEligibleRanges(
  journal: DatabaseSync,
  cutoffMs: number,
  maxConversations: number,
): EligibleRange[] {
  // Automations are eternal (always "live"), so they are never idle-filtered;
  // chat/build only qualify once wholly idle. One pass over the heads, bounded.
  const heads = journal
    .prepare(
      `SELECT id, kind, updated_at FROM conversations
        WHERE kind = 'automation' OR updated_at < ?
        ORDER BY updated_at ASC`,
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
