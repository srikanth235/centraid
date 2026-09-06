// A note's version chain, off this device's replica. Bodies are fetched only
// once the walk has named them: an unbounded `core.content_item` read is capped
// server-side at 1000 rows, so older bodies would simply be missing.

import { useMemo } from "react";

import type { VaultRow } from "@centraid/blueprints/apps/notes/filing";
import type { NoteVersion } from "@centraid/blueprints/apps/notes/types";
import {
  noteVersionChain,
  projectNoteVersions,
} from "@centraid/blueprints/apps/notes/version-chain";

import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";

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
  const bodies = useReplicaQuery(
    "notes",
    useMemo(
      () =>
        chain.contentIds.length === 0
          ? {
              entity: "core.content_item",
              where: [{ column: "content_id", op: "eq", value: "__none__" }],
              limit: 1,
            }
          : {
              entity: "core.content_item",
              where: [
                {
                  column: "content_id",
                  op: "in",
                  value: [...chain.contentIds],
                },
              ],
              limit: chain.contentIds.length,
            },
      [chain.contentIds]
    )
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
