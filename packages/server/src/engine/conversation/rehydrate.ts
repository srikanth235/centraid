import { readArchivedConversationSegment } from "./archive/index.js";
import type { Attachment, Item, Turn } from "./schema.js";
import { attachmentFromRaw, itemFromRaw, turnFromRaw } from "./store-sql.js";
import type { RawAttachment, RawItem, RawTurn } from "./store-sql.js";

export type ArchiveBlobReader = (sha: string) => Promise<Uint8Array | null>;

export interface ArchiveSegmentRef {
  id: string;
  seqFrom: number;
  seqTo: number;
  segmentSha256: string;
  pruned: boolean;
}

export interface ArchivedRows {
  turns: Turn[];
  itemsByTurn: Map<string, Item[]>;
  attachmentsByItem: Map<string, Attachment[]>;
  turnIds: Set<string>;
  unavailable: boolean;
}

export async function collectArchivedRows(
  reader: ArchiveBlobReader | undefined,
  prunedRefs: ArchiveSegmentRef[]
): Promise<ArchivedRows> {
  const out: ArchivedRows = {
    turns: [],
    itemsByTurn: new Map(),
    attachmentsByItem: new Map(),
    turnIds: new Set(),
    unavailable: false,
  };
  if (prunedRefs.length === 0) return out;
  if (!reader) {
    out.unavailable = true;
    return out;
  }

  const segments = await Promise.all(
    prunedRefs.map(async (ref) => {
      try {
        const bytes = await reader(ref.segmentSha256);
        if (!bytes) return undefined;
        return readArchivedConversationSegment(Buffer.from(bytes));
      } catch {
        return undefined;
      }
    })
  );
  for (const segment of segments) {
    if (!segment) {
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
  for (const list of out.itemsByTurn.values())
    list.sort((x, y) => x.ordinal - y.ordinal);
  return out;
}
