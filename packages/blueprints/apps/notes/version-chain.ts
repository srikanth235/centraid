// A NOTE'S VERSION CHAIN IS ITS OWN OCCURRENCES (#996, ruling R20(a)).
//
// Walk `knowledge_note.current_revision_id` through `parent_revision_id`; each
// occurrence names the content that became current at that moment. THE CHAIN IS
// APPEND-ONLY: a restore appends a new head naming the body it brings back and
// nothing between is rewritten, which is why `current` is a position (index 0)
// and never a stored flag.
//
// It was a `revises` content→content link chain — a second history mechanism
// beside the one table [#916] ruled the only one — and it keyed a version by
// its CONTENT id, so a note that returned to a body it already held collapsed
// two versions into one node, and two notes with identical bodies shared one
// history. Shared by the web query handler and the phone so both seats read
// one spelling of the walk.

import type { VaultRow } from "./filing.ts";
import { decodeTextContent } from "./format.ts";
import type { NoteVersion } from "./types.ts";

/** A malformed chain terminates here; a well-formed one on a null parent. */
const MAX_CHAIN_STEPS = 500;

function text(row: VaultRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

export interface ChainRows {
  /** The note's current body, the answer when it has no occurrence yet. */
  headContentId: string;
  currentRevisionId: string | null;
  /** `core.entity_revision` rows; foreign ones are filtered here. */
  revisions: readonly VaultRow[];
  /** When given, only this note's occurrences are walked. */
  noteId?: string;
}

export interface NoteVersionChain {
  /** Head first, then each older body. */
  contentIds: readonly string[];
  /** The instant each version stopped being current — its occurrence's. */
  assertedAt: ReadonlyMap<string, string>;
}

export function noteVersionChain(rows: ChainRows): NoteVersionChain {
  const assertedAt = new Map<string, string>();
  if (!rows.headContentId) return { contentIds: [], assertedAt };

  const byId = new Map<string, VaultRow>();
  for (const revision of rows.revisions) {
    if (text(revision, "entity_type") !== "knowledge.note") continue;
    if (rows.noteId && text(revision, "entity_id") !== rows.noteId) continue;
    const id = text(revision, "revision_id");
    if (id) byId.set(id, revision);
  }

  const contentIds: string[] = [];
  const seen = new Set<string>();
  let at = rows.currentRevisionId;
  for (let step = 0; at && step < MAX_CHAIN_STEPS; step += 1) {
    if (seen.has(at)) break;
    seen.add(at);
    const revision = byId.get(at);
    if (!revision) break;
    const contentId = text(revision, "content_id");
    if (!contentId) break;
    contentIds.push(contentId);
    // A content id can appear twice; the date shown is that occurrence's.
    if (!assertedAt.has(contentId))
      assertedAt.set(contentId, text(revision, "recorded_at"));
    at = text(revision, "parent_revision_id") || null;
  }
  // A note minted before the wrapper carried a pointer still has one version:
  // the body it is currently made of. Honest absence, not a hole.
  if (contentIds.length === 0) contentIds.push(rows.headContentId);
  return { contentIds, assertedAt };
}

export interface VersionRows {
  chain: NoteVersionChain;
  contents: readonly VaultRow[];
  /** The note's own `created_at`, for the oldest body's date. */
  createdAt?: string;
}

/** An unreadable body is "", never invented text. */
export function projectNoteVersions(rows: VersionRows): NoteVersion[] {
  const byId = new Map(
    rows.contents.flatMap((content): Array<[string, VaultRow]> => {
      const id = text(content, "content_id");
      return id ? [[id, content]] : [];
    })
  );
  return rows.chain.contentIds.map((contentId, index) => {
    const content = byId.get(contentId);
    const dated =
      rows.chain.assertedAt.get(contentId) ??
      (content ? text(content, "created_at") : "");
    return {
      content_id: contentId,
      body: decodeTextContent(content?.["content_uri"]),
      current: index === 0,
      asserted_at: dated || rows.createdAt || "",
    };
  });
}
