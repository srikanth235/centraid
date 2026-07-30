import { useMemo } from "react";

import {
  combineReplicaQueryStates,
  useReplicaQuery,
} from "../../kit/hooks/useReplicaQuery";
import { buildDrive } from "./docs-model";

export function useDocsLibrary() {
  const documents = useReplicaQuery(
    "docs",
    useMemo(() => ({ entity: "core.document" }), [])
  );
  const contents = useReplicaQuery(
    "docs",
    useMemo(() => ({ entity: "core.content_item" }), [])
  );
  const tags = useReplicaQuery(
    "docs",
    useMemo(() => ({ entity: "core.tag" }), [])
  );
  const concepts = useReplicaQuery(
    "docs",
    useMemo(() => ({ entity: "core.concept" }), [])
  );
  const schemes = useReplicaQuery(
    "docs",
    useMemo(() => ({ entity: "core.concept_scheme" }), [])
  );
  const custody = useReplicaQuery(
    "docs",
    useMemo(() => ({ entity: "blob.custody_state" }), [])
  );
  const queryState = combineReplicaQueryStates([
    documents,
    contents,
    tags,
    concepts,
    schemes,
    custody,
  ]);
  const drive = useMemo(
    () =>
      buildDrive(
        documents.rows,
        contents.rows,
        tags.rows,
        concepts.rows,
        schemes.rows,
        custody.rows
      ),
    [
      concepts.rows,
      contents.rows,
      custody.rows,
      documents.rows,
      schemes.rows,
      tags.rows,
    ]
  );
  const folderMetadata = useMemo(() => {
    const scheme = schemes.rows.find(
      (row) => row.uri === "https://centraid.dev/schemes/folders"
    );
    const root = concepts.rows.find(
      (row) =>
        row.scheme_id === scheme?.scheme_id && String(row.notation) === "root"
    );
    return {
      folderSchemeId: scheme?.scheme_id ? String(scheme.scheme_id) : undefined,
      rootFolderId: root?.concept_id ? String(root.concept_id) : undefined,
    };
  }, [concepts.rows, schemes.rows]);
  return { ...drive, ...folderMetadata, ...queryState };
}
