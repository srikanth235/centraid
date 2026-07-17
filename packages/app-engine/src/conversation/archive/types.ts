// Conversation-band archival types + internal constants (issue #438, decisions
// 1-4). app-engine owns the conversation-ledger band of journal.db, so the
// archival engine lives here; the vault/gateway inject the two things only they
// hold — the blob CAS door (`blobSink`) and the custody-proven latch
// (`custodyProven`) — through the seams below. No user-facing knobs: every
// bound is an internal constant (five-metric discipline, #436 §6).

import type { DatabaseSync } from 'node:sqlite';

/**
 * Turns whose FINISH time is older than this many days are cold enough to
 * archive — the conversation analogue of the audit band's
 * `DEFAULT_JOURNAL_ARCHIVE_WINDOW_DAYS` (#367). Internal constant, not a knob.
 */
export const DEFAULT_CONVERSATION_ARCHIVE_WINDOW_DAYS = 90;

/** Per-invocation ceiling on conversations touched in phase A (bounded work). */
export const DEFAULT_MAX_CONVERSATIONS_PER_RUN = 200;

/** Per-invocation ceiling on archive rows pruned in phase B (bounded work). */
export const DEFAULT_MAX_PRUNE_SEGMENTS_PER_RUN = 200;

/** Segment envelope version — bumped only on a breaking shape change. */
export const CONVERSATION_SEGMENT_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** ms-epoch cutoff: a turn finished before this is past the window. */
export function windowCutoffMs(nowMs: number, windowDays: number): number {
  return nowMs - windowDays * DAY_MS;
}

/**
 * The vault blob CAS door the engine seals segments through (issue #438
 * decision 2 — the SAME CAS #367 segments use, so custody/replication/GC/
 * restore all come free). `db.blobs` satisfies this; `has` lets the engine
 * assert a segment actually landed locally before it writes the index row.
 */
export interface BlobSink {
  ingestSync(bytes: Buffer): { sha256: string; byteSize: number };
  has(sha: string): boolean;
}

/**
 * The custody-gate latch (issue #438 decision 3), supplied by the gateway from
 * vault primitives: remote tier configured ⇒ the segment sha is replicated AND
 * carries no pending outbox obligation; no remote tier ⇒ local CAS presence
 * suffices (#367 parity). Raw rows prune ONLY when this returns true — the
 * delete lives behind this check in one code path, so prune-before-custody is
 * structurally impossible.
 */
export type CustodyProven = (segmentSha256: string) => boolean;

export interface ConversationArchivalDeps {
  /** The vault's journal.db handle (holds the conversation-ledger band). */
  journal: DatabaseSync;
  blobSink: BlobSink;
  custodyProven: CustodyProven;
}

export interface ConversationArchivalOptions {
  /** Override "now" in ms epoch — tests only. */
  nowMs?: number;
  /** Turns finished older than this many days are eligible. Default 90. */
  windowDays?: number;
  /** Cap on conversations archived this run. Default 200. */
  maxConversations?: number;
  /** Cap on archive rows pruned this run. Default 200. */
  maxPruneSegments?: number;
}

/** One archive row written in phase A. */
export interface ArchivedRange {
  conversationId: string;
  seqFrom: number;
  seqTo: number;
  segmentSha256: string;
  turnCount: number;
  itemCount: number;
}

export interface ConversationArchivalResult {
  /** Phase A — ranges sealed into the CAS + indexed this run. */
  archived: ArchivedRange[];
  segmentsWritten: number;
  turnsArchived: number;
  /** Phase B — archive rows whose raw turns were custody-gated-deleted. */
  segmentsPruned: number;
  turnsPruned: number;
  reclaim: { mode: 'incremental' | 'full' | 'none'; ranVacuum: boolean };
}

/** A raw sqlite row (`SELECT *` shape) — stored verbatim in a segment. */
export type Row = Record<string, unknown>;

/**
 * The gzip(JSON) segment shape (issue #438 decision 1/4). Rows are stored
 * VERBATIM (`SELECT *`) — turns with their items and their attachment rows —
 * so a round-trip fetch decodes byte-identical source rows (wave 3 rehydration
 * reads this via `readArchivedConversationSegment`).
 */
export interface ArchivedConversationSegment {
  version: number;
  conversationId: string;
  /** The conversation row snapshot at archive time. */
  conversation: Row;
  seqFrom: number;
  seqTo: number;
  turns: Row[];
  items: Row[];
  attachments: Row[];
}
