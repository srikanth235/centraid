// Add to Docs (Docs handoff Part 2 §13; issue #821) — four ways in on a
// phone: Upload, a blank document, a folder, and Scan. Drag and paste are
// pointer-only and absent here, deliberately.
//
// The two composing rows (blank document, folder) open their one field
// inline and dispatch through the one write door (`useDocsWrite`): a blank
// document is a real `upload` of an empty markdown body (the vault mints
// empty bytes like any other; two blanks legitimately share them), and a
// folder is the same `create-folder` the Folders shelf dispatches. Upload
// and Scan are their own screens; this shelf's status sentence — "Nothing is
// uploading" — is true here because uploads run on Bulk upload, never
// behind this screen's back.

import { useNavigation } from "@react-navigation/native";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import Button from "../../kit/components/Button";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { nativeWriteOutput } from "../../kit/replica/write-outcome";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsScreenProps, DocsShellNavigation } from "../../navigation";
import { ADD_STATUS } from "./docs-copy";
import DocsScreen from "./DocsScreen";
import DocsShelfHeader from "./DocsShelfHeader";
import { useDocsWrite } from "./useDocs";

/** An empty markdown body — a blank document is blank, not a template. */
const BLANK_BODY_URI = "data:text/markdown;charset=utf-8,";

type Composer = "document" | "folder" | null;

export default function AddToDocs({
  navigation,
}: DocsScreenProps<"DocsAdd">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const shellNavigation = useNavigation<DocsShellNavigation>();
  const write = useDocsWrite(shellNavigation);
  const [composer, setComposer] = useState<Composer>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const openComposer = (which: Exclude<Composer, null>): void => {
    setComposer(which);
    setDraft("");
  };

  const commit = async (): Promise<void> => {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      if (composer === "document") {
        const result = await write("upload", {
          title: name,
          data_uri: BLANK_BODY_URI,
        });
        if (result) {
          setComposer(null);
          // The command's output bag — flat on most seats; some pipelines
          // keep the vault outcome's own `output` nesting.
          const bag = nativeWriteOutput(result);
          const nested = bag?.["output"] as Record<string, unknown> | undefined;
          const documentId = [
            bag?.["document_id"],
            nested?.["document_id"],
          ].find(
            (value): value is string =>
              typeof value === "string" && value !== ""
          );
          if (documentId) {
            navigation.navigate("DocumentEditor", { documentId });
          } else {
            // Queued offline: the wrapper has no id on this device yet —
            // the queued sentence already said it will land.
            postStatus(`"${name}" will appear in the drive when it lands.`);
          }
        }
      } else if (composer === "folder") {
        const result = await write("create-folder", { name });
        if (result) {
          setComposer(null);
          postStatus(`Folder "${name}" created.`);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <DocsScreen current="more">
      <DocsShelfHeader title="Add to Docs" backTo="All" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.panel}>
          <WayIn
            icon="upload-cloud"
            label="Upload"
            note="files from this phone, with per-file progress"
            onPress={() => navigation.navigate("DocsUpload")}
            styles={styles}
            first
          />
          <WayIn
            icon="file-text"
            label="A blank document"
            note="markdown, editable in place, versioned from its first save"
            onPress={() => openComposer("document")}
            styles={styles}
          />
          <WayIn
            icon="folder-plus"
            label="A folder"
            note="a label on documents, not a place they sit"
            onPress={() => openComposer("folder")}
            styles={styles}
          />
          <WayIn
            icon="Camera"
            label="Scan"
            note="documents born on this phone"
            onPress={() => navigation.navigate("DocsScan")}
            styles={styles}
          />
        </View>

        {composer ? (
          <View style={styles.composer}>
            <Text style={styles.composerLabel}>
              {composer === "document"
                ? "Name the document"
                : "Name the folder"}
            </Text>
            <TextInput
              accessibilityLabel={
                composer === "document" ? "Document title" : "Folder name"
              }
              value={draft}
              onChangeText={setDraft}
              autoFocus
              style={styles.field}
            />
            <View style={styles.composerRow}>
              <Button
                label={busy ? "Creating…" : "Create"}
                variant="primary"
                disabled={busy || !draft.trim()}
                onPress={() => void commit()}
              />
              <Button label="Cancel" onPress={() => setComposer(null)} />
            </View>
          </View>
        ) : null}

        <Text style={styles.status}>{ADD_STATUS}</Text>
      </ScrollView>
    </DocsScreen>
  );
}

function WayIn({
  icon,
  label,
  note,
  onPress,
  first,
  styles,
}: {
  icon: string;
  label: string;
  note: string;
  onPress: () => void;
  first?: boolean;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.way, first ? undefined : styles.wayRule]}
    >
      <Icon name={icon} size={18} color={colors.textSoft} />
      <View style={styles.wayMain}>
        <Text style={styles.wayLabel}>{label}</Text>
        <Text style={styles.wayNote}>{note}</Text>
      </View>
      <Icon name="chevron-right" size={16} color={colors.textSoft} />
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    composer: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: 10,
      marginTop: 12,
      padding: 14,
    },
    composerLabel: { ...t("control"), color: colors.text },
    composerRow: { flexDirection: "row", gap: 10 },
    field: {
      ...t("body"),
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      color: colors.text,
      paddingBottom: 6,
    },
    panel: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      overflow: "hidden",
    },
    scroll: { paddingBottom: 32, paddingHorizontal: 18, paddingTop: 8 },
    status: { ...t("mono"), color: colors.textFaint, paddingTop: 8 },
    way: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      minHeight: 56,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    wayLabel: { ...t("body"), color: colors.text },
    wayMain: { flex: 1, gap: 2, minWidth: 0 },
    wayNote: { ...t("small"), color: colors.textFaint },
    wayRule: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
    },
  });
