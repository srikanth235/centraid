// The stage (Docs handoff Part 2 §8; issue #821) — a document on the dark
// ground, "a mode with its own exit, and the one thing that drops the band"
// (deviation 2: `DocsScreen`'s `hideBand`, passed here and nowhere else).
// Every colour on it is a named stage token off the native theme.
//
// What actually renders is what this seat can actually render:
//   * image  → expo-image off the gateway blob route (or the inline bytes);
//   * video / audio → expo-video with its own native transport — the same
//     machinery Photos' lightbox uses;
//   * PDF → NOTHING pretends to be a page. This phone has no PDF renderer,
//     so the stage states the fact with the document's own facts beside it
//     and offers the file to an app that reads the kind. A mocked page here
//     would be a fabrication (INTEGRATION-NOTES.md → choices).
//
// Prev / next step to the previous and next DOCUMENT in the current shelf
// (the drive's active set, in its default changed-newest order).

import { useNavigation } from "@react-navigation/native";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import React, { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { STAGE_ACTIONS } from "@centraid/blueprints/apps/docs/document-copy";
import {
  custodyMeta,
  fmtBytes,
  typeMeta,
} from "@centraid/blueprints/apps/docs/format";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { imageSource, videoSource } from "../../kit/media/media-source";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsScreenProps, DocsShellNavigation } from "../../navigation";
import { openElsewhere } from "./docs-export";
import type { MobileDriveDoc } from "./docs-projection";
import DocsScreen from "./DocsScreen";
import { docBytesUrl } from "./document-read-model";
import { useDocs, useDocsWrite } from "./useDocs";

