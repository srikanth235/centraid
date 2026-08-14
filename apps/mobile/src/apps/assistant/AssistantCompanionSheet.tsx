import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import OptionSheet from "../../kit/components/OptionSheet";
import type { SheetOption } from "../../kit/components/OptionSheet";
import { memberFacingError } from "../../kit/member-error";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { AssistantScreenProps } from "../../navigation";
import {
  ASSISTANT_COMPANION_PRESENTATION,
  ASSISTANT_COMPANION_HEIGHT,
  ASSISTANT_COMPANION_TOUCH_TARGET,
  companionConsequence,
  companionPageContext,
  companionSubmitText,
} from "./assistant-companion";
import { useAssistant } from "./useAssistant";

export default function AssistantCompanionSheet({
  navigation,
}: AssistantScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const assistant = useAssistant();
  const [draft, setDraft] = useState("");
  const [pageContext, setPageContext] = useState<string | undefined>(() => {
    const state = navigation.getState();
    return companionPageContext(state.routes[state.index - 1]?.name);
  });
  const [picker, setPicker] = useState<
    "attachment" | "harness" | "model" | "effort" | null
  >(null);
  const listRef = useRef<FlatList<(typeof assistant.bubbles)[number]>>(null);

  useEffect(() => {
    if (!assistant.pendingConsent) return;
    Alert.alert(
      "Share with another provider?",
      assistant.pendingConsent.message,
      [
        {
          onPress: assistant.declineConsent,
          style: "cancel",
          text: "Cancel",
        },
        {
          onPress: assistant.approveConsent,
          text: `Allow ${assistant.pendingConsent.provider}`,
        },
      ],
      { cancelable: true, onDismiss: assistant.declineConsent }
    );
  }, [
    assistant.approveConsent,
    assistant.declineConsent,
    assistant.pendingConsent,
  ]);

  const text = companionSubmitText(draft, assistant.sending);
  const submit = (): void => {
    if (!text) return;
    assistant.send(text, pageContext);
    setDraft("");
  };

  const selectionSpec: {
    title: string;
    options: SheetOption[];
    selectedId?: string;
    onSelect: (id: string) => void;
  } | null =
    picker === null
      ? null
      : picker === "attachment"
        ? {
            title: "Add attachment",
            options: [
              {
                detail: "Choose a document, image, or video from this phone.",
                id: "picker",
                label: "Files or photos",
              },
            ],
            onSelect: () => assistant.attach(),
          }
        : assistant.config
          ? picker === "harness"
            ? {
                title: "Agent",
                options: assistant.config.harnesses.map((harness) => ({
                  id: harness.kind,
                  label: harness.label,
                  ...(harness.hint ? { detail: harness.hint } : {}),
                  ...(harness.sessionReady ? {} : { disabled: true }),
                })),
                ...(assistant.config.harnessKind
                  ? { selectedId: assistant.config.harnessKind }
                  : {}),
                onSelect: assistant.selectHarness,
              }
            : picker === "model"
              ? {
                  title: "Model",
                  options: assistant.config.models.map((model) => ({
                    id: model.id,
                    label: model.name,
                  })),
                  ...(assistant.config.selectedModel
                    ? { selectedId: assistant.config.selectedModel }
                    : {}),
                  onSelect: assistant.selectModel,
                }
              : {
                  title: "Effort",
                  options: assistant.config.efforts.map((effort) => ({
                    id: effort.id,
                    label: effort.name,
                  })),
                  ...(assistant.config.selectedEffort
                    ? { selectedId: assistant.config.selectedEffort }
                    : {}),
                  onSelect: assistant.selectEffort,
                }
          : null;

  const selectedHarness = assistant.config?.harnesses.find(
    (harness) => harness.kind === assistant.config?.harnessKind
  );

  return (
    <>
      <Modal
        animationType="slide"
        onRequestClose={() => navigation.goBack()}
        presentationStyle="overFullScreen"
        testID={ASSISTANT_COMPANION_PRESENTATION}
        transparent
        visible
      >
        <View style={styles.stage}>
          <Pressable
            accessibilityLabel="Close Assistant companion"
            accessibilityRole="button"
            onPress={() => navigation.goBack()}
            style={styles.scrim}
          />
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={styles.sheet}
          >
            <View style={styles.grabber} />
            <View style={styles.header}>
              <View style={styles.heading}>
                <Text style={styles.title}>Assistant</Text>
                <Text style={styles.subtitle}>Ask about your vault</Text>
              </View>
              <Pressable
                accessibilityLabel="Open full Assistant"
                accessibilityRole="button"
                onPress={() => navigation.replace("AssistantFull")}
                style={styles.headerAction}
              >
                <Text style={styles.headerActionText}>Full</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Close Assistant companion"
                accessibilityRole="button"
                onPress={() => navigation.goBack()}
                style={styles.headerAction}
              >
                <Icon color={colors.text} name="x" size={20} />
              </Pressable>
            </View>

            {assistant.phase === "offline" ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>Not connected</Text>
                <Text style={styles.emptyBody}>
                  Link this phone to your vault from Settings to use Assistant.
                </Text>
              </View>
            ) : (
              <>
                <FlatList
                  contentContainerStyle={styles.list}
                  data={assistant.bubbles}
                  keyboardShouldPersistTaps="handled"
                  keyExtractor={(bubble) => bubble.key}
                  ListEmptyComponent={
                    <View style={styles.empty}>
                      <Text style={styles.emptyTitle}>
                        {assistant.phase === "connecting"
                          ? "Opening Assistant…"
                          : assistant.loadError
                            ? "Couldn't load history"
                            : "What needs attention?"}
                      </Text>
                      <Text style={styles.emptyBody}>
                        {(assistant.loadError
                          ? memberFacingError(assistant.loadError)
                          : undefined) ??
                          "Ask a question with page context, attachments, and your chosen agent."}
                      </Text>
                    </View>
                  }
                  onContentSizeChange={() =>
                    listRef.current?.scrollToEnd({ animated: true })
                  }
                  ref={listRef}
                  renderItem={({ item }) => (
                    <View
                      style={
                        item.role === "user" ? styles.rowRight : styles.rowLeft
                      }
                    >
                      <View
                        style={
                          item.role === "user"
                            ? styles.userBubble
                            : styles.assistantBubble
                        }
                      >
                        <Text
                          style={
                            item.role === "user"
                              ? styles.userText
                              : item.error
                                ? styles.errorText
                                : styles.assistantText
                          }
                        >
                          {item.pending
                            ? "Thinking…"
                            : item.error
                              ? memberFacingError(item.text)
                              : item.text}
                        </Text>
                      </View>
                    </View>
                  )}
                />
                <View style={styles.controls}>
                  {pageContext ? (
                    <Pressable
                      accessibilityLabel={`Remove ${pageContext} page context`}
                      accessibilityRole="button"
                      onPress={() => setPageContext(undefined)}
                      style={styles.chip}
                    >
                      <Text numberOfLines={1} style={styles.chipText}>
                        Context · {pageContext}
                      </Text>
                      <Icon color={colors.textSoft} name="x" size={14} />
                    </Pressable>
                  ) : null}
                  {assistant.config?.supportsAttachments ? (
                    <Pressable
                      accessibilityLabel="Add an attachment"
                      accessibilityRole="button"
                      disabled={assistant.attaching || assistant.sending}
                      onPress={() => setPicker("attachment")}
                      style={styles.chip}
                    >
                      <Icon
                        color={colors.textSoft}
                        name="paperclip"
                        size={15}
                      />
                      <Text style={styles.chipText}>
                        {assistant.attaching ? "Adding…" : "Attach"}
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    accessibilityLabel="Change assistant agent"
                    accessibilityRole="button"
                    disabled={!assistant.config?.harnesses.length}
                    onPress={() => setPicker("harness")}
                    style={styles.chip}
                  >
                    <Text numberOfLines={1} style={styles.chipText}>
                      {assistant.config?.harnesses.find(
                        (entry) => entry.kind === assistant.config?.harnessKind
                      )?.label ?? "Agent"}
                    </Text>
                  </Pressable>
                  {assistant.config?.models.length ? (
                    <Pressable
                      accessibilityLabel="Change assistant model"
                      accessibilityRole="button"
                      onPress={() => setPicker("model")}
                      style={styles.chip}
                    >
                      <Text numberOfLines={1} style={styles.chipText}>
                        {assistant.config.models.find(
                          (entry) =>
                            entry.id === assistant.config?.selectedModel
                        )?.name ?? "Model"}
                      </Text>
                    </Pressable>
                  ) : null}
                  {assistant.config?.efforts.length ? (
                    <Pressable
                      accessibilityLabel="Change assistant effort"
                      accessibilityRole="button"
                      onPress={() => setPicker("effort")}
                      style={styles.chip}
                    >
                      <Text numberOfLines={1} style={styles.chipText}>
                        {assistant.config.efforts.find(
                          (entry) =>
                            entry.id === assistant.config?.selectedEffort
                        )?.name ?? "Effort"}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
                {assistant.attachments.length > 0 ? (
                  <View style={styles.attachments}>
                    {assistant.attachments.map((attachment) => (
                      <Pressable
                        accessibilityLabel={`Remove ${attachment.filename}`}
                        accessibilityRole="button"
                        key={attachment.hash}
                        onPress={() =>
                          assistant.removeAttachment(attachment.hash)
                        }
                        style={styles.chip}
                      >
                        <Icon
                          color={colors.textSoft}
                          name="paperclip"
                          size={14}
                        />
                        <Text numberOfLines={1} style={styles.attachmentText}>
                          {attachment.filename}
                        </Text>
                        <Icon color={colors.textSoft} name="x" size={14} />
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                {assistant.selectionError ? (
                  <Text style={styles.selectionError}>
                    {memberFacingError(assistant.selectionError)}
                  </Text>
                ) : null}
                <Text style={styles.consequence}>
                  {companionConsequence(
                    pageContext,
                    assistant.attachments.length,
                    selectedHarness
                      ? {
                          available: selectedHarness.sessionReady,
                          kind: selectedHarness.kind,
                          label: selectedHarness.label,
                        }
                      : undefined
                  )}
                </Text>
                <View style={styles.composer}>
                  <TextInput
                    accessibilityLabel="Message Assistant"
                    editable={assistant.phase === "ready"}
                    multiline
                    onChangeText={setDraft}
                    onSubmitEditing={submit}
                    placeholder="Message your assistant"
                    placeholderTextColor={colors.textFaint}
                    style={styles.input}
                    value={draft}
                  />
                  <Pressable
                    accessibilityLabel={
                      assistant.sending ? "Stop response" : "Send message"
                    }
                    accessibilityRole="button"
                    disabled={!assistant.sending && !text}
                    onPress={assistant.sending ? assistant.stop : submit}
                    style={[
                      styles.send,
                      !assistant.sending && !text ? styles.sendDisabled : null,
                    ]}
                  >
                    <Icon
                      color={
                        assistant.sending || text
                          ? colors.textInv
                          : colors.textFaint
                      }
                      name={assistant.sending ? "square" : "arrow-up"}
                      size={assistant.sending ? 15 : 19}
                    />
                  </Pressable>
                </View>
              </>
            )}
          </KeyboardAvoidingView>
        </View>
      </Modal>
      {selectionSpec ? (
        <OptionSheet
          onClose={() => setPicker(null)}
          onSelect={(id) => {
            selectionSpec.onSelect(id);
            setPicker(null);
          }}
          options={selectionSpec.options}
          {...(selectionSpec.selectedId
            ? { selectedId: selectionSpec.selectedId }
            : {})}
          title={selectionSpec.title}
          visible
        />
      ) : null}
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    assistantBubble: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      maxWidth: "88%",
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
    },
    assistantText: { ...t("body"), color: colors.text },
    attachmentText: { ...t("control"), color: colors.textSoft, maxWidth: 150 },
    attachments: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing[2],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
    chip: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[1],
      minHeight: ASSISTANT_COMPANION_TOUCH_TARGET,
      paddingHorizontal: spacing[3],
    },
    chipText: { ...t("control"), color: colors.textSoft, maxWidth: 112 },
    composer: {
      alignItems: "flex-end",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[2],
      padding: spacing[4],
    },
    consequence: {
      ...t("small"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
    controls: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing[2],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
    empty: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      padding: spacing[6],
    },
    emptyBody: { ...t("body"), color: colors.textSoft, textAlign: "center" },
    emptyTitle: { ...t("title"), color: colors.text, marginBottom: spacing[2] },
    errorText: { ...t("body"), color: colors.danger },
    grabber: {
      alignSelf: "center",
      backgroundColor: colors.lineStrong,
      borderRadius: radii.sm,
      height: 4,
      marginTop: spacing[2],
      width: 36,
    },
    header: {
      alignItems: "center",
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[2],
      padding: spacing[4],
    },
    headerAction: {
      alignItems: "center",
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      height: ASSISTANT_COMPANION_TOUCH_TARGET,
      justifyContent: "center",
      minWidth: ASSISTANT_COMPANION_TOUCH_TARGET,
      paddingHorizontal: spacing[2],
    },
    headerActionText: { ...t("control"), color: colors.textSoft },
    heading: { flex: 1 },
    input: {
      ...t("body"),
      backgroundColor: colors.bgSunken,
      borderRadius: radii.lg,
      color: colors.text,
      flex: 1,
      maxHeight: 108,
      minHeight: ASSISTANT_COMPANION_TOUCH_TARGET,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
    },
    list: { flexGrow: 1, gap: spacing[3], padding: spacing[4] },
    rowLeft: { alignItems: "flex-start" },
    rowRight: { alignItems: "flex-end" },
    scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
    send: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: radii.lg,
      height: ASSISTANT_COMPANION_TOUCH_TARGET,
      justifyContent: "center",
      width: ASSISTANT_COMPANION_TOUCH_TARGET,
    },
    sendDisabled: {
      backgroundColor: colors.bgSunken,
      borderColor: colors.line,
      borderWidth: borders.hairline,
    },
    selectionError: {
      ...t("control"),
      color: colors.danger,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
    sheet: {
      backgroundColor: colors.bg,
      borderTopLeftRadius: radii.lg,
      borderTopRightRadius: radii.lg,
      height: ASSISTANT_COMPANION_HEIGHT,
      overflow: "hidden",
    },
    stage: { flex: 1, justifyContent: "flex-end" },
    subtitle: { ...t("small"), color: colors.textSoft },
    title: { ...t("title"), color: colors.text },
    userBubble: {
      backgroundColor: colors.accent,
      borderRadius: radii.lg,
      maxWidth: "88%",
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
    },
    userText: { ...t("body"), color: colors.textInv },
  });
