// Lazy read-only rehydration of archived conversation history (issue #438
// decision 9, wave 3). When a conversation has archive-index rows whose
// turn-ranges were custody-gated-PRUNED (raw turns/items deleted, decision 3),
// the transcript render fetches each range's sealed segment blob from the vault
// CAS, gunzips + parses it, and folds the archived turns back in alongside the
// live rows — marked `fromArchive` so the surface renders a visible "from the
// archive" state. This NEVER writes to the ledger: the render is ephemeral,
// history stays sealed, and the archived turns are read-only (mutation paths
// keyed by turn id fail cleanly — the pruned rows simply no longer exist).

import { readArchivedConversationSegment } from './archive/index.js';
import {
  attachmentFromRaw,
  itemFromRaw,
  turnFromRaw,
  type RawAttachment,
  type RawItem,
  type RawTurn,
} from './store-sql.js';
import type { Attachment, Item, Turn } from './schema.js';

/**
 * Injectable read-back of an archived segment blob by content hash. The gateway
 * supplies the vault's `db.blobs.open` (local hit or remote fetch → unseal →
 * verify → promote to local); the standalone app-engine host has no blob
 * custody, so it leaves this undefined and rehydration degrades to the
 * `archiveUnavailable` marker. Resolves to the raw gzip bytes, or `null` when
 * the blob is absent; a throw signals a fetch failure (e.g. remote unreachable).
 */
export type ArchiveBlobReader = (sha: string) => Promise<Uint8Array | null>;

/** One archive-index row of a conversation (from `ConversationStore.listArchiveSegments`). */
export interface ArchiveSegmentRef {
  id: string;
  seqFrom: number;
  seqTo: number;
  segmentSha256: string;
  /** True once the range's raw turns were pruned — its blob must be fetched. */
  pruned: boolean;
}

/** Archived turns decoded from pruned segments, ready to merge with live rows. */
export interface ArchivedRows {
  /** Archived turn rows (mapped from the segment), any order — the caller sorts. */
  turns: Turn[];
  /** Archived items grouped by turn id, ordinal-ascending within each turn. */
  itemsByTurn: Map<string, Item[]>;
  /** Archived attachment rows grouped by their `message_in` item id. */
  attachmentsByItem: Map<string, Attachment[]>;
  /** The ids of every archived (read-only) turn — the transcript marks these. */
  turnIds: Set<string>;
  /**
   * True when at least one pruned segment could NOT be fetched/decoded (reader
   * missing, remote unreachable, or corrupt bytes). The caller surfaces this as
   * `archiveUnavailable` rather than silently rendering a partial thread.
   */
  unavailable: boolean;
}

/**
 * Fetch + decode every PRUNED segment for a conversation. Unpruned refs are
 * ignored (their raw rows are still live). Failures are collected into
 * `unavailable` and skipped — never thrown — so a rehydrated read degrades to
 * "live rows + a can't-load marker" instead of failing the whole transcript.
 */
export async function collectArchivedRows(
  reader: ArchiveBlobReader | undefined,
  prunedRefs: ArchiveSegmentRef[],
): Promise<ArchivedRows> {
  const out: ArchivedRows = {
    turns: [],
    itemsByTurn: new Map(),
    attachmentsByItem: new Map(),
    turnIds: new Set(),
    unavailable: false,
  };
  if (prunedRefs.length === 0) return out;
  // No custody door (standalone host) ⇒ nothing to fetch; mark unavailable.
  if (!reader) {
    out.unavailable = true;
    return out;
  }

  for (const ref of prunedRefs) {
    let bytes: Uint8Array | null;
    try {
      bytes = await reader(ref.segmentSha256);
    } catch {
      out.unavailable = true;
      continue;
    }
    if (!bytes) {
      out.unavailable = true;
      continue;
    }
    let segment: ReturnType<typeof readArchivedConversationSegment>;
    try {
      segment = readArchivedConversationSegment(Buffer.from(bytes));
    } catch {
      out.unavailable = true;
      continue;
    }
    for (const raw of segment.turns) {
      const t = turnFromRaw(raw as unknown as RawTurn);
      out.turns.push(t);
      out.turnIds.add(t.turnId);
    }
    for (const raw of segment.items) {
      const it = itemFromRaw(raw as unknown as RawItem);
      const list = out.itemsByTurn.get(it.turnId);
      if (list) list.push(it);
      else out.itemsByTurn.set(it.turnId, [it]);
    }
    for (const raw of segment.attachments) {
      const a = attachmentFromRaw(raw as unknown as RawAttachment);
      const list = out.attachmentsByItem.get(a.itemId);
      if (list) list.push(a);
      else out.attachmentsByItem.set(a.itemId, [a]);
    }
  }
  // Items are serialized `ORDER BY turn_id, ordinal`, but sort defensively so the
  // transcript fold sees each turn's items ordinal-ascending regardless.
  for (const list of out.itemsByTurn.values()) list.sort((x, y) => x.ordinal - y.ordinal);
  return out;
}
