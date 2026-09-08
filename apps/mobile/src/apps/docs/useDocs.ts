// Docs read layer (#821): the drive from this device's replica, same shape
// as `usePeople`. SHARES ARE DECORATION, NEVER A FAILED DRIVE — denied share
// reads resolve to `shared_with: null` per row; CUSTODY likewise decorates.

import { useCallback, useMemo } from "react";

import type { ReplicaValue } from "@centraid/client/replica/native";
import type { PageQuery } from "@centraid/core/page";

import { combineReplicaQueryStates } from "../../kit/hooks/useReplicaQuery";
import type { ReplicaQueryState } from "../../kit/hooks/useReplicaQuery";
import { useSeatPages } from "../../kit/hooks/useSeatPages";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import type { NativeWriteResult } from "../../lib/replica/native-session";
import type { DocsShellNavigation } from "../../navigation";
import { projectDrive } from "./docs-projection";
import type { DriveProjection, MobileDriveDoc } from "./docs-projection";
import {
  DOCS_AUTHORITIES,
  DOCS_BINDINGS,
  DOCS_CIRCLES,
  DOCS_CIRCLE_MEMBERS,
  DOCS_CONCEPTS,
  DOCS_CONTENTS,
  DOCS_CUSTODY,
  DOCS_DOCUMENTS,
  DOCS_FULFILLMENTS,
  DOCS_LINEAGE,
  DOCS_PARTIES,
  DOCS_REPRESENTATIONS,
  DOCS_SCHEMES,
  DOCS_SUBSCRIPTIONS,
  DOCS_TAGS,
} from "./docs-queries";

const APP_ID = "docs";

/**
 * One of the drive's fifteen reads, walked to the end of its set (#996 wave
 * 4b). Every one of them declared `acceptTruncation` before: the whole table,
 * cut off at whatever window the reader had. `docs-queries.ts` states which
 * rows and which columns instead, and the walk states where it stops.
 */
function useDocsRead(
  query: PageQuery,
  entity: string,
  rowIdColumn: string
): ReplicaQueryState {
  return useSeatPages(APP_ID, query, { entity, rowIdColumn });
}

export interface UseDocsResult extends DriveProjection {
  loading: boolean;
  connection: ReplicaQueryState["connection"];
  error?: string;
  unavailableReason?: string;
  offline: boolean;
  refresh: () => Promise<void>;
}

