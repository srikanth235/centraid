// Conversation archival types (#438). Inject `blobSink` + `custodyProven`.
// No user-facing knobs — every bound is an internal constant (#436 §6).

import type { DatabaseSync } from "node:sqlite";

/** Not a knob. */
export const DEFAULT_CONVERSATION_ARCHIVE_WINDOW_DAYS = 90;

export const DEFAULT_MAX_CONVERSATIONS_PER_RUN = 200;
export const DEFAULT_MAX_PRUNE_SEGMENTS_PER_RUN = 200;

/** Envelope version — bump only on a breaking shape change. */
export const CONVERSATION_SEGMENT_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

export function windowCutoffMs(nowMs: number, windowDays: number): number {
  return nowMs - windowDays * DAY_MS;
}

/**
 * Vault blob CAS door (#438 d2 — same CAS as #367). `has` must pass before
 * writing the index row.
 */
export interface BlobSink {
  ingestSync: (bytes: Buffer) => { sha256: string; byteSize: number };
  has: (sha: string) => boolean;
}

/**
 * Custody-gate latch (#438 d3). Remote tier ⇒ replicated and no pending outbox;
 * else local CAS presence. Raw rows prune ONLY when this is true.
 */
export type CustodyProven = (segmentSha256: string) => boolean;

export interface ConversationArchivalDeps {
  journal: DatabaseSync;
  blobSink: BlobSink;
  custodyProven: CustodyProven;
}

export interface ConversationArchivalOptions {
  /** Override "now" in ms epoch — tests only. */
  nowMs?: number;
  windowDays?: number;
  maxConversations?: number;
  maxPruneSegments?: number;
}

export interface ArchivedRange {
  conversationId: string;
  seqFrom: number;
  seqTo: number;
  segmentSha256: string;
  turnCount: number;
  itemCount: number;
}

export interface ConversationArchivalResult {
  archived: ArchivedRange[];
  segmentsWritten: number;
  turnsArchived: number;
  segmentsPruned: number;
  turnsPruned: number;
  reclaim: { mode: "incremental" | "none"; ranVacuum: boolean };
}

/** Raw sqlite `SELECT *` row — stored verbatim in a segment. */
export type Row = Record<string, unknown>;

/**
 * gzip(JSON) segment (#438 d1/d4). Rows are VERBATIM `SELECT *` so a
 * round-trip decodes byte-identical source (`readArchivedConversationSegment`).
 */
export interface ArchivedConversationSegment {
  version: number;
  conversationId: string;
  conversation: Row;
  seqFrom: number;
  seqTo: number;
  turns: Row[];
  items: Row[];
  attachments: Row[];
}
