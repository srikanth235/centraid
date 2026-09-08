// The version chain, read live off this phone's own copy (#821, #996 R20(a)).
//
// The ONE entity read behind it is `core.entity_revision` — the occurrences a
// document's `current_revision_id` chain walks. It used to be `core.link` plus
// `core.concept` plus `core.concept_scheme`, because the chain had to resolve a
// `revises` concept before it could follow an edge. The walk itself is
// `docs-versions.ts`, pure; this hook only feeds it rows and carries the
// honesty state so the screen can tell "no versions" apart from "could not read
// the history".
//
// FOUR TABLES, ONE DOCUMENT (#996 wave 4b). All four reads were
// the truncation flag over the whole table — every document in the vault
// to find one, every revision of every entity to walk one chain, and the entire
// library of bytes to size a handful of them. They are the document's own rows
// now: the document by its id, its revisions by `entity_id`, and the bytes and
// their representations by the content ids those revisions actually name. On a
// drive of a thousand documents that is four small reads instead of four
// libraries, and the chain it produces is identical.

import { useMemo } from "react";

import { inList } from "@centraid/blueprints/apps/_shared/paged-reads";
import type { PageQuery } from "@centraid/core/page";

import { useSeatPages } from "../../kit/hooks/useSeatPages";
import { projectVersionChain } from "./docs-versions";
import type { VersionChain } from "./docs-versions";

const APP_ID = "docs";

export interface UseVersionChainResult {
  chain: VersionChain | null;
  loading: boolean;
  /** The revision read failed or was denied — the chain is UNKNOWN, not empty. */
  linksDenied: boolean;
  refresh: () => Promise<void>;
}

export function useVersionChain(documentId: string): UseVersionChainResult {
  const documentQuery = useMemo<PageQuery>(
    () => ({
      name: "phone.docs.version-document",
      select:
        "document_id, title, current_content_id, current_revision_id, " +
        "created_at, updated_at",
      from: "core_document",
      where: "document_id = ?",
      bind: [documentId],
      order: {
        sortColumn: "document_id",
        pkColumn: "document_id",
        descending: false,
      },
    }),
    [documentId]
  );
  const documents = useSeatPages(APP_ID, documentQuery, {
    entity: "core.document",
    rowIdColumn: "document_id",
  });

  // This document's occurrences and no other entity's. `snapshot_json` is not
  // selected: the chain reads the occurrence's edges and its instant, and that
  // column is the whole row it was written from.
  const revisionQuery = useMemo<PageQuery>(
    () => ({
      name: "phone.docs.version-revisions",
      select:
        "revision_id, entity_type, entity_id, operation, content_id, " +
        "parent_revision_id, recorded_at",
      from: "core_entity_revision",
      where: "entity_type = ? AND entity_id = ?",
      bind: ["core.document", documentId],
      order: {
        sortColumn: "recorded_at",
        pkColumn: "revision_id",
        descending: false,
      },
    }),
    [documentId]
  );
  const revisions = useSeatPages(APP_ID, revisionQuery, {
    entity: "core.entity_revision",
    rowIdColumn: "revision_id",
  });

  // The bytes THIS chain names, and nothing else. `inList` refuses an empty
  // set rather than emitting `IN ()`, so the query is absent until the chain
  // has content ids — a read that has not been made, not an empty answer.
  const contentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of revisions.rows) {
      const id = row["content_id"];
      if (typeof id === "string") ids.add(id);
    }
    const current = documents.rows[0]?.["current_content_id"];
    if (typeof current === "string") ids.add(current);
    return [...ids].sort();
  }, [documents.rows, revisions.rows]);

  const contentQuery = useMemo<PageQuery | undefined>(() => {
    if (contentIds.length === 0) return undefined;
    const ids = inList("content_id", contentIds);
    return {
      name: "phone.docs.version-contents",
      select: "content_id, content_uri, sha256, byte_size, created_at",
      from: "core_content_item",
      where: ids.sql,
      bind: ids.bind,
      order: {
        sortColumn: "content_id",
        pkColumn: "content_id",
        descending: false,
      },
    };
  }, [contentIds]);
  const contents = useSeatPages(APP_ID, contentQuery, {
    entity: "core.content_item",
    rowIdColumn: "content_id",
  });

  // What the document reads its bytes as (#996, ruling R20(b)).
  const representationQuery = useMemo<PageQuery | undefined>(() => {
    if (contentIds.length === 0) return undefined;
    const ids = inList("content_id", contentIds);
    return {
      name: "phone.docs.version-representations",
      select:
        "representation_id, content_id, owner_type, owner_id, media_type, " +
        "charset, interpretation",
      from: "core_content_representation",
      where: ids.sql,
      bind: ids.bind,
      order: {
        sortColumn: "content_id",
        pkColumn: "representation_id",
        descending: false,
      },
    };
  }, [contentIds]);
  const representations = useSeatPages(APP_ID, representationQuery, {
    entity: "core.content_representation",
    rowIdColumn: "representation_id",
  });

  const linksDenied =
    revisions.error !== undefined || revisions.connection === "unavailable";
  const loading = documents.loading || revisions.loading;

  const chain = useMemo(() => {
    if (linksDenied) return null;
    return projectVersionChain({
      document: documents.rows[0],
      revisions: revisions.rows,
      contents: contents.rows,
      representations: representations.rows,
    });
  }, [
    linksDenied,
    documents.rows,
    revisions.rows,
    contents.rows,
    representations.rows,
  ]);

  const refresh = async (): Promise<void> => {
    await Promise.all([
      documents.refresh(),
      contents.refresh(),
      revisions.refresh(),
      representations.refresh(),
    ]);
  };

  return { chain, loading, linksDenied, refresh };
}
