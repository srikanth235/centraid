// Properties (Docs handoff Part 2 §11; issue #821) — "the whole custody
// story, on demand", told strictly from facts this device holds:
//
//   * the custody projection (`blob.custody_state`) in the same owner-facing
//     words every other surface uses — with its own note that this is "where
//     the bytes are, as the vault last swept them";
//   * the gateway this vault rides (the session's own base), the folder
//     label, the tags, the share reach (absent, never negative — a denied
//     share read says nothing here);
//   * the sample's "backed up Sunday 21:40" is WITHHELD: the backup
//     timestamp is the gateway's record and this seat has no read for it —
//     `PROPERTIES_BACKUP_WITHHELD` says so instead of guessing a time.

import React, { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import {
  SHARED_WITH_KEY,
  sharedWithNote,
  STAGE_PROPS,
} from "@centraid/blueprints/apps/docs/document-copy";
import {
  custodyMeta,
  fmtBytes,
  fmtFull,
  typeMeta,
} from "@centraid/blueprints/apps/docs/format";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsScreenProps } from "../../navigation";
import { PROPERTIES_BACKUP_WITHHELD } from "./docs-copy";
import DocsScreen from "./DocsScreen";
import DocsShelfHeader from "./DocsShelfHeader";
import { useDocs } from "./useDocs";

/** The status sentence, from the custody fact alone — no invented clauses. */
export function custodyStatusLine(state: string | null): string {
  switch (state) {
    case "replicated":
      return "On the gateway and on this device";
    case "local-only":
      return "On this device only · not yet on the gateway";
    case "remote-only":
      return "Only in the cloud · not on this device";
    case "missing":
      return "Missing — on neither tier · needs attention";
    case null:
      return "Not swept yet · custody unknown until the vault's next sweep";
    default:
      return "Not swept yet · custody unknown until the vault's next sweep";
  }
}

export default function DocumentProperties({
  route,
  navigation,
}: DocsScreenProps<"DocumentProperties">): React.JSX.Element {
  const { documentId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { gatewayBase } = useReplica();
  const drive = useDocs();
  const doc = drive.documents.find((row) => row.document_id === documentId);
  const folder = doc?.folder_id
    ? drive.folders.find((row) => row.folder_id === doc.folder_id)
    : undefined;

  const gatewayHost = useMemo(() => {
    if (!gatewayBase) return null;
    try {
      return new URL(gatewayBase).host;
    } catch {
      return gatewayBase;
    }
  }, [gatewayBase]);

  const custody = doc ? custodyMeta(doc.custody_state) : null;

  return (
    <DocsScreen current="all">
      <DocsShelfHeader title={STAGE_PROPS.head} backTo="All" />
      <ReplicaStatusBar />
      {drive.loading && !doc ? (
        <SkeletonRows accessibilityLabel="Reading this document" />
      ) : doc == null ? (
        <View style={styles.page}>
          <Text style={styles.caption}>
            This document is not in the drive this device can see.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.panel}>
            <Row k={STAGE_PROPS.title} v={doc.title} styles={styles} first />
            <Row
              k="Kind"
              v={`${typeMeta(doc.media_type, doc.title).name} · ${fmtBytes(doc.byte_size)}`}
              styles={styles}
            />
            <Row
              k={STAGE_PROPS.folder}
              v={
                doc.folderGone
                  ? "filed in a folder that no longer exists"
                  : (folder?.name ?? "no folder")
              }
              note={STAGE_PROPS.folderNote}
              styles={styles}
            />
            <Row
              k={STAGE_PROPS.tags}
              v={
                doc.tags.length > 0
                  ? doc.tags.map((tag) => tag.label).join(" · ")
                  : STAGE_PROPS.tagsEmpty
              }
              styles={styles}
            />
            <Row
              k={STAGE_PROPS.device}
              v={custody?.label ?? STAGE_PROPS.deviceUnknown}
              note={STAGE_PROPS.deviceNote}
              net={doc.custody_state === "missing"}
              styles={styles}
            />
            {gatewayHost ? (
              <Row
                k="Gateway"
                v={gatewayHost}
                note="the vault this drive is a projection of"
                styles={styles}
              />
            ) : null}
            {doc.shared_with && doc.shared_with.length > 0
              ? doc.shared_with.map((share) => (
                  <Row
                    key={share.grant_id}
                    k={SHARED_WITH_KEY}
                    v={share.label}
                    note={sharedWithNote({
                      viaFolder:
                        share.via === "folder"
                          ? (drive.folders.find(
                              (row) => row.folder_id === share.container_id
                            )?.name ?? "a folder")
                          : null,
                      pending: share.pending_count,
                    })}
                    styles={styles}
                  />
                ))
              : null}
            <Row k="Changed" v={fmtFull(doc.updated_at)} styles={styles} />
            <Row k="Added" v={fmtFull(doc.created_at)} styles={styles} />
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Who this document names"
            onPress={() => navigation.navigate("DocumentNames", { documentId })}
            style={styles.namesRow}
          >
            <Text style={styles.namesLabel}>Who this document names</Text>
            <Icon name="chevron-right" size={16} color={colors.textSoft} />
          </Pressable>

          <Text style={styles.origin}>{STAGE_PROPS.origin}</Text>
          <Text style={styles.caption}>{PROPERTIES_BACKUP_WITHHELD}</Text>
          <Text style={styles.status}>
            {custodyStatusLine(doc.custody_state)}
          </Text>
        </ScrollView>
      )}
    </DocsScreen>
  );
}

function Row({
  k,
  v,
  note,
  net,
  first,
  styles,
}: {
  k: string;
  v: string;
  note?: string | undefined;
  net?: boolean;
  first?: boolean;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, first ? undefined : styles.rowRule]}>
      <Text style={styles.rowKey}>{k}</Text>
      <Text style={[styles.rowValue, net ? { color: colors.net } : undefined]}>
        {v}
      </Text>
      {note ? <Text style={styles.rowNote}>{note}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    caption: { ...t("small"), color: colors.textFaint, paddingTop: 8 },
    namesLabel: { ...t("body"), color: colors.text, flex: 1 },
    namesRow: {
      alignItems: "center",
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      flexDirection: "row",
      gap: 8,
      marginTop: 12,
      minHeight: 44,
      paddingHorizontal: 12,
    },
    origin: { ...t("small"), color: colors.textFaint, paddingTop: 12 },
    page: { flex: 1, paddingHorizontal: 18, paddingTop: 8 },
    panel: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      overflow: "hidden",
    },
    row: { gap: 3, paddingHorizontal: 12, paddingVertical: 10 },
    rowKey: { ...t("eyebrow"), color: colors.textFaint },
    rowNote: { ...t("small"), color: colors.textFaint },
    rowRule: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
    },
    rowValue: { ...t("body"), color: colors.text },
    scroll: { paddingBottom: 32, paddingHorizontal: 18, paddingTop: 8 },
    status: { ...t("mono"), color: colors.textFaint, paddingTop: 6 },
  });
