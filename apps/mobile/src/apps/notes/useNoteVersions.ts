// A note's version chain, off this seat's own copy of the vault. Bodies are
// fetched only once the chain has named them (#996 wave 5, R8): the set is
// bounded by the chain, so the read is an `IN` over ids and never a window
// over the content table that would leave older bodies simply missing.

import { useMemo } from "react";

import { inList } from "@centraid/blueprints/apps/_shared/paged-reads";
import type { VaultRow } from "@centraid/blueprints/apps/notes/filing";
import type { NoteVersion } from "@centraid/blueprints/apps/notes/types";
import {
  noteVersionChain,
  projectNoteVersions,
} from "@centraid/blueprints/apps/notes/version-chain";
import type { PageQuery } from "@centraid/core/page";

import { useSeatPages } from "../../kit/hooks/useSeatPages";

export interface NoteVersionsInput {
  headContentId: string;
  /** The note's newest occurrence; null before it has one (#996, R20(a)). */
  currentRevisionId: string | null;
  noteId: string;
  createdAt: string;
  revisions: readonly VaultRow[];
}

export function useNoteVersions(note: NoteVersionsInput): NoteVersion[] {
  const chain = useMemo(
    () =>
      noteVersionChain({
        headContentId: note.headContentId,
        currentRevisionId: note.currentRevisionId,
        revisions: note.revisions,
        noteId: note.noteId,
      }),
    [note.currentRevisionId, note.headContentId, note.noteId, note.revisions]
  );
  const bodies = useSeatPages(
    "notes",
    useMemo((): PageQuery | undefined => {
      // A chain with no content behind it is a read that has not been made,
      // not an empty one; the hook holds `loading` for an absent statement.
      if (chain.contentIds.length === 0) return undefined;
      const fragment = inList("content_id", [...chain.contentIds]);
      return {
        name: "phone.notes.version-bodies",
        select: "content_id, content_uri, byte_size, created_at",
        from: "core_content_item",
        where: fragment.sql,
        bind: fragment.bind,
        order: {
          sortColumn: "content_id",
          pkColumn: "content_id",
          descending: false,
        },
      };
    }, [chain.contentIds]),
    { entity: "core.content_item", rowIdColumn: "content_id" }
  );
  return useMemo(
    () =>
      projectNoteVersions({
        chain,
        contents: bodies.rows,
        createdAt: note.createdAt,
      }),
    [bodies.rows, chain, note.createdAt]
  );
}