export default function DocumentViewer({
  route,
  navigation,
}: DocsScreenProps<"DocumentViewer">): React.JSX.Element {
  const { documentId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { gatewayBase, vaultId } = useReplica();
  const shellNavigation = useNavigation<DocsShellNavigation>();
  const drive = useDocs();
  const write = useDocsWrite(shellNavigation);

  // The current shelf's steppable set: the active drive, default order.
  const shelfDocs = useMemo(
    () => drive.documents.filter((doc) => !doc.trashed),
    [drive.documents]
  );
  const index = shelfDocs.findIndex((doc) => doc.document_id === documentId);
  const doc = index >= 0 ? shelfDocs[index] : undefined;

  const step = (delta: number): void => {
    const next = shelfDocs[index + delta];
    if (next) navigation.setParams({ documentId: next.document_id });
  };

  const onStar = async (target: MobileDriveDoc): Promise<void> => {
    await write(target.starred ? "unstar" : "star", {
      document_id: target.document_id,
    });
  };
  const onTrash = async (target: MobileDriveDoc): Promise<void> => {
    const result = await write("trash", { document_id: target.document_id });
    if (result) {
      postStatus("Moved to trash.");
      navigation.goBack();
    }
  };
  const onDownload = async (target: MobileDriveDoc): Promise<void> => {
    try {
      await openElsewhere(target, gatewayBase, vaultId);
    } catch (error) {
      postStatus(
        error instanceof Error
          ? error.message
          : "This document could not be handed over."
      );
    }
  };

  return (
    <DocsScreen current="all" hideBand>
      <View style={styles.stage}>
        <View style={styles.bar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={STAGE_ACTIONS.close}
            onPress={() => navigation.goBack()}
            style={styles.close}
          >
            <Icon name="x" size={20} color={colors.onStage} />
          </Pressable>
          <View style={styles.barTitle}>
            <Text numberOfLines={1} style={styles.title}>
              {doc?.title ?? "Document"}
            </Text>
            {doc ? (
              <Text numberOfLines={1} style={styles.meta}>
                {`${typeMeta(doc.media_type, doc.title).name} · ${fmtBytes(doc.byte_size)}`}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.body}>
          {doc ? (
            <StageMedia
              doc={doc}
              gatewayBase={gatewayBase}
              vaultId={vaultId}
              offline={drive.offline}
              styles={styles}
            />
          ) : (
            <Text style={styles.cannot}>
              This document is not in the drive this device can see.
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous document"
            disabled={index <= 0}
            onPress={() => step(-1)}
            style={[
              styles.stepper,
              styles.stepPrev,
              index <= 0 ? styles.stepOff : undefined,
            ]}
          >
            <Icon name="chevron-left" size={22} color={colors.onStage} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next document"
            disabled={index < 0 || index >= shelfDocs.length - 1}
            onPress={() => step(1)}
            style={[
              styles.stepper,
              styles.stepNext,
              index < 0 || index >= shelfDocs.length - 1
                ? styles.stepOff
                : undefined,
            ]}
          >
            <Icon name="chevron-right" size={22} color={colors.onStage} />
          </Pressable>
        </View>

        {doc ? (
          <View style={styles.bottom}>
            <StageAction
              label={doc.starred ? STAGE_ACTIONS.starred : STAGE_ACTIONS.star}
              icon="star"
              onPress={() => void onStar(doc)}
              styles={styles}
            />
            <StageAction
              label={STAGE_ACTIONS.download}
              icon="download"
              onPress={() => void onDownload(doc)}
              styles={styles}
            />
            <StageAction
              label={STAGE_ACTIONS.properties}
              icon="info"
              onPress={() =>
                navigation.navigate("DocumentProperties", {
                  documentId: doc.document_id,
                })
              }
              styles={styles}
            />
            <StageAction
              label={STAGE_ACTIONS.trash}
              icon="trash-2"
              net
              onPress={() => void onTrash(doc)}
              styles={styles}
            />
          </View>
        ) : null}

        {doc ? (
          <View style={styles.statusRow}>
            <Text numberOfLines={1} style={styles.statusText}>
              {`${index + 1} of ${shelfDocs.length} in All` +
                (custodyMeta(doc.custody_state)
                  ? ` · ${custodyMeta(doc.custody_state)?.label.toLowerCase()}`
                  : "")}
            </Text>
          </View>
        ) : null}
      </View>
    </DocsScreen>
  );
}

function StageAction({
  label,
  icon,
  net,
  onPress,
  styles,
}: {
  label: string;
  icon: string;
  net?: boolean;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  const { colors } = useTheme();
  const color = net ? colors.net : colors.onStage;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.action}
    >
      <Icon name={icon} size={18} color={color} />
      <Text style={[styles.actionLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

function StageMedia({
  doc,
  gatewayBase,
  vaultId,
  offline,
  styles,
}: {
  doc: MobileDriveDoc;
  gatewayBase: string | undefined;
  vaultId: string | undefined;
  offline: boolean;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  const kind = typeMeta(doc.media_type, doc.title);
  const mediaType = String(doc.media_type ?? "");
  const inline = String(doc.content_uri ?? "").startsWith("data:")
    ? String(doc.content_uri)
    : null;
  const remote = docBytesUrl(doc, gatewayBase, vaultId);
  const uri = inline ?? (offline ? null : remote);

  if (mediaType.startsWith("image/") && uri) {
    return (
      <Image
        source={imageSource(uri)}
        contentFit="contain"
        style={styles.media}
        accessibilityLabel={doc.title}
      />
    );
  }
  if (
    (mediaType.startsWith("video/") || mediaType.startsWith("audio/")) &&
    uri
  ) {
    return <StageTransport uri={uri} styles={styles} />;
  }
  // The honest state: no fabricated page. Either this phone cannot render
  // the kind at all (there is no PDF renderer on this seat), or the bytes
  // are out of reach — the sentence names which.
  const reason = uri
    ? `This phone cannot open ${kind.name} here. Docs holds it, versions it and files it — Open elsewhere hands the file to an app that reads this kind.`
    : "The bytes of this document are not on this device and the gateway is out of reach, so it cannot open right now.";
  return (
    <ScrollView contentContainerStyle={styles.cannotWrap}>
      <Text style={styles.cannotKind}>{kind.name}</Text>
      <Text style={styles.cannot}>{reason}</Text>
      <View style={styles.cannotFacts}>
        <Text
          style={styles.cannotFact}
        >{`Size · ${fmtBytes(doc.byte_size)}`}</Text>
        <Text style={styles.cannotFact}>
          {`Bytes · ${custodyMeta(doc.custody_state)?.label.toLowerCase() ?? "not swept yet"}`}
        </Text>
      </View>
    </ScrollView>
  );
}

function StageTransport({
  uri,
  styles,
}: {
  uri: string;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  const player = useVideoPlayer(videoSource(uri), (instance) => {
    instance.loop = false;
  });
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      style={styles.media}
    />
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    action: {
      alignItems: "center",
      flex: 1,
      gap: 3,
      justifyContent: "center",
      minHeight: 56,
    },
    actionLabel: { ...t("small"), color: colors.onStage },
    bar: {
      alignItems: "center",
      borderBottomColor: colors.stageLine,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      gap: 8,
      minHeight: 52,
      paddingHorizontal: 10,
    },
    barTitle: { flex: 1, gap: 1, minWidth: 0 },
    body: { flex: 1, justifyContent: "center", minHeight: 0 },
    bottom: {
      borderTopColor: colors.stageLine,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
    },
    cannot: { ...t("body"), color: colors.onStage, textAlign: "center" },
    cannotFact: { ...t("mono"), color: colors.onStageSoft },
    cannotFacts: { alignItems: "center", gap: 4, paddingTop: 16 },
    cannotKind: {
      ...t("eyebrow"),
      color: colors.onStageSoft,
      paddingBottom: 8,
      textAlign: "center",
    },
    cannotWrap: {
      flexGrow: 1,
      justifyContent: "center",
      paddingHorizontal: 32,
    },
    close: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    media: { flex: 1 },
    meta: { ...t("small"), color: colors.onStageSoft },
    statusRow: {
      alignItems: "center",
      borderTopColor: colors.stageLine,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      minHeight: 32,
      paddingHorizontal: 12,
    },
    statusText: { ...t("small"), color: colors.onStageSoft, flex: 1 },
    stepNext: { insetInlineEnd: 12 },
    stepOff: { opacity: 0.3 },
    stepPrev: { insetInlineStart: 12 },
    stepper: {
      alignItems: "center",
      backgroundColor: colors.stageSunken,
      borderColor: colors.stageLine,
      borderRadius: radii.pill,
      borderWidth: borders.hairline,
      height: 44,
      justifyContent: "center",
      marginTop: -22,
      position: "absolute",
      top: "50%",
      width: 44,
    },
    stage: { backgroundColor: colors.stage, flex: 1 },
    title: { ...t("control"), color: colors.onStage },
  });
