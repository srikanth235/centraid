// Version history (Docs handoff Part 2 §10; issue #821) — "every change is a
// version and nothing is ever overwritten."
//
// The chain is REAL: `core.link` revises edges off this device's replica,
// walked by `docs-versions.ts` exactly as the gateway's own history query
// walks them. What the sample shows and this seat cannot say is absent and
// SAID to be absent:
//   * WHO made each version (`you` / `Docs` / `a machine`) is a
//     consent.provenance fact the replica does not carry → one sentence under
//     the list (`VERSIONS_WHO_WITHHELD`), no invented actors.
//   * NO DIFF IS MOCKED — this seat cannot render a real one, so none is
//     drawn. Each entry shows its own facts (kind, size, when asserted).
//
// Restore dispatches the manifest's `restore-version` through the one write
// door. A restore is itself a NEW version (history only ever grows forward),
// so it carries no Undo — there is no reverse write, only another forward one.

import { useNavigation } from "@react-navigation/native";
import React, { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  fmtBytes,
  fmtFull,
  typeMeta,
} from "@centraid/blueprints/apps/docs/format";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { postStatus } from "../../kit/components/status-line";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsScreenProps, DocsShellNavigation } from "../../navigation";
import {
  VERSIONS_ABSENT,
  VERSIONS_WHO_WITHHELD,
  versionsStatus,
} from "./docs-copy";
import DocsScreen from "./DocsScreen";
import DocsShelfHeader from "./DocsShelfHeader";
import { useDocument, useDocsWrite } from "./useDocs";
import { useVersionChain } from "./useVersionChain";

export default function DocumentVersions({
  route,
}: DocsScreenProps<"DocumentVersions">): React.JSX.Element {
  const { documentId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const shellNavigation = useNavigation<DocsShellNavigation>();
  const { doc } = useDocument(documentId);
  const { chain, loading, linksDenied, refresh } = useVersionChain(documentId);
  const write = useDocsWrite(shellNavigation);

  const restore = async (contentId: string): Promise<void> => {
    const result = await write("restore-version", {
      document_id: documentId,
      content_id: contentId,
    });
    if (result) {
      postStatus("Restored that version — itself a new version, receipted.");
      await refresh();
    }
  };

  return (
    <DocsScreen current="all">
      <DocsShelfHeader title="Version history" backTo="All" />
      <ReplicaStatusBar />
      {loading && !chain ? (
        <SkeletonRows accessibilityLabel="Reading the version chain" />
      ) : linksDenied ? (
        <View style={styles.page}>
          <Text style={styles.caption}>{VERSIONS_ABSENT}</Text>
        </View>
      ) : chain === null ? (
        <View style={styles.page}>
          <Text style={styles.caption}>
            This document is not in the drive this device can see.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {doc ? (
            <Text numberOfLines={1} style={styles.docTitle}>
              {doc.title}
            </Text>
          ) : null}
          <View style={styles.container}>
            {chain.entries.map((entry, index) => (
              <View
                key={entry.content_id}
                style={[styles.row, index === 0 ? undefined : styles.rowRule]}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.rowVersion}>
                    {`Version ${entry.n}${entry.current ? " · current" : ""}`}
                  </Text>
                  <Text style={styles.rowMeta}>
                    {`${fmtFull(entry.asserted_at)} · ${typeMeta(entry.media_type, doc?.title).name} · ${fmtBytes(entry.byte_size)}`}
                  </Text>
                </View>
                {entry.current ? null : (
                  <Button
                    label="Restore"
                    onPress={() => void restore(entry.content_id)}
                    accessibilityHint={`Restore version ${entry.n}`}
                  />
                )}
              </View>
            ))}
          </View>
          <Text style={styles.caption}>{VERSIONS_WHO_WITHHELD}</Text>
          <Text style={styles.status}>
            {versionsStatus(chain.versionCount)}
          </Text>
        </ScrollView>
      )}
    </DocsScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    caption: { ...t("small"), color: colors.textFaint, paddingTop: 8 },
    container: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      overflow: "hidden",
    },
    docTitle: { ...t("title"), color: colors.text, paddingBottom: 10 },
    page: { flex: 1, paddingHorizontal: 18, paddingTop: 8 },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      minHeight: 52,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    rowMain: { flex: 1, gap: 2, minWidth: 0 },
    rowMeta: { ...t("small"), color: colors.textFaint },
    rowRule: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
    },
    rowVersion: { ...t("body"), color: colors.text },
    scroll: { paddingBottom: 32, paddingHorizontal: 18, paddingTop: 8 },
    status: { ...t("mono"), color: colors.textFaint, paddingTop: 6 },
  });
