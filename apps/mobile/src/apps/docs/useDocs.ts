// Docs read layer (#821): the drive from this device's replica, same shape
// as `usePeople`. SHARES ARE DECORATION, NEVER A FAILED DRIVE — denied share
// reads resolve to `shared_with: null` per row; CUSTODY likewise decorates.

import { useCallback, useMemo } from "react";

import type { ReplicaValue } from "@centraid/client/replica/native";

import {
  combineReplicaQueryStates,
  useReplicaQuery,
} from "../../kit/hooks/useReplicaQuery";
import type { ReplicaQueryState } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import type { NativeWriteResult } from "../../lib/replica/native-session";
import type { DocsShellNavigation } from "../../navigation";
import { projectDrive } from "./docs-projection";
import type { DriveProjection, MobileDriveDoc } from "./docs-projection";

const APP_ID = "docs";

function useDocsEntity(entity: string): ReplicaQueryState {
  return useReplicaQuery(
    APP_ID,
    useMemo(() => ({ entity }), [entity])
  );
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
  const documents = useDocsEntity("core.document");
  const contents = useDocsEntity("core.content_item");
  const tags = useDocsEntity("core.tag");
  const concepts = useDocsEntity("core.concept");
  const schemes = useDocsEntity("core.concept_scheme");
  // Decoration reads — never fail the drive; see header.
  const custody = useDocsEntity("blob.custody_state");
  const grants = useDocsEntity("share.circle_grant");
  const circles = useDocsEntity("social.circle");
  const members = useDocsEntity("social.circle_member");
  const states = useDocsEntity("share.commons_member_state");
  const parties = useDocsEntity("core.party");

  const queryState = combineReplicaQueryStates([
    documents,
    contents,
    tags,
    concepts,
    schemes,
  ]);

  const shareQueries = [grants, circles, members, states, parties];
  const sharesDenied = shareQueries.some(
    (query) => query.error !== undefined || query.connection === "unavailable"
  );
  const sharesLoading = shareQueries.some((query) => query.loading);

  const projection = useMemo(
    () =>
      projectDrive({
        documents: documents.rows,
        contents: contents.rows,
        tags: tags.rows,
        concepts: concepts.rows,
        schemes: schemes.rows,
        custody: custody.error ? [] : custody.rows,
        shares:
          sharesDenied || sharesLoading
            ? null
            : {
                grants: grants.rows,
                circles: circles.rows,
                members: members.rows,
                states: states.rows,
                parties: parties.rows,
              },
      }),
    [
      documents.rows,
      contents.rows,
      tags.rows,
      concepts.rows,
      schemes.rows,
      custody.error,
      custody.rows,
      sharesDenied,
      sharesLoading,
      grants.rows,
      circles.rows,
      members.rows,
      states.rows,
      parties.rows,
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
      grants.refresh(),
      circles.refresh(),
      members.refresh(),
      states.refresh(),
      parties.refresh(),
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
