// The version chain, read live off this device's replica (#821, #996 R20(a)).
//
// The ONE entity read behind it is `core.entity_revision` — the occurrences a
// document's `current_revision_id` chain walks. It used to be `core.link` plus
// `core.concept` plus `core.concept_scheme`, because the chain had to resolve a
// `revises` concept before it could follow an edge. The walk itself is
// `docs-versions.ts`, pure; this hook only feeds it rows and carries the
// honesty state so the screen can tell "no versions" apart from "could not read
// the history".

import { useMemo } from "react";

import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { projectVersionChain } from "./docs-versions";
import type { VersionChain } from "./docs-versions";

const APP_ID = "docs";

export interface UseVersionChainResult {
  chain: VersionChain | null;
  loading: boolean;
  /** The link read failed or was denied — the chain is UNKNOWN, not empty. */
  linksDenied: boolean;
  refresh: () => Promise<void>;
}

export function useVersionChain(documentId: string): UseVersionChainResult {
  const documents = useReplicaQuery(
    APP_ID,
    useMemo(() => ({ acceptTruncation: true, entity: "core.document" }), [])
  );
  const contents = useReplicaQuery(
    APP_ID,
    useMemo(() => ({ acceptTruncation: true, entity: "core.content_item" }), [])
  );
  const revisions = useReplicaQuery(
    APP_ID,
    useMemo(
      () => ({ acceptTruncation: true, entity: "core.entity_revision" }),
      []
    )
  );

  const linksDenied =
    revisions.error !== undefined || revisions.connection === "unavailable";
  const loading = documents.loading || contents.loading || revisions.loading;

  const chain = useMemo(() => {
    if (linksDenied) return null;
    return projectVersionChain({
      document: documents.rows.find((row) => row["document_id"] === documentId),
      revisions: revisions.rows,
      contents: contents.rows,
    });
  }, [documentId, linksDenied, documents.rows, revisions.rows, contents.rows]);

  const refresh = async (): Promise<void> => {
    await Promise.all([
      documents.refresh(),
      contents.refresh(),
      revisions.refresh(),
    ]);
  };

  return { chain, loading, linksDenied, refresh };
}
