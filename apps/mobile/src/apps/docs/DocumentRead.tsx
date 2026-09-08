// The one READ route (Docs handoff Part 2 §6–§7; #821): reading view
// for text kinds, the facts panel for kinds Docs cannot set, and a hand-off
// to the stage for the kinds that render as media — the fork is a fact about
// the document (`document-read-model.ts`), not three places.
//
// Reading view: real text at the reading measure (`t("reading")`, capped at
// 34em), kind eyebrow, display title, ruled byline. Its status is
// `Version N · edited two hours ago` with the REAL chain count off the
// replica's `core.link` walk; the sample's "only you have opened this" is
// withheld — nothing records an opening.
//
// Facts panel: "a kind is a fact about the bytes; whether Docs can set it is
// a separate fact. The panel exists for the difference." Nothing converts;
// Open elsewhere hands the file, as stored, to an app that reads the kind.

import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { STAGE_ACTIONS } from "@centraid/blueprints/apps/docs/document-copy";
import {
  custodyMeta,
  fmtBytes,
  fmtFull,
  typeMeta,
} from "@centraid/blueprints/apps/docs/format";

import Button from "../../kit/components/Button";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import GrantSheet from "../../kit/share/GrantSheet";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsScreenProps } from "../../navigation";
import { FACTS_STATUS } from "./docs-copy";
import { openElsewhere } from "./docs-export";
import { bytesOnDevice } from "./docs-projection";
import type { MobileDriveDoc } from "./docs-projection";
import DocsScreen from "./DocsScreen";
import DocsShelfHeader from "./DocsShelfHeader";
import { factsRows, readStatus, readSurfaceFor } from "./document-read-model";
import OfflinePinButton from "./OfflinePinButton";
import { useDocument } from "./useDocs";
import { useDocsGrantAudiences } from "./useDocsGrantAudiences";
import { useDocumentText } from "./useDocumentText";
import { useVersionChain } from "./useVersionChain";

const READING_MEASURE_EM = 34;

