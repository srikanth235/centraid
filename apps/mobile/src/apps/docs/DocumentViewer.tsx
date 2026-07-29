import { Feather } from "@expo/vector-icons";
import { File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import * as Sharing from "expo-sharing";
import { VideoView, useVideoPlayer } from "expo-video";
import React, { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import OptionSheet from "../../kit/components/OptionSheet";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { family, useTheme } from "../../kit/theme";
import { authHeader } from "../../lib/gateway";
import type { NativeOptimisticMutation } from "../../lib/replica/native-session";
import {
  optimisticRowId,
  optimisticValues,
} from "../../lib/replica/optimistic";
import type { DocsScreenProps } from "../../navigation";
import type { NativeDocument } from "./docs-model";
import { useDocsLibrary } from "./useDocsLibrary";

function StreamViewer({
  source,
}: {
  source: { uri: string; headers: Record<string, string> };
}): React.JSX.Element {
  const player = useVideoPlayer(source);
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      style={styles.viewer}
    />
  );
}

function Viewer({
  document,
  url,
}: {
  document: NativeDocument;
  url: string;
}): React.JSX.Element {
  const source = { uri: url, headers: authHeader() };
  if (document.mediaType.startsWith("image/"))
    return <Image source={source} contentFit="contain" style={styles.viewer} />;
  if (
    document.mediaType.startsWith("video/") ||
    document.mediaType.startsWith("audio/")
  )
    return <StreamViewer source={source} />;
  return (
    <WebView source={source} style={styles.viewer} allowsInlineMediaPlayback />
  );
}

export default function DocumentViewer({
  route,
  navigation,
}: DocsScreenProps<"DocumentViewer">): React.JSX.Element {
  const { colors } = useTheme();
  const { session, gatewayBase, scopes = [] } = useReplica();
  const [placementKind, setPlacementKind] = useState<"add" | "move">();
  const drive = useDocsLibrary();
  const document = drive.documents.find(
    (item) => item.id === route.params.documentId
  );
  const url =
    document && gatewayBase
      ? `${gatewayBase}/centraid/_gateway/blobs/${encodeURIComponent(
          document.sourceVaultId ?? ""
        )}/${encodeURIComponent(document.contentId)}${document.mediaType.startsWith("image/") || document.mediaType === "application/pdf" ? "?variant=preview" : ""}`
      : "";
  const action = async (name: string): Promise<void> => {
    if (
      !document ||
      !session ||
      document.canWrite !== true ||
      !document.sourceVaultId
    )
      return;
    try {
      const now = new Date().toISOString();
      const optimistic: NativeOptimisticMutation[] =
        name === "trash" && document.raw
          ? [
              {
                op: "upsert",
                entity: "core.document",
                rowId: document.rawId ?? document.id,
                values: optimisticValues(document.raw, {
                  deleted_at: now,
                  updated_at: now,
                }),
              },
            ]
          : name === "unstar" && document.starTag
            ? [
                {
                  op: "delete",
                  entity: "core.tag",
                  rowId: String(document.starTag.tag_id),
                },
              ]
            : name === "star" && document.starredConceptId
              ? (() => {
                  const tagId = optimisticRowId("star");
                  return [
                    {
                      op: "upsert" as const,
                      entity: "core.tag",
                      rowId: tagId,
                      values: {
                        tag_id: tagId,
                        target_type: "core.document",
                        target_id: document.rawId ?? document.id,
                        concept_id: document.starredConceptId,
                        tagged_by_party_id: null,
                        confidence: null,
                        tagged_at: now,
                      },
                    },
                  ];
                })()
              : [];
      const write = {
        action: name,
        input: { document_id: document.rawId ?? document.id },
        optimistic,
      };
      const result = await session.writeTo(
        document.sourceVaultId,
        "docs",
        write
      );
      // A parked write (e.g. moving to trash is medium-risk) must surface for
      // Approve/Discard rather than silently vanish (M5); denials/failures are
      // shown, not swallowed.
      if (result.status === "parked") {
        navigation.navigate("Settings", { screen: "Approvals" });
      } else if (result.status === "queued") {
        Alert.alert(
          "Saved offline",
          "This change will sync automatically when the gateway reconnects."
        );
      } else if (result.status === "denied" || result.status === "failed") {
        Alert.alert(
          "Not applied",
          result.reason ?? "The vault rejected this change."
        );
      }
    } catch (error) {
      Alert.alert(
        "Action failed",
        error instanceof Error ? error.message : "Please try again."
      );
    }
  };
  const place = async (targetVaultId: string): Promise<void> => {
    const kind = placementKind;
    setPlacementKind(undefined);
    if (!kind || !document?.sourceVaultId || !session) return;
    const result = await session.place({
      kind,
      itemType: "core.document",
      itemId: document.rawId ?? document.id,
      sourceVaultId: document.sourceVaultId,
      targetVaultId,
    });
    Alert.alert(
      result.status === "executed" ? "Placement complete" : "Placement queued",
      result.reason ??
        (result.status === "executed"
          ? "The document is available in the selected vault."
          : "It will resume automatically when the gateway is reachable.")
    );
  };
  const share = async (): Promise<void> => {
    if (!document || !url) return;
    const file = await File.downloadFileAsync(
      url.replace("?variant=preview", ""),
      new File(Paths.cache, document.title),
      { headers: authHeader(), idempotent: true }
    );
    if (await Sharing.isAvailableAsync())
      await Sharing.shareAsync(file.uri, { mimeType: document.mediaType });
  };
  if (!document)
    return <View style={[styles.viewer, { backgroundColor: colors.bg }]} />;
  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.bg }]}
      edges={["top", "bottom"]}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to documents"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Feather name="chevron-left" size={26} color={colors.ink} />
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: colors.ink }]}>
          {document.title}
        </Text>
        <Pressable
          accessibilityLabel={`Share ${document.title}`}
          accessibilityRole="button"
          onPress={() => void share()}
        >
          <Feather name="share" size={21} color={colors.accent} />
        </Pressable>
      </View>
      <Viewer document={document} url={url} />
      <View style={[styles.toolbar, { borderTopColor: colors.line }]}>
        <Pressable
          accessibilityLabel={
            document.starred ? "Remove document star" : "Star document"
          }
          accessibilityRole="button"
          accessibilityState={{
            disabled: document.canWrite !== true,
            selected: document.starred,
          }}
          disabled={document.canWrite !== true}
          onPress={() => void action(document.starred ? "unstar" : "star")}
        >
          <Feather
            name="star"
            size={21}
            color={
              document.canWrite === true
                ? document.starred
                  ? "#d99b18"
                  : colors.ink2
                : colors.ink3
            }
          />
        </Pressable>
        <Text style={[styles.meta, { color: colors.ink2 }]}>
          {document.scopeLabels?.join(" · ") ?? "Vault"} · {document.mediaType}{" "}
          · {document.custody ?? "local"}
        </Text>
        <Pressable
          accessibilityLabel="Add document to another vault"
          accessibilityRole="button"
          onPress={() => setPlacementKind("add")}
        >
          <Feather name="copy" size={20} color={colors.accent} />
        </Pressable>
        <Pressable
          accessibilityLabel="Move document to another vault"
          accessibilityRole="button"
          accessibilityState={{ disabled: document.canWrite !== true }}
          disabled={document.canWrite !== true}
          onPress={() => setPlacementKind("move")}
        >
          <Feather
            name="folder-plus"
            size={20}
            color={document.canWrite === true ? colors.accent : colors.ink3}
          />
        </Pressable>
        <Pressable
          accessibilityLabel="Move document to trash"
          accessibilityRole="button"
          accessibilityState={{ disabled: document.canWrite !== true }}
          disabled={document.canWrite !== true}
          onPress={() =>
            Alert.alert(
              "Move to trash?",
              "The current document and its version history remain restorable until vault purge.",
              [
                { text: "Cancel" },
                {
                  text: "Trash",
                  style: "destructive",
                  onPress: () => void action("trash"),
                },
              ]
            )
          }
        >
          <Feather
            name="trash-2"
            size={20}
            color={document.canWrite === true ? colors.danger : colors.ink3}
          />
        </Pressable>
      </View>
      <OptionSheet
        visible={placementKind !== undefined}
        title={`${placementKind === "move" ? "Move" : "Add"} to…`}
        options={scopes
          .filter(
            (scope) =>
              scope.role !== "read" &&
              !document.scopeIds?.includes(scope.vaultId)
          )
          .map((scope) => ({
            id: scope.vaultId,
            label: scope.label,
            detail:
              placementKind === "move"
                ? "Target commits before source removal"
                : "Keep in both vaults",
          }))}
        onSelect={(vaultId) => void place(vaultId)}
        onClose={() => setPlacementKind(undefined)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    minHeight: 50,
    paddingHorizontal: 14,
  },
  meta: {
    flex: 1,
    fontFamily: family.sansRegular,
    fontSize: 11,
    textAlign: "center",
  },
  safe: { flex: 1 },
  title: { flex: 1, fontFamily: family.sansBold, fontSize: 15 },
  toolbar: {
    alignItems: "center",
    borderTopWidth: 1,
    flexDirection: "row",
    height: 52,
    justifyContent: "space-between",
    paddingHorizontal: 22,
  },
  viewer: { flex: 1 },
});
