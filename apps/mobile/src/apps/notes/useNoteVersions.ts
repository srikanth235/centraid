// A note's version chain, read live off this device's replica (#882).
//
// The `revises` edges, the concepts and the schemes are the ones the cover
// already holds — read once, not a second time per open note. Only the chain's
// own bodies are fetched here, and only once the walk has named them: an
// unbounded `core.content_item` read is capped server-side at 1000 rows, so on
// a large vault the older bodies would simply be missing. The walk itself is
// the blueprint's `noteVersionChain`, shared with the gateway's history query.

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
  createdAt: string;
  links: readonly VaultRow[];
  concepts: readonly VaultRow[];
  schemes: readonly VaultRow[];
}

export function useNoteVersions(note: NoteVersionsInput): NoteVersion[] {
  const chain = useMemo(
    () =>
      noteVersionChain({
        headContentId: note.headContentId,
        links: note.links,
        concepts: note.concepts,
        schemes: note.schemes,
      }),
    [note.concepts, note.headContentId, note.links, note.schemes]
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
