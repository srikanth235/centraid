import { File, Paths } from "expo-file-system";
import * as Linking from "expo-linking";
import { useShareIntentContext } from "expo-share-intent";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert } from "react-native";

import {
  backupDeviceMedia,
  backupDocument,
} from "../../lib/upload/media-producer";
import OptionSheet from "../components/OptionSheet";
import { postStatus } from "../components/status-line";
import { useReplica } from "../replica/ReplicaProvider";
import {
  SHARE_UNPAIRED_MESSAGE,
  SHARE_UNPAIRED_TITLE,
  ShareIntentGate,
  discardShareIntentFiles,
  processShareIntent,
  shareTargetChoices,
  sweepStaleShareStaging,
} from "./share-ingest";
import type { ShareStagingEntry } from "./share-ingest";

/** Must match `ShareViewController.hostAppGroupIdentifier`. */
const SHARE_APP_GROUP = "group.dev.centraid.mobile";

/** Mirrors the settle path's source delete (`media-producer`). */
function deleteStagedFile(path: string): void {
  try {
    const file = new File(path);
    if (file.exists) file.delete();
  } catch {
    // A copy that resists deletion is swept at the next start.
  }
}

/** `undefined` on Android and on any iOS build without the share extension. */
function stagedEntries(): readonly ShareStagingEntry[] | undefined {
  try {
    const container = Paths.appleSharedContainers[SHARE_APP_GROUP];
    if (!container?.exists) return undefined;
    return container.list().map((entry) => ({
      uri: entry.uri,
      isFile: entry instanceof File,
      ...(entry instanceof File && entry.lastModified !== null
        ? { lastModifiedMs: entry.lastModified }
        : {}),
    }));
  } catch {
    return undefined;
  }
}

/** iOS share extension + Android share target converge on the one durable queue. */
export function ShareIntentIngest(): React.JSX.Element {
  const { hasShareIntent, shareIntent, resetShareIntent } =
    useShareIntentContext();
  const { gatewayBase, ready, scopes, session, vaultId } = useReplica();
  // One gate across renders: a re-render while an ingest is still in flight must
  // not spawn a second pass over the same files (#431). The memoized gate
  // has mount lifetime without a render-time ref read/write.
  const gate = useMemo(() => new ShareIntentGate(), []);
  const reviewing = useRef("");
  const [choosing, setChoosing] = useState(false);
  const chose = useRef(false);
  const choices = useMemo(() => shareTargetChoices(scopes ?? []), [scopes]);

  // A kill between staging and ingest leaves a copy nobody will claim (#880).
  useEffect(() => {
    sweepStaleShareStaging({
      stagedEntries,
      deleteStaged: deleteStagedFile,
      now: () => Date.now(),
    });
  }, []);

  const discard = useCallback(() => {
    discardShareIntentFiles(deleteStagedFile, shareIntent);
    reviewing.current = "";
    resetShareIntent();
  }, [resetShareIntent, shareIntent]);

  const ingest = useCallback(
    (targetVaultId?: string) => {
      if (!session || !gatewayBase) return;
      void gate
        .run(() =>
          processShareIntent(
            {
              backupDeviceMedia,
              backupDocument,
              fileSize: (path) => new File(path).size,
              reset: resetShareIntent,
              alert: (title, message) => postStatus(`${title}: ${message}`),
            },
            session,
            gatewayBase,
            shareIntent,
            targetVaultId
          )
        )
        .finally(() => {
          reviewing.current = "";
        });
    },
    [gate, gatewayBase, resetShareIntent, session, shareIntent]
  );

  useEffect(() => {
    if (!hasShareIntent) return;
    // "Not mounted yet" is not "not paired"; only the second is worth a word.
    if (!ready) return;
    if (!session || !gatewayBase) {
      // Files and text end the same way: nothing pending, nothing staged.
      discard();
      Alert.alert(SHARE_UNPAIRED_TITLE, SHARE_UNPAIRED_MESSAGE);
      return;
    }
    const files = shareIntent.files ?? [];
    if (files.length === 0) {
      const text = [shareIntent.text, shareIntent.webUrl]
        .filter((value): value is string => Boolean(value?.trim()))
        .join("\n")
        .trim();
      resetShareIntent();
      if (text)
        void Linking.openURL(
          `centraid://capture?text=${encodeURIComponent(text)}`
        );
      return;
    }
    const signature = files
      .map((file) => `${file.path}:${file.mimeType}:${file.size ?? ""}`)
      .join("|");
    if (reviewing.current === signature) return;
    reviewing.current = signature;
    const media = files.filter((file) =>
      /^(?:image|video|audio)\//u.test(file.mimeType)
    ).length;
    const documents = files.length - media;
    const summary = [
      media ? `${media} media item${media === 1 ? "" : "s"} → Photos` : "",
      documents
        ? `${documents} document${documents === 1 ? "" : "s"} → Docs`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const scanOption =
      files.length === 1 && files[0]?.mimeType.startsWith("image/")
        ? [
            {
              text: "Scan receipt",
              onPress: () => {
                const file = files[0];
                if (!file) return;
                reviewing.current = "";
                resetShareIntent();
                const query = new URLSearchParams({
                  fileUri: file.path,
                  fileName: file.fileName ?? "shared-receipt",
                  mediaType: file.mimeType,
                  plaintextSize: String(file.size ?? new File(file.path).size),
                  deleteSourceAfterSettle: "true",
                });
                void Linking.openURL(`centraid://scan?${query}`);
              },
            },
          ]
        : [];
    Alert.alert(
      "Review shared items",
      `${summary}\n\nNothing is saved until you confirm.`,
      [
        {
          text: "Cancel",
          style: "cancel",
          onPress: discard,
        },
        ...scanOption,
        {
          text: "Save",
          onPress: () => {
            if (choices.length > 0) {
              chose.current = false;
              setChoosing(true);
              return;
            }
            ingest(vaultId);
          },
        },
      ]
    );
  }, [
    choices,
    discard,
    gatewayBase,
    hasShareIntent,
    ingest,
    ready,
    resetShareIntent,
    session,
    shareIntent,
    vaultId,
  ]);

  return (
    <OptionSheet
      visible={choosing}
      title="Save to…"
      options={choices.map((choice) => ({
        id: choice.vaultId,
        label: choice.label,
        ...(choice.vaultId === vaultId ? { detail: "Focused vault" } : {}),
      }))}
      {...(vaultId ? { selectedId: vaultId } : {})}
      onSelect={(chosenVaultId) => {
        chose.current = true;
        ingest(chosenVaultId);
      }}
      onClose={() => {
        setChoosing(false);
        chose.current = false;
        // `OptionSheet` closes BEFORE it reports a choice, in the same tick, so
        // a dismissal is only real once that tick ends with no vault picked —
        // and abandoning leaves copies as unclaimed as Cancel does.
        queueMicrotask(() => {
          if (!chose.current) discard();
        });
      }}
    />
  );
}
