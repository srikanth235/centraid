// The one READ route (Docs handoff Part 2 §6–§7; issue #821): reading view
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
import { ScrollView, StyleSheet, View } from "react-native";

import {
  custodyMeta,
  fmtBytes,
  fmtFull,
  typeMeta,
} from "@centraid/blueprints/apps/docs/format";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
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
import { useDocument } from "./useDocs";
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

  const surface = doc ? readSurfaceFor(doc) : null;

  // The stage is a MODE, not a place under this header — media kinds hand
  // off to the Viewer route, replacing this frame rather than stacking on it.
  useEffect(() => {
    if (surface === "stage")
      navigation.replace("DocumentViewer", { documentId });
  }, [surface, navigation, documentId]);

  return (
    <DocsScreen current="all">
      <DocsShelfHeader title={doc?.title ?? "Document"} backTo="All" />
      <ReplicaStatusBar />
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
          styles={styles}
        />
      ) : surface === "facts" ? (
        <FactsView doc={doc} offline={offline} styles={styles} />
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
  styles,
}: {
  doc: MobileDriveDoc;
  versionCount: number | null;
  onEdit: () => void;
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
        {status ? <Text style={styles.status}>{status}</Text> : null}
      </View>
    </ScrollView>
  );
}

function FactsView({
  doc,
  offline,
  styles,
}: {
  doc: MobileDriveDoc;
  offline: boolean;
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
      <Text style={styles.status}>{FACTS_STATUS}</Text>
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) => {
  const readingRole = t("reading");
  return StyleSheet.create({
    absent: { ...t("body"), color: colors.textSoft },
    bodyFaint: { ...t("body"), color: colors.textSoft, paddingTop: 12 },
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
