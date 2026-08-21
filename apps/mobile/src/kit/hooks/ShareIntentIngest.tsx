import { File } from "expo-file-system";
import * as Linking from "expo-linking";
import { useShareIntentContext } from "expo-share-intent";
import { useEffect, useMemo, useRef } from "react";
import { Alert } from "react-native";

import {
  backupDeviceMedia,
  backupDocument,
} from "../../lib/upload/media-producer";
import { postStatus } from "../components/status-line";
import { useReplica } from "../replica/ReplicaProvider";
import { ShareIntentGate, processShareIntent } from "./share-ingest";

/** iOS share extension + Android share target converge on the one durable queue. */
export function ShareIntentIngest(): null {
  const { hasShareIntent, shareIntent, resetShareIntent } =
    useShareIntentContext();
  const { session, gatewayBase, vaultId } = useReplica();
  // One gate across renders: a re-render while an ingest is still in flight must
  // not spawn a second pass over the same files (#431 F9). The memoized gate
  // has mount lifetime without a render-time ref read/write.
  const gate = useMemo(() => new ShareIntentGate(), []);
  const reviewing = useRef("");
  useEffect(() => {
    if (!hasShareIntent) return;
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
    if (!session || !gatewayBase) return;
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
          onPress: () => {
            reviewing.current = "";
            resetShareIntent();
          },
        },
        ...scanOption,
        {
          text: "Save",
          onPress: () => {
            void gate
              .run(() =>
                processShareIntent(
                  {
                    backupDeviceMedia,
                    backupDocument,
                    fileSize: (path) => new File(path).size,
                    reset: resetShareIntent,
                    alert: (title, message) =>
                      postStatus(`${title}: ${message}`),
                  },
                  session,
                  gatewayBase,
                  shareIntent,
                  vaultId
                )
              )
              .finally(() => {
                reviewing.current = "";
              });
          },
        },
      ]
    );
  }, [
    gate,
    gatewayBase,
    hasShareIntent,
    resetShareIntent,
    session,
    shareIntent,
    vaultId,
  ]);
  return null;
}
