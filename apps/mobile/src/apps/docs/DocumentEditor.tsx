// The editor (Docs handoff Part 2 §9; #821) — "the hardest screen in
// the app. A write has seven visible outcomes and the member must always know
// which one is showing."
//
// The seven postures, their copy and their HONEST mapping onto the replica's
// real result union live in `editor-outcome.ts` (pure, tested). This screen
// owns only what a screen must: the two drafts, the byte-identical compare
// BEFORE dispatch (a no-op is not a version), and the raw `session.write` —
// deliberately not `useDocsWrite`, whose 6-second status line cannot carry a
// standing outcome; here the posture row IS the outcome surfacing, and each
// terminal state stays on screen with its note and its follow-up.
//
// Only text kinds edit — the vault's own `edit_document` precondition — so a
// non-text document opens straight into the Refused posture with the rule
// named and `What can be edited?` beside it. Everything else takes Replace.

import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { isTextKind } from "@centraid/blueprints/apps/docs/format";

import Button from "../../kit/components/Button";
import { Text, TextInput } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsScreenProps } from "../../navigation";
import DocsScreen from "./DocsScreen";
import DocsShelfHeader from "./DocsShelfHeader";
import {
  EDITOR_ACTION_LABELS,
  editorOutcomeCopy,
  NOT_TEXT_REASON,
  postureFromResult,
  WHAT_CAN_BE_EDITED,
} from "./editor-outcome";
import type { EditorPosture } from "./editor-outcome";
import { useDocument } from "./useDocs";
import { useDocumentText } from "./useDocumentText";
import { useVersionChain } from "./useVersionChain";

const READING_MEASURE_EM = 34;

