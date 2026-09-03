import type { DatabaseSync } from "node:sqlite";

export const DEFAULT_CONVERSATION_ARCHIVE_WINDOW_DAYS = 90;

export const DEFAULT_MAX_CONVERSATIONS_PER_RUN = 200;
export const DEFAULT_MAX_PRUNE_SEGMENTS_PER_RUN = 200;

export const CONVERSATION_SEGMENT_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

export function windowCutoffMs(nowMs: number, windowDays: number): number {
  return nowMs - windowDays * DAY_MS;
}

export interface BlobSink {
  ingestSync: (bytes: Buffer) => { sha256: string; byteSize: number };
  has: (sha: string) => boolean;
}

export type CustodyProven = (segmentSha256: string) => boolean;

export interface ConversationArchivalDeps {
  journal: DatabaseSync;
  blobSink: BlobSink;
  custodyProven: CustodyProven;
}

export interface ConversationArchivalOptions {
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

export type Row = Record<string, unknown>;

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
