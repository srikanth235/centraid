import { useMemo } from "react";

import {
  combineReplicaQueryStates,
  useReplicaQuery,
} from "../../kit/hooks/useReplicaQuery";
import { buildNotes } from "./notes-model";

export function useNotes() {
  const notes = useReplicaQuery(
    "notes",
    useMemo(() => ({ entity: "knowledge.note" }), [])
  );
  // Bound the content_item read to the note body ids. An unbounded read is
  // capped at 1000 rows server-side, so at photo-scale vaults most note bodies
  // fall outside the window and render blank.
  const bodyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of notes.rows) {
      if (typeof row.body_content_id === "string" && row.body_content_id) {
        ids.add(row.body_content_id);
      }
    }
    return [...ids];
  }, [notes.rows]);
  const contents = useReplicaQuery(
    "notes",
    useMemo(
      () =>
        bodyIds.length === 0
          ? {
              entity: "core.content_item",
              where: [{ column: "content_id", op: "eq", value: "__none__" }],
              limit: 1,
            }
          : {
              entity: "core.content_item",
              where: [{ column: "content_id", op: "in", value: bodyIds }],
              limit: Math.max(bodyIds.length, 1),
            },
      [bodyIds]
    )
  );
  const links = useReplicaQuery(
    "notes",
    useMemo(() => ({ entity: "core.link" }), [])
  );
  const anchors = useReplicaQuery(
    "notes",
    useMemo(() => ({ entity: "core.link_anchor" }), [])
  );
  return {
    notes: useMemo(
      () => buildNotes(notes.rows, contents.rows, links.rows, anchors.rows),
      [anchors.rows, contents.rows, links.rows, notes.rows]
    ),
    ...combineReplicaQueryStates([notes, contents, links, anchors]),
  };
}
