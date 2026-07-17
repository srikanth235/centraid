// The conversation-band archival engine entry (issue #438). One idempotent,
// bounded call runs BOTH phases each invocation:
//   Phase A — archive: seal cold turn-ranges into the vault blob CAS, index them
//             in conversation_archive, fold their rollups into conversation_digest.
//             NEVER deletes a raw row.
//   Phase B — prune: delete the raw turns of any archive segment whose custody is
//             proven, then reclaim freed pages. The custody latch (prune.ts) makes
//             prune-before-custody structurally impossible.
// Both phases no-op on a fresh vault (nothing is 90d idle), so a gateway that
// never served conversations is unaffected.

import { archiveRange } from './segment.js';
import { pruneCustodyProven, reclaimJournalPages } from './prune.js';
import { selectEligibleRanges } from './selector.js';
import {
  DEFAULT_CONVERSATION_ARCHIVE_WINDOW_DAYS,
  DEFAULT_MAX_CONVERSATIONS_PER_RUN,
  DEFAULT_MAX_PRUNE_SEGMENTS_PER_RUN,
  windowCutoffMs,
  type ArchivedRange,
  type ConversationArchivalDeps,
  type ConversationArchivalOptions,
  type ConversationArchivalResult,
  type Row,
} from './types.js';

export function runConversationArchival(
  deps: ConversationArchivalDeps,
  options: ConversationArchivalOptions = {},
): ConversationArchivalResult {
  const { journal, blobSink, custodyProven } = deps;
  const windowDays = options.windowDays ?? DEFAULT_CONVERSATION_ARCHIVE_WINDOW_DAYS;
  if (!(windowDays > 0))
    throw new Error('conversation archival window must be a positive number of days');
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = windowCutoffMs(nowMs, windowDays);
  const maxConversations = options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS_PER_RUN;
  const maxPruneSegments = options.maxPruneSegments ?? DEFAULT_MAX_PRUNE_SEGMENTS_PER_RUN;

  // ── Phase A — archive (never deletes) ────────────────────────────────
  const ranges = selectEligibleRanges(journal, cutoffMs, maxConversations);
  const archived: ArchivedRange[] = [];
  let turnsArchived = 0;
  const convCache = new Map<string, Row>();
  for (const range of ranges) {
    let conv = convCache.get(range.conversationId);
    if (!conv) {
      conv = journal
        .prepare(`SELECT * FROM conversations WHERE id = ?`)
        .get(range.conversationId) as Row | undefined;
      if (!conv) continue;
      convCache.set(range.conversationId, conv);
    }
    // Segment bytes ingest through the sink (idempotent by content address)
    // before the index/digest writes; both writes share one transaction so a
    // crash leaves neither a half-index nor a half-digest.
    journal.exec('BEGIN IMMEDIATE');
    try {
      const out = archiveRange(journal, blobSink, conv, range, nowMs);
      journal.exec('COMMIT');
      archived.push({
        conversationId: range.conversationId,
        seqFrom: range.seqFrom,
        seqTo: range.seqTo,
        segmentSha256: out.segmentSha256,
        turnCount: out.turnCount,
        itemCount: out.itemCount,
      });
      turnsArchived += out.turnCount;
    } catch (err) {
      journal.exec('ROLLBACK');
      throw err;
    }
  }

  // ── Phase B — custody-gated prune (separate phase, same call) ─────────
  const pruned = pruneCustodyProven(journal, custodyProven, nowMs, maxPruneSegments);
  const reclaim = pruned.segmentsPruned > 0 ? reclaimJournalPages(journal) : { mode: reclaimModeOf(journal), ranVacuum: false };

  return {
    archived,
    segmentsWritten: archived.length,
    turnsArchived,
    segmentsPruned: pruned.segmentsPruned,
    turnsPruned: pruned.turnsPruned,
    reclaim,
  };
}

function reclaimModeOf(journal: ConversationArchivalDeps['journal']): 'incremental' | 'full' | 'none' {
  const av = (journal.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum;
  return av === 2 ? 'incremental' : av === 1 ? 'full' : 'none';
}