export default function DocumentRead({
  route,
  navigation,
}: DocsScreenProps<"DocumentRead">): React.JSX.Element {
  const { documentId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { doc, loading, offline } = useDocument(documentId);
  const chain = useVersionChain(documentId);
  // The stage carries Share; this route is where every text and unrenderable
  // kind lands, so without it those documents had no share door at all.
  // `null` is "the roster is not an answer yet" — no verb, not a dead one.
  const audiences = useDocsGrantAudiences();
  const [shareOpen, setShareOpen] = useState(false);

  const surface = doc ? readSurfaceFor(doc) : null;

  // The stage is a MODE, not a place under this header — media kinds hand
  // off to the Viewer route, replacing this frame rather than stacking on it.
  useEffect(() => {
    if (surface === "stage")
      navigation.replace("DocumentViewer", { documentId });
  }, [surface, navigation, documentId]);

  return (
    <DocsScreen current="all">
      <DocsShelfHeader
        title={doc?.title ?? "Document"}
        backTo="All"
        {...(doc && audiences
          ? {
              trailing: (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={STAGE_ACTIONS.share}
                  onPress={() => setShareOpen(true)}
                  style={styles.headAction}
                >
                  <Icon name="Share" size={20} color={colors.text} />
                </Pressable>
              ),
            }
          : {})}
      />
      <ReplicaStatusBar />
      {/* OBJECT-FIRST: this route is already about one document. */}
      {doc && audiences ? (
        <GrantSheet
          visible={shareOpen}
          onClose={() => setShareOpen(false)}
          audiences={audiences}
          subject={{
            subjectType: "core.document",
            subjectId: doc.document_id,
            ...(doc.title ? { label: doc.title } : {}),
          }}
          onStatus={postStatus}
        />
      ) : null}
      {loading && !doc ? (
        <SkeletonRows accessibilityLabel="Reading this document" />
      ) : doc == null ? (
        <View style={styles.page}>
          <Text style={styles.absent}>
            This document is not in the drive this device can see — it may have
            been purged, or its link is stale.
          </Text>
        </View>
      ) : surface === "reading" ? (
        <ReadingView
          doc={doc}
          versionCount={chain.chain?.versionCount ?? null}
          onEdit={() => navigation.navigate("DocumentEditor", { documentId })}
          onVersions={() =>
            navigation.navigate("DocumentVersions", { documentId })
          }
          onDetails={() =>
            navigation.navigate("DocumentProperties", { documentId })
          }
          styles={styles}
        />
      ) : surface === "facts" ? (
        <FactsView
          doc={doc}
          offline={offline}
          versionCount={chain.chain?.versionCount ?? null}
          onVersions={() =>
            navigation.navigate("DocumentVersions", { documentId })
          }
          onDetails={() =>
            navigation.navigate("DocumentProperties", { documentId })
          }
          styles={styles}
        />
      ) : (
        // The stage hand-off is in flight; nothing to draw under it.
        <View style={styles.page} />
      )}
    </DocsScreen>
  );
}

function ReadingView({
  doc,
  versionCount,
  onEdit,
  onVersions,
  onDetails,
  styles,
}: {
  doc: MobileDriveDoc;
  versionCount: number | null;
  onEdit: () => void;
  onVersions: () => void;
  onDetails: () => void;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  const body = useDocumentText(doc);
  const kind = typeMeta(doc.media_type, doc.title);
  const status = readStatus(versionCount, doc.updated_at);
  return (
    <ScrollView contentContainerStyle={styles.readScroll}>
      <View style={styles.measure}>
        <Text style={styles.eyebrow}>{kind.name}</Text>
        <Text accessibilityRole="header" style={styles.displayTitle}>
          {doc.title}
        </Text>
        <Text style={styles.byline}>
          {`changed ${fmtFull(doc.updated_at)} · ${fmtBytes(doc.byte_size)}`}
        </Text>
        {body.loading ? (
          <Text style={styles.bodyFaint}>Fetching the text…</Text>
        ) : body.unavailableReason ? (
          <Text style={styles.bodyFaint}>{body.unavailableReason}</Text>
        ) : (
          <Text style={styles.reading}>{body.text ?? ""}</Text>
        )}
        <Button label="Edit" onPress={onEdit} style={styles.editButton} />
        <OfflinePinButton doc={doc} />
        <ThisDocument
          versionCount={versionCount}
          onVersions={onVersions}
          onDetails={onDetails}
          styles={styles}
        />
        {status ? <Text style={styles.status}>{status}</Text> : null}
      </View>
    </ScrollView>
  );
}

function FactsView({
  doc,
  offline,
  versionCount,
  onVersions,
  onDetails,
  styles,
}: {
  doc: MobileDriveDoc;
  offline: boolean;
  versionCount: number | null;
  onVersions: () => void;
  onDetails: () => void;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  const { gatewayBase, vaultId } = useReplica();
  const { colors } = useTheme();
  const [exporting, setExporting] = useState(false);
  const rows = factsRows(doc, custodyMeta(doc.custody_state)?.label ?? null);
  // Inline bytes travel from here; anything else needs the gateway in reach.
  const inline = String(doc.content_uri ?? "").startsWith("data:");
  const reachable = inline || (!offline && Boolean(gatewayBase));
  const localOnlyGone = !bytesOnDevice(doc) && offline;

  const onOpenElsewhere = async (): Promise<void> => {
    setExporting(true);
    try {
      await openElsewhere(doc, gatewayBase, vaultId);
    } catch (error) {
      postStatus(
        error instanceof Error
          ? error.message
          : "This document could not be handed over."
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.readScroll}>
      <View style={styles.factsPanel}>
        {rows.map((row, index) => (
          <View
            key={row.key}
            style={[styles.factRow, index === 0 ? undefined : styles.factRule]}
          >
            <Text style={styles.factKey}>{row.key}</Text>
            <Text
              style={[
                styles.factValue,
                row.net ? { color: colors.net } : undefined,
              ]}
            >
              {row.value}
            </Text>
          </View>
        ))}
      </View>
      <Button
        label={exporting ? "Handing over…" : "Open elsewhere"}
        onPress={() => void onOpenElsewhere()}
        disabled={exporting || !reachable || localOnlyGone}
        style={styles.editButton}
      />
      {!reachable || localOnlyGone ? (
        // The disabled outline carries its reason INLINE — never a hidden
        // control (platform states table).
        <Text style={styles.bodyFaint}>
          The bytes are not on this device and the gateway is out of reach, so
          nothing can be handed over right now.
        </Text>
      ) : null}
      <OfflinePinButton doc={doc} />
      <ThisDocument
        versionCount={versionCount}
        onVersions={onVersions}
        onDetails={onDetails}
        styles={styles}
      />
      <Text style={styles.status}>{FACTS_STATUS}</Text>
    </ScrollView>
  );
}

/**
 * The two ways on from an OPEN document — its history and its details.
 *
 * Both routes existed before this panel; neither was reachable from here. The
 * only door was the `···` on the drive's row, so a member reading a document
 * and wondering when it last changed had to leave it, find its row again, and
 * open a menu. A document's own screen is where facts about that document
 * belong.
 *
 * The version count is REAL or the row is silent: the chain comes off the
 * replica's `core.link` walk, and a row that guessed "7 versions" while the
 * walk was still running would be inventing a history.
 */
function ThisDocument({
  versionCount,
  onVersions,
  onDetails,
  styles,
}: {
  versionCount: number | null;
  onVersions: () => void;
  onDetails: () => void;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  return (
    <View style={styles.thisDoc}>
      <Text style={styles.thisDocEyebrow}>This document</Text>
      <LinkRow
        label="Version history"
        note={
          versionCount === null
            ? "preview and restore any of them"
            : `${versionCount} ${versionCount === 1 ? "version" : "versions"} · preview and restore any of them`
        }
        onPress={onVersions}
        styles={styles}
      />
      <LinkRow
        label="Details"
        note="filing, purge date, size and custody"
        onPress={onDetails}
        styles={styles}
      />
    </View>
  );
}

function LinkRow({
  label,
  note,
  onPress,
  styles,
}: {
  label: string;
  note: string;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${note}`}
      onPress={onPress}
      style={styles.linkRow}
    >
      <View style={styles.linkMain}>
        <Text style={styles.linkLabel}>{label}</Text>
        <Text style={styles.linkNote}>{note}</Text>
      </View>
      {/* The chevron is the row's one promise: this OPENS somewhere. */}
      <Icon name="ChevronRight" size={16} color={colors.textFaint} />
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) => {
  const readingRole = t("reading");
  return StyleSheet.create({
    absent: { ...t("body"), color: colors.textSoft },
    bodyFaint: { ...t("body"), color: colors.textSoft, paddingTop: 12 },
    // The row rung, so the head's one trailing control is a real target.
    headAction: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    byline: {
      ...t("body"),
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      color: colors.textSoft,
      marginBottom: 16,
      paddingBottom: 10,
      paddingTop: 6,
    },
    displayTitle: { ...t("display"), color: colors.text },
    editButton: { alignSelf: "flex-start", marginTop: 20 },
    eyebrow: { ...t("eyebrow"), color: colors.textFaint, paddingBottom: 6 },
    factKey: { ...t("eyebrow"), color: colors.textFaint },
    factRow: { gap: 4, paddingHorizontal: 12, paddingVertical: 10 },
    linkLabel: { ...t("body"), color: colors.text },
    linkMain: { flex: 1, gap: 2, minWidth: 0 },
    linkNote: { ...t("small"), color: colors.textFaint },
    linkRow: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: 12,
      minHeight: 52,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    thisDoc: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      marginTop: 16,
      overflow: "hidden",
    },
    thisDocEyebrow: {
      ...t("eyebrow"),
      color: colors.textFaint,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    factRule: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
    },
    factValue: { ...t("body"), color: colors.text },
    factsPanel: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      overflow: "hidden",
    },
    measure: {
      alignSelf: "center",
      maxWidth: READING_MEASURE_EM * (readingRole.fontSize ?? 17),
      width: "100%",
    },
    page: { flex: 1, paddingHorizontal: 18, paddingTop: 8 },
    readScroll: { paddingBottom: 32, paddingHorizontal: 18, paddingTop: 16 },
    reading: { ...t("reading"), color: colors.text },
    status: { ...t("mono"), color: colors.textFaint, paddingTop: 16 },
  });
};
