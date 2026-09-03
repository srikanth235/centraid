import { useMemo } from "react";

import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { projectVersionChain } from "./docs-versions";
import type { VersionChain } from "./docs-versions";

const APP_ID = "docs";

export interface UseVersionChainResult {
  chain: VersionChain | null;
  loading: boolean;
  linksDenied: boolean;
  refresh: () => Promise<void>;
}

export function useVersionChain(documentId: string): UseVersionChainResult {
  const documents = useReplicaQuery(
    APP_ID,
    useMemo(() => ({ entity: "core.document" }), [])
  );
  const contents = useReplicaQuery(
    APP_ID,
    useMemo(() => ({ entity: "core.content_item" }), [])
  );
  const links = useReplicaQuery(
    APP_ID,
    useMemo(() => ({ entity: "core.link" }), [])
  );
  const concepts = useReplicaQuery(
    APP_ID,
    useMemo(() => ({ entity: "core.concept" }), [])
  );
  const schemes = useReplicaQuery(
    APP_ID,
    useMemo(() => ({ entity: "core.concept_scheme" }), [])
  );

  const linksDenied =
    links.error !== undefined || links.connection === "unavailable";
  const loading =
    documents.loading ||
    contents.loading ||
    links.loading ||
    concepts.loading ||
    schemes.loading;

  const chain = useMemo(() => {
    if (linksDenied) return null;
    return projectVersionChain({
      document: documents.rows.find((row) => row["document_id"] === documentId),
      links: links.rows,
      contents: contents.rows,
      concepts: concepts.rows,
      schemes: schemes.rows,
    });
  }, [
    documentId,
    linksDenied,
    documents.rows,
    links.rows,
    contents.rows,
    concepts.rows,
    schemes.rows,
  ]);

  const refresh = async (): Promise<void> => {
    await Promise.all([
      documents.refresh(),
      contents.refresh(),
      links.refresh(),
      concepts.refresh(),
      schemes.refresh(),
    ]);
  };

  return { chain, loading, linksDenied, refresh };
}
