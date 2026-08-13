import { File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import * as Sharing from "expo-sharing";
import { VideoView, useVideoPlayer } from "expo-video";
import React, { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import OptionSheet from "../../kit/components/OptionSheet";
import { postStatus } from "../../kit/components/status-line";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { family, useTheme, t } from "../../kit/theme";
import { authHeader } from "../../lib/gateway";
import {
  listCommonsResidents,
  retainCommonsItem,
} from "../../lib/replica/placement-transport";
import type { DocsScreenProps } from "../../navigation";
import { custodySentence } from "./docs-custody";
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
  const ownVault = scopes.find(
    (scope) => scope.personal === true && scope.canWrite
  );
  const [residentDocumentId, setResidentDocumentId] = useState<string>();
  const currentDocumentId = document?.rawId ?? document?.id;
  const commonsResident = Boolean(
    currentDocumentId && residentDocumentId === currentDocumentId
  );
  useEffect(() => {
    let active = true;
    const actorVaultId = document?.sourceVaultId;
    const itemId = document?.rawId ?? document?.id;
    if (!gatewayBase || !actorVaultId || !itemId) return;
    void listCommonsResidents(gatewayBase, actorVaultId)
      .then((items) => {
        if (active)
          setResidentDocumentId(
            items.some(
              (item) =>
                item.itemType === "core.document" && item.itemId === itemId
            )
              ? itemId
              : undefined
          );
      })
      .catch(() => {
        if (active) setResidentDocumentId(undefined);
      });
    return () => {
      active = false;
    };
  }, [document?.id, document?.rawId, document?.sourceVaultId, gatewayBase]);
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
      const write = {
        action: name,
        input: { document_id: document.rawId ?? document.id },
      };
      const result = await session.writeTo(
        document.sourceVaultId,
        "docs",
        write
      );
      // A parked write (e.g. moving to trash is medium-risk) must surface for
      // Approve/Discard rather than silently vanish (M5); denials/failures are
      // shown, not swallowed.
      surfaceWriteOutcome(result, {
        onParked: () =>
          navigation.navigate("Settings", { screen: "Approvals" }),
        queuedMessage:
          "This change will sync automatically when the gateway reconnects.",
        failureTitle: "Not applied",
      });
    } catch (error) {
      surfaceWriteFailure(error, "Action failed");
    }
  };
  const place = async (
    targetVaultId: string,
    requestedKind = placementKind
  ): Promise<void> => {
    const kind = requestedKind;
    setPlacementKind(undefined);
    if (!kind || !document?.sourceVaultId || !session) return;
    const result = await session.place({
      kind,
      itemType: "core.document",
      itemId: document.rawId ?? document.id,
      sourceVaultId: document.sourceVaultId,
      targetVaultId,
    });
    postStatus(
      result.reason ??
        (result.status === "executed"
          ? kind === "add" && targetVaultId === ownVault?.vaultId
            ? "Saved to my vault. This copy stays if the share ends."
            : "Document placed in the selected vault."
          : "Document placement queued — it will resume when the gateway is reachable.")
    );
  };
  const saveToMyVault = async (): Promise<void> => {
    const actorVaultId = document?.sourceVaultId;
    const itemId = document?.rawId ?? document?.id;
    if (!gatewayBase || !actorVaultId || !itemId || !commonsResident) return;
    try {
      await retainCommonsItem(gatewayBase, {
        actorVaultId,
        itemType: "core.document",
        itemId,
      });
      setResidentDocumentId(undefined);
      postStatus("Saved to my vault. This copy survives if the share ends.");
    } catch (error) {
      surfaceWriteFailure(error, "Document not saved to your vault");
    }
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
    <TopSafeArea
      style={[styles.safe, { backgroundColor: colors.bg }]}
      edges={["top", "bottom"]}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to documents"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>
          {document.title}
        </Text>
        <Pressable
          accessibilityLabel={`Share ${document.title}`}
          accessibilityRole="button"
          onPress={() => void share()}
        >
          <Icon name="share" size={21} color={colors.accent} />
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
          <Icon
            name="star"
            size={21}
            color={
              document.canWrite === true
                ? document.starred
                  ? colors.warning
                  : colors.textSoft
                : colors.textFaint
            }
          />
        </Pressable>
        <Text style={[styles.meta, { color: colors.textSoft }]}>
          {document.scopeLabels?.join(" · ") ?? "Vault"} · {document.mediaType}{" "}
          · {custodySentence(document.custody)}
        </Text>
        {commonsResident ? (
          <Pressable
            accessibilityLabel="Save to my vault"
            accessibilityRole="button"
            onPress={() => void saveToMyVault()}
          >
            <Text style={{ color: colors.accent }}>Save to my vault</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel="Add document to another vault"
            accessibilityRole="button"
            onPress={() => setPlacementKind("add")}
          >
            <Icon name="copy" size={20} color={colors.accent} />
          </Pressable>
        )}
        <Pressable
          accessibilityLabel="Move document to another vault"
          accessibilityRole="button"
          accessibilityState={{ disabled: document.canWrite !== true }}
          disabled={document.canWrite !== true}
          onPress={() => setPlacementKind("move")}
        >
          <Icon
            name="folder-plus"
            size={20}
            color={
              document.canWrite === true ? colors.accent : colors.textFaint
            }
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
          <Icon
            name="trash-2"
            size={20}
            color={
              document.canWrite === true ? colors.danger : colors.textFaint
            }
          />
        </Pressable>
      </View>
      <OptionSheet
        visible={placementKind !== undefined}
        title={`${placementKind === "move" ? "Move" : "Add"} to…`}
        options={scopes
          .filter(
            (scope) =>
              scope.canWrite && !document.scopeIds?.includes(scope.vaultId)
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
    </TopSafeArea>
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
    fontSize: t("control").fontSize,
    textAlign: "center",
  },
  safe: { flex: 1 },
  title: {
    flex: 1,
    fontFamily: family.sansMedium,
    fontSize: t("body").fontSize,
  },
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
