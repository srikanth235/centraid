import { pruneCustodyProven, reclaimJournalPages } from "./prune.js";
import { archiveRange } from "./segment.js";
import { selectEligibleRanges } from "./selector.js";
import {
  DEFAULT_CONVERSATION_ARCHIVE_WINDOW_DAYS,
  DEFAULT_MAX_CONVERSATIONS_PER_RUN,
  DEFAULT_MAX_PRUNE_SEGMENTS_PER_RUN,
  windowCutoffMs,
} from "./types.js";
import type {
  ArchivedRange,
  ConversationArchivalDeps,
  ConversationArchivalOptions,
  ConversationArchivalResult,
  Row,
} from "./types.js";

export function runConversationArchival(
  deps: ConversationArchivalDeps,
  options: ConversationArchivalOptions = {}
): ConversationArchivalResult {
  const { journal, blobSink, custodyProven } = deps;
  const windowDays =
    options.windowDays ?? DEFAULT_CONVERSATION_ARCHIVE_WINDOW_DAYS;
  if (windowDays <= 0)
    throw new Error(
      "conversation archival window must be a positive number of days"
    );
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = windowCutoffMs(nowMs, windowDays);
  const maxConversations =
    options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS_PER_RUN;
  const maxPruneSegments =
    options.maxPruneSegments ?? DEFAULT_MAX_PRUNE_SEGMENTS_PER_RUN;

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
    journal.exec("BEGIN IMMEDIATE");
    try {
      const out = archiveRange(journal, blobSink, conv, range, nowMs);
      journal.exec("COMMIT");
      archived.push({
        conversationId: range.conversationId,
        seqFrom: range.seqFrom,
        seqTo: range.seqTo,
        segmentSha256: out.segmentSha256,
        turnCount: out.turnCount,
        itemCount: out.itemCount,
      });
      turnsArchived += out.turnCount;
    } catch (error) {
      journal.exec("ROLLBACK");
      throw error;
    }
  }

  const pruned = pruneCustodyProven(
    journal,
    custodyProven,
    nowMs,
    maxPruneSegments
  );
  const reclaim =
    pruned.segmentsPruned > 0
      ? reclaimJournalPages(journal)
      : { mode: reclaimModeOf(journal), ranVacuum: false };

  return {
    archived,
    segmentsWritten: archived.length,
    turnsArchived,
    segmentsPruned: pruned.segmentsPruned,
    turnsPruned: pruned.turnsPruned,
    reclaim,
  };
}

function reclaimModeOf(
  journal: ConversationArchivalDeps["journal"]
): "incremental" | "none" {
  const av = (
    journal.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
  ).auto_vacuum;
  return av === 2 ? "incremental" : "none";
}
