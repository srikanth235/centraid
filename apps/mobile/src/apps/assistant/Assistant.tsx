import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FlatList,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  View,
} from "react-native";
import type { ListRenderItemInfo } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import OptionSheet from "../../kit/components/OptionSheet";
import type { SheetOption } from "../../kit/components/OptionSheet";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useTheme } from "../../kit/theme";
import type { AssistantFullScreenProps } from "../../navigation";
import { makeStyles } from "./Assistant.styles";
import { useAssistant } from "./useAssistant";
import type { Bubble } from "./useAssistant";

// The vault assistant chat — a full-page cover over Home (springboard model).
// Chrome mirrors the other covers: a serif title and the teal leave key. The
// cover exits via that key (full-screen modal, no pull-down). The composer rises
// with the keyboard; v0 sends a buffered turn (no incremental streaming — see
// src/lib/assistant.ts for the expo/fetch upgrade path).
export default function AssistantScreen({
  navigation,
}: AssistantFullScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const {
    phase,
    bubbles,
    sending,
    loadError,
    selectionError,
    config,
    context,
    pendingConsent,
    attachments,
    attaching,
    send,
    stop,
    approveConsent,
    declineConsent,
    attach,
    removeAttachment,
    selectHarness,
    selectModel,
    selectEffort,
  } = useAssistant();
  const [draft, setDraft] = useState("");
  const [keyboardUp, setKeyboardUp] = useState(false);
  const listRef = useRef<FlatList<Bubble>>(null);

  useEffect(() => {
    const show = Keyboard.addListener("keyboardWillShow", () =>
      setKeyboardUp(true)
    );
    const hide = Keyboard.addListener("keyboardWillHide", () =>
      setKeyboardUp(false)
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    if (!pendingConsent) return;
    Alert.alert(
      "Share with another provider?",
      pendingConsent.message,
      [
        { text: "Cancel", style: "cancel", onPress: declineConsent },
        { text: `Allow ${pendingConsent.provider}`, onPress: approveConsent },
      ],
      // Android's back gesture dismisses without pressing a button. Silence is
      // not consent — and without this the turn stays wedged on pendingConsent.
      { cancelable: true, onDismiss: declineConsent }
    );
  }, [approveConsent, declineConsent, pendingConsent]);

  const renderBubble = useCallback(
    ({ item }: ListRenderItemInfo<Bubble>): React.JSX.Element => (
      <BubbleRow bubble={item} styles={styles} />
    ),
    [styles]
  );

  const submit = (): void => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || sending) return;
    send(text || "Review the attached file.");
    setDraft("");
  };

  const canSend =
    (draft.trim().length > 0 || attachments.length > 0) && !sending;
  // With the back key up in the header, the composer owns the bottom edge: when
  // the keyboard is up it rides just above it, otherwise it only clears the
  // home-indicator safe area.
  const composerPad = keyboardUp ? 8 : insets.bottom + 8;
  // Which picker is open, if any. Selection presents the platform's own
  // single-choice list (#567 D12) — the user picks the agent they want instead
  // of cycling through the dead ones. `selectHarness` still preflights and
  // reverts, so a chosen-but-unready harness surfaces as a selection error.
  const [picker, setPicker] = useState<"harness" | "model" | "effort" | null>(
    null
  );
  const pickerSpec: {
    title: string;
    options: SheetOption[];
    selectedId?: string;
    onSelect: (id: string) => void;
  } | null =
    !config || picker === null
      ? null
      : picker === "harness"
        ? {
            title: "Agent",
            options: config.harnesses.map((harness) => ({
              id: harness.kind,
              label: harness.label,
              ...(harness.hint ? { detail: harness.hint } : {}),
              ...(harness.sessionReady ? {} : { disabled: true }),
            })),
            ...(config.harnessKind ? { selectedId: config.harnessKind } : {}),
            onSelect: selectHarness,
          }
        : picker === "model"
          ? {
              title: "Model",
              options: config.models.map((model) => ({
                id: model.id,
                label: model.name,
              })),
              ...(config.selectedModel
                ? { selectedId: config.selectedModel }
                : {}),
              onSelect: selectModel,
            }
          : {
              title: "Effort",
              options: config.efforts.map((effort) => ({
                id: effort.id,
                label: effort.name,
              })),
              ...(config.selectedEffort
                ? { selectedId: config.selectedEffort }
                : {}),
              onSelect: selectEffort,
            };
  const contextRatio =
    context.used !== undefined && context.size
      ? Math.max(0, Math.min(1, context.used / context.size))
      : 0;

  return (
    <TopSafeArea style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to home"
          hitSlop={10}
          onPress={() => navigation.goBack()}
        >
          <Icon name="arrow-left" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title}>Assistant</Text>
          <Text style={styles.subtitle}>Ask about your vault</Text>
        </View>
      </View>

      {phase === "offline" ? (
        <View style={styles.emptyWrap}>
          <Icon name="cpu" size={30} color={colors.accent} />
          <Text style={styles.emptyTitle}>Not connected</Text>
          <Text style={styles.emptyBody}>
            Pair your desktop in Settings to chat with your assistant.
          </Text>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.safe}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <FlatList
            ref={listRef}
            data={bubbles}
            keyExtractor={bubbleKey}
            contentContainerStyle={styles.list}
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: true })
            }
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                {phase === "connecting" ? (
                  <Text style={styles.emptyBody}>Opening your assistant…</Text>
                ) : (
                  <>
                    <Icon
                      name="message-circle"
                      size={28}
                      color={colors.accent}
                    />
                    <Text style={styles.emptyTitle}>
                      {loadError ? "Couldn't load history" : "Say hello"}
                    </Text>
                    <Text style={styles.emptyBody}>
                      {loadError ?? "Ask anything about your vault."}
                    </Text>
                  </>
                )}
              </View>
            }
            // No getItemLayout and no windowing overrides: bubble height is
            // whatever the prose wraps to, and this transcript scrolls itself
            // to the end on every content-size change — trimming the render
            // window (or clipping subviews, which misbehaves on Android
            // transcripts) would fight that scroll and blank the newest turn.
            renderItem={renderBubble}
          />

          <View style={[styles.composerWrap, { paddingBottom: composerPad }]}>
            <View style={styles.statusStrip}>
              <View
                style={[styles.activityDot, sending && styles.activityDotBusy]}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Change assistant agent"
                onPress={() => setPicker("harness")}
                disabled={!config?.harnesses.length || sending}
                style={styles.statusChip}
              >
                <Text numberOfLines={1} style={styles.statusText}>
                  {config?.harnesses.find(
                    (harness) => harness.kind === config.harnessKind
                  )?.label ??
                    config?.harnessKind ??
                    "Agent"}
                </Text>
              </Pressable>
              {config?.models.length ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Change assistant model"
                  onPress={() => setPicker("model")}
                  disabled={sending}
                  style={styles.statusChip}
                >
                  <Text numberOfLines={1} style={styles.statusText}>
                    {config.models.find(
                      (model) => model.id === config.selectedModel
                    )?.name ??
                      config.selectedModel ??
                      "Default model"}
                  </Text>
                </Pressable>
              ) : null}
              {config?.efforts.length ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Change assistant effort"
                  onPress={() => setPicker("effort")}
                  disabled={sending}
                  style={styles.statusChip}
                >
                  <Text numberOfLines={1} style={styles.statusText}>
                    {config.efforts.find(
                      (effort) => effort.id === config.selectedEffort
                    )?.name ??
                      config.selectedEffort ??
                      "Default effort"}
                  </Text>
                </Pressable>
              ) : null}
              {config?.supportsContext && context.size ? (
                <View
                  accessibilityRole="progressbar"
                  accessibilityLabel="Context usage"
                  accessibilityValue={{
                    min: 0,
                    max: 100,
                    now: Math.round(contextRatio * 100),
                  }}
                  style={styles.contextTrack}
                >
                  <View
                    style={[
                      styles.contextFill,
                      { width: `${contextRatio * 100}%` },
                    ]}
                  />
                </View>
              ) : null}
            </View>
            {selectionError ? (
              <Text style={styles.selectionError}>{selectionError}</Text>
            ) : null}
            {attachments.length ? (
              <View style={styles.attachmentRow}>
                {attachments.map((attachment) => (
                  <Pressable
                    key={attachment.hash}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${attachment.filename}`}
                    onPress={() => removeAttachment(attachment.hash)}
                    style={styles.attachmentChip}
                  >
                    <Icon name="paperclip" size={12} color={colors.textSoft} />
                    <Text numberOfLines={1} style={styles.statusText}>
                      {attachment.filename}
                    </Text>
                    <Icon name="x" size={12} color={colors.textSoft} />
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View style={styles.composer}>
              {config?.supportsAttachments ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Attach a file"
                  onPress={attach}
                  disabled={attaching || sending}
                  style={styles.attachButton}
                >
                  <Icon name="paperclip" size={18} color={colors.textSoft} />
                </Pressable>
              ) : null}
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Message your assistant"
                placeholderTextColor={colors.textFaint}
                style={styles.input}
                multiline
                editable={phase === "ready"}
                onSubmitEditing={submit}
                blurOnSubmit={false}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={sending ? "Stop response" : "Send message"}
                disabled={!sending && !canSend}
                onPress={sending ? stop : submit}
                style={[
                  styles.sendButton,
                  !sending && !canSend && styles.sendButtonDisabled,
                ]}
              >
                <Icon
                  name={sending ? "square" : "arrow-up"}
                  size={sending ? 16 : 20}
                  color={sending || canSend ? colors.textInv : colors.textFaint}
                />
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}
      {pickerSpec ? (
        <OptionSheet
          visible
          title={pickerSpec.title}
          options={pickerSpec.options}
          {...(pickerSpec.selectedId
            ? { selectedId: pickerSpec.selectedId }
            : {})}
          onSelect={(id) => pickerSpec.onSelect(id)}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </TopSafeArea>
  );
}

const bubbleKey = (bubble: Bubble): string => bubble.key;

const BubbleRow = memo(
  ({
    bubble,
    styles,
  }: {
    bubble: Bubble;
    styles: ReturnType<typeof makeStyles>;
  }): React.JSX.Element => {
    if (bubble.role === "user") {
      return (
        <View style={styles.rowRight}>
          <View style={styles.userBubble}>
            <Text style={styles.userText}>{bubble.text}</Text>
          </View>
        </View>
      );
    }
    return (
      <View style={styles.rowLeft}>
        <View style={styles.assistantBubble}>
          {bubble.pending ? (
            <Text style={styles.pendingText}>Thinking…</Text>
          ) : (
            <Text
              style={bubble.error ? styles.errorText : styles.assistantText}
            >
              {bubble.text}
            </Text>
          )}
        </View>
      </View>
    );
  }
);
BubbleRow.displayName = "BubbleRow";
