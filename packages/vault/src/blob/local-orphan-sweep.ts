import type { DatabaseSync } from "node:sqlite";

import { conversationArchiveShas } from "../conversation-archive-roots.js";
import { archivedSegmentShas } from "../journal-archive.js";
import type { LocalBlobStore } from "./local.js";
import { OrphanTombstoneIndex } from "./orphan-tombstone.js";
import { liveBlobShasCached } from "./read.js";

export interface LocalOrphanSweepTarget {
  vault: DatabaseSync;
  audit: DatabaseSync;
  blobs: {
    local: Pick<LocalBlobStore, "listSync">;
    deleteLocalSync: (sha: string) => void;
  };
}

export interface LocalOrphanSweepOptions {
  graceWindowMs: number;
  now?: number;
  extraLiveRoots?: ReadonlySet<string>;
  maxEntries?: number;
  cursor?: string;
}

export interface LocalOrphanSweepResult {
  deleted: string[];
  graceHeld: string[];
  examined: number;
  nextCursor: string | null;
}

export function sweepLocalOrphans(
  db: LocalOrphanSweepTarget,
  options: LocalOrphanSweepOptions
): LocalOrphanSweepResult {
  const now = options.now ?? Date.now();
  const live = liveBlobShasCached(db.vault);
  const archived = archivedSegmentShas(db.audit);
  const conversation = conversationArchiveShas(db.audit);
  const isClaimed = (sha: string): boolean =>
    live.has(sha) ||
    archived.has(sha) ||
    conversation.has(sha) ||
    options.extraLiveRoots?.has(sha) === true;

  if (options.maxEntries !== undefined && options.maxEntries <= 0)
    throw new Error("local orphan sweep maxEntries must be > 0");
  const all = [...db.blobs.local.listSync()].sort();
  const cursor = options.cursor;
  const found = cursor === undefined ? 0 : all.findIndex((sha) => sha > cursor);
  const from = found < 0 ? all.length : found;
  const window =
    options.maxEntries === undefined
      ? all.slice(from)
      : all.slice(from, from + options.maxEntries);

  const tombstones = new OrphanTombstoneIndex(db.vault);
  const deleted: string[] = [];
  const graceHeld: string[] = [];
  for (const sha of window) {
    if (isClaimed(sha)) {
      tombstones.clear(sha);
      continue;
    }
    const firstOrphanedAt = tombstones.markFirstSeen(sha, now);
    if (now - firstOrphanedAt <= options.graceWindowMs) {
      graceHeld.push(sha);
      continue;
    }
    db.blobs.deleteLocalSync(sha);
    tombstones.clear(sha);
    deleted.push(sha);
  }
  const reachedEnd = from + window.length >= all.length;
  return {
    deleted,
    graceHeld,
    examined: window.length,
    nextCursor: reachedEnd ? null : (window[window.length - 1] as string),
  };
}