export function useDocs(): UseDocsResult {
  const documents = useDocsRead(DOCS_DOCUMENTS, "core.document", "document_id");
  const contents = useDocsRead(
    DOCS_CONTENTS,
    "core.content_item",
    "content_id"
  );
  const representations = useDocsRead(
    DOCS_REPRESENTATIONS,
    "core.content_representation",
    "representation_id"
  );
  const tags = useDocsRead(DOCS_TAGS, "core.tag", "tag_id");
  const concepts = useDocsRead(DOCS_CONCEPTS, "core.concept", "concept_id");
  const schemes = useDocsRead(DOCS_SCHEMES, "core.concept_scheme", "scheme_id");
  // Decoration reads — never fail the drive; see header.
  const custody = useDocsRead(DOCS_CUSTODY, "blob.custody_state", "content_id");
  const answers = useDocsRead(
    DOCS_AUTHORITIES,
    "share.authority",
    "authority_id"
  );
  const circles = useDocsRead(DOCS_CIRCLES, "social.circle", "circle_id");
  const members = useDocsRead(
    DOCS_CIRCLE_MEMBERS,
    "social.circle_member",
    "member_id"
  );
  const fulfillments = useDocsRead(
    DOCS_FULFILLMENTS,
    "share.fulfillment",
    "grant_id"
  );
  const parties = useDocsRead(DOCS_PARTIES, "core.party", "party_id");
  // Which shapes this vault subscribes to, and which rows each one placed.
  // Decoration on every other shelf; on Shared it IS the shelf, which is why
  // its read has to answer separately from the outbound share join above.
  const subscriptions = useDocsRead(
    DOCS_SUBSCRIPTIONS,
    "share.subscription",
    "authority_id"
  );
  const lineage = useDocsRead(
    DOCS_LINEAGE,
    "share.subscription_lineage",
    "authority_id"
  );
  const bindings = useDocsRead(
    DOCS_BINDINGS,
    "share.party_vault_binding",
    "binding_id"
  );

  const queryState = combineReplicaQueryStates([
    documents,
    contents,
    representations,
    tags,
    concepts,
    schemes,
  ]);

  const originQueries = [subscriptions, lineage, bindings, parties];
  const originsDenied = originQueries.some(
    (query) => query.error !== undefined || query.connection === "unavailable"
  );
  const originsLoading = originQueries.some((query) => query.loading);

  const shareQueries = [
    answers,
    circles,
    members,
    fulfillments,
    bindings,
    parties,
  ];
  const sharesDenied = shareQueries.some(
    (query) => query.error !== undefined || query.connection === "unavailable"
  );
  const sharesLoading = shareQueries.some((query) => query.loading);

  const projection = useMemo(
    () =>
      projectDrive({
        documents: documents.rows,
        contents: contents.rows,
        representations: representations.rows,
        tags: tags.rows,
        concepts: concepts.rows,
        schemes: schemes.rows,
        custody: custody.error ? [] : custody.rows,
        shares:
          sharesDenied || sharesLoading
            ? null
            : {
                answers: answers.rows,
                circles: circles.rows,
                members: members.rows,
                fulfillments: fulfillments.rows,
                bindings: bindings.rows,
                parties: parties.rows,
              },
        origins:
          originsDenied || originsLoading
            ? null
            : {
                subscriptions: subscriptions.rows,
                lineage: lineage.rows,
                bindings: bindings.rows,
                parties: parties.rows,
              },
      }),
    [
      documents.rows,
      contents.rows,
      representations.rows,
      tags.rows,
      concepts.rows,
      schemes.rows,
      custody.error,
      custody.rows,
      sharesDenied,
      sharesLoading,
      answers.rows,
      circles.rows,
      members.rows,
      fulfillments.rows,
      parties.rows,
      originsDenied,
      originsLoading,
      subscriptions.rows,
      lineage.rows,
      bindings.rows,
    ]
  );

  // Plain function: react-compiler memoizes the hook result; a manual
  // dependency list over eleven query objects would only go stale.
  const refresh = async (): Promise<void> => {
    await Promise.all([
      documents.refresh(),
      contents.refresh(),
      tags.refresh(),
      concepts.refresh(),
      schemes.refresh(),
      custody.refresh(),
      answers.refresh(),
      circles.refresh(),
      members.refresh(),
      fulfillments.refresh(),
      parties.refresh(),
      subscriptions.refresh(),
      lineage.refresh(),
      bindings.refresh(),
    ]);
  };

  return {
    ...projection,
    loading: queryState.loading,
    connection: queryState.connection,
    ...(queryState.error ? { error: queryState.error } : {}),
    ...(queryState.unavailableReason
      ? { unavailableReason: queryState.unavailableReason }
      : {}),
    offline: queryState.connection === "offline",
    refresh,
  };
}

/** One document = a selector over the list-shaped drive; siblings take this. */
export interface UseDocumentResult {
  doc: MobileDriveDoc | undefined;
  loading: boolean;
  connection: ReplicaQueryState["connection"];
  error?: string;
  offline: boolean;
  refresh: () => Promise<void>;
}

export function useDocument(documentId: string): UseDocumentResult {
  const drive = useDocs();
  const doc = useMemo(
    () => drive.documents.find((row) => row.document_id === documentId),
    [drive.documents, documentId]
  );
  return {
    doc,
    loading: drive.loading,
    connection: drive.connection,
    ...(drive.error ? { error: drive.error } : {}),
    offline: drive.offline,
    refresh: drive.refresh,
  };
}

/** Sole Docs write door (`session.write` + outcome surfacing); result only on continuable outcomes. */
export type DocsWrite = (
  action: string,
  input: Record<string, ReplicaValue>
) => Promise<NativeWriteResult | undefined>;

export function useDocsWrite(navigation: DocsShellNavigation): DocsWrite {
  const { session } = useReplica();
  return useCallback(
    async (action, input) => {
      if (!session) return undefined;
      try {
        const result = await session.write(APP_ID, { action, input });
        if (
          !surfaceWriteOutcome(result, {
            onParked: () =>
              navigation.navigate("Settings", { screen: "Approvals" }),
            queuedMessage: "This Docs change will sync automatically.",
          })
        )
          return undefined;
        return result;
      } catch (error) {
        surfaceWriteFailure(error, "Docs change failed");
        return undefined;
      }
    },
    [navigation, session]
  );
}