export default function DocumentEditor({
  route,
  navigation,
}: DocsScreenProps<"DocumentEditor">): React.JSX.Element {
  const { documentId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { session } = useReplica();
  const { doc, loading, refresh } = useDocument(documentId);
  const body = useDocumentText(doc);
  const chain = useVersionChain(documentId);

  const textKind = doc ? isTextKind(doc) : false;

  // The drafts are DERIVED over the loaded body rather than seeded by an
  // effect: `null` means "not typed yet — show the loaded value". `baseline`
  // is what the byte-identical compare runs against; it starts as the loaded
  // pair and moves forward on a Saved.
  const loadedTitle = doc?.title ?? "";
  const loadedBody = body.text ?? "";
  const [savedBaseline, setSavedBaseline] = useState<{
    title: string;
    body: string;
  } | null>(null);
  const [typedTitle, setTypedTitle] = useState<string | null>(null);
  const [typedBody, setTypedBody] = useState<string | null>(null);
  const baseline = savedBaseline ?? { title: loadedTitle, body: loadedBody };
  const draftTitle = typedTitle ?? baseline.title;
  const draftBody = typedBody ?? baseline.body;
  const pristine =
    savedBaseline === null && typedTitle === null && typedBody === null;
  // `null` = pristine: nothing typed, nothing claimed. A non-text kind is a
  // fact, not an event, so its Refused posture is derived, never stored.
  const [claimed, setClaimed] = useState<EditorPosture | null>(null);
  const posture: EditorPosture | null =
    claimed ??
    (doc && !textKind ? { id: "refused", reason: NOT_TEXT_REASON } : null);
  const [showRule, setShowRule] = useState(false);

  const edit = (next: { title?: string; body?: string }): void => {
    if (next.title !== undefined) setTypedTitle(next.title);
    if (next.body !== undefined) setTypedBody(next.body);
    // Typing re-opens the loop: whatever terminal posture was showing, the
    // member now has uncommitted changes again.
    setClaimed({ id: "unsaved" });
  };

  const save = async (): Promise<void> => {
    if (!doc || !session || !textKind) return;
    if (draftBody === baseline.body && draftTitle === baseline.title) {
      // Byte-identical: NOTHING is dispatched. "A no-op is not a version."
      setClaimed({ id: "nochange" });
      return;
    }
    setClaimed({ id: "saving" });
    try {
      const result = await session.write("docs", {
        action: "edit",
        input: {
          document_id: doc.document_id,
          body_text: draftBody,
          ...(draftTitle.trim() && draftTitle !== baseline.title
            ? { title: draftTitle.trim() }
            : {}),
        },
      });
      const next = postureFromResult(result);
      if (next.id === "saved") {
        // The compare above proved the body differs from the current version,
        // so an executed edit IS one new version on the chain.
        next.savedVersion =
          chain.chain === null ? null : chain.chain.versionCount + 1;
        setSavedBaseline({ title: draftTitle, body: draftBody });
        void refresh();
        void chain.refresh();
      }
      setClaimed(next);
    } catch (error) {
      setClaimed({
        id: "refused",
        reason:
          error instanceof Error ? error.message : "the write did not land",
      });
    }
  };

  const onAction = (): void => {
    const copy = posture ? editorOutcomeCopy(posture) : null;
    if (!copy?.action) return;
    if (copy.action === "receipt")
      navigation.navigate("DocumentVersions", { documentId });
    else if (copy.action === "approvals")
      navigation.navigate("Settings", { screen: "Approvals" });
    else setShowRule((current) => !current);
  };

  const copy = posture ? editorOutcomeCopy(posture) : null;

  return (
    <DocsScreen current="all">
      <DocsShelfHeader title="Edit" backTo="All" />
      <ReplicaStatusBar />
      {loading && !doc ? (
        <SkeletonRows accessibilityLabel="Reading this document" />
      ) : doc == null ? (
        <View style={styles.page}>
          <Text style={styles.note}>
            This document is not in the drive this device can see.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.measure}>
            {textKind ? (
              <>
                <TextInput
                  accessibilityLabel="Document title"
                  value={draftTitle}
                  onChangeText={(title) => edit({ title })}
                  style={styles.titleField}
                />
                {body.loading && pristine ? (
                  <Text style={styles.note}>Fetching the text…</Text>
                ) : body.unavailableReason && pristine ? (
                  <Text style={styles.note}>{body.unavailableReason}</Text>
                ) : (
                  <TextInput
                    accessibilityLabel="Document body"
                    value={draftBody}
                    onChangeText={(next) => edit({ body: next })}
                    multiline
                    textAlignVertical="top"
                    style={styles.bodyField}
                  />
                )}
              </>
            ) : (
              <Text accessibilityRole="header" style={styles.titleStatic}>
                {doc.title}
              </Text>
            )}

            {copy ? (
              <View style={styles.stateBlock}>
                <View style={styles.stateRow}>
                  <View
                    style={[
                      styles.dot,
                      {
                        backgroundColor: copy.net
                          ? colors.net
                          : colors.textFaint,
                      },
                    ]}
                  />
                  <Text
                    style={[
                      styles.stateLine,
                      copy.net ? { color: colors.net } : undefined,
                    ]}
                  >
                    {copy.line}
                  </Text>
                </View>
                <Text style={styles.note}>{copy.note}</Text>
                {copy.action ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={EDITOR_ACTION_LABELS[copy.action]}
                    onPress={onAction}
                    style={styles.actionRow}
                  >
                    <Text style={styles.actionLabel}>
                      {EDITOR_ACTION_LABELS[copy.action]}
                    </Text>
                  </Pressable>
                ) : null}
                {showRule ? (
                  <Text style={styles.note}>{WHAT_CAN_BE_EDITED}</Text>
                ) : null}
              </View>
            ) : null}

            {textKind ? (
              <Button
                label={copy?.commit ?? "Save"}
                variant="primary"
                disabled={!copy || !copy.commitEnabled || !session}
                onPress={() => void save()}
                style={styles.saveButton}
              />
            ) : null}
          </View>
        </ScrollView>
      )}
    </DocsScreen>
  );
}

const makeStyles = (colors: ThemeColors) => {
  const readingRole = t("reading");
  return StyleSheet.create({
    actionLabel: {
      ...t("small"),
      color: colors.text,
      textDecorationLine: "underline",
    },
    actionRow: {
      alignSelf: "flex-start",
      justifyContent: "center",
      minHeight: 32,
    },
    bodyField: {
      ...t("reading"),
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      color: colors.text,
      minHeight: 220,
      paddingBottom: 16,
      paddingTop: 16,
    },
    dot: { borderRadius: radii.pill, height: 5, width: 5 },
    measure: {
      alignSelf: "center",
      maxWidth: READING_MEASURE_EM * (readingRole.fontSize ?? 17),
      width: "100%",
    },
    note: { ...t("body"), color: colors.textSoft },
    page: { flex: 1, paddingHorizontal: 18, paddingTop: 8 },
    saveButton: { alignSelf: "flex-start", marginTop: 8 },
    scroll: { paddingBottom: 32, paddingHorizontal: 18, paddingTop: 16 },
    stateBlock: { gap: 8, paddingVertical: 12 },
    stateLine: { ...t("small"), color: colors.textSoft, flex: 1 },
    stateRow: { alignItems: "center", flexDirection: "row", gap: 8 },
    titleField: {
      ...t("display"),
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      borderStyle: "dashed",
      color: colors.text,
      paddingBottom: 6,
    },
    titleStatic: { ...t("display"), color: colors.text, paddingBottom: 12 },
  });
};
