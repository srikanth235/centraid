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
  const contents = useReplicaQuery(
    "notes",
    useMemo(() => ({ entity: "core.content_item" }), [])
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
