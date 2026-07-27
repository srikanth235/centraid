import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { useTheme } from '../../kit/theme';
import type { AssistantScreenProps } from '../../navigation';
import { makeStyles } from './Assistant.styles';
import { useAssistant, type Bubble } from './useAssistant';

// The vault assistant chat — a full-page cover over Home (springboard model).
// Chrome mirrors the other covers: a serif title and the teal leave key. The
// cover exits via that key (full-screen modal, no pull-down). The composer rises
// with the keyboard; v0 sends a buffered turn (no incremental streaming — see
// src/lib/assistant.ts for the expo/fetch upgrade path).
export default function AssistantScreen({ navigation }: AssistantScreenProps): React.JSX.Element {
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
    selectRunner,
    selectModel,
    selectEffort,
  } = useAssistant();
  const [draft, setDraft] = useState('');
  const [keyboardUp, setKeyboardUp] = useState(false);
  const listRef = useRef<FlatList<Bubble>>(null);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setKeyboardUp(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboardUp(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    if (!pendingConsent) return;
    Alert.alert('Share with another provider?', pendingConsent.message, [
      { text: 'Cancel', style: 'cancel', onPress: declineConsent },
      { text: `Allow ${pendingConsent.provider}`, onPress: approveConsent },
    ]);
  }, [approveConsent, declineConsent, pendingConsent]);

  const submit = (): void => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || sending) return;
    send(text || 'Please review the attached file.');
    setDraft('');
  };

  const canSend = (draft.trim().length > 0 || attachments.length > 0) && !sending;
  // With the back key up in the header, the composer owns the bottom edge: when
  // the keyboard is up it rides just above it, otherwise it only clears the
  // home-indicator safe area.
  const composerPad = keyboardUp ? 8 : insets.bottom + 8;
  const cycleModel = (): void => {
    if (!config || config.models.length === 0) return;
    const index = config.models.findIndex((model) => model.id === config.selectedModel);
    selectModel(config.models[(index + 1) % config.models.length]!.id);
  };
  const cycleRunner = (): void => {
    if (!config) return;
    if (config.runners.length === 0) return;
    const index = config.runners.findIndex((runner) => runner.kind === config.runnerKind);
    selectRunner(config.runners[(index + 1) % config.runners.length]!.kind);
  };
  const cycleEffort = (): void => {
    if (!config || config.efforts.length === 0) return;
    const index = config.efforts.findIndex((effort) => effort.id === config.selectedEffort);
    selectEffort(config.efforts[(index + 1) % config.efforts.length]!.id);
  };
  const contextRatio =
    context.used !== undefined && context.size
      ? Math.max(0, Math.min(1, context.used / context.size))
      : 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to home"
          hitSlop={10}
          onPress={() => navigation.goBack()}
        >
          <Feather name="arrow-left" size={26} color={colors.ink} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title}>Assistant</Text>
          <Text style={styles.subtitle}>Ask about your space</Text>
        </View>
      </View>

      {phase === 'offline' ? (
        <View style={styles.emptyWrap}>
          <Feather name="cpu" size={30} color={colors.accent} />
          <Text style={styles.emptyTitle}>Not connected</Text>
          <Text style={styles.emptyBody}>
            Connect your desktop to chat with your assistant. Pair it in Settings.
          </Text>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.safe}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <FlatList
            ref={listRef}
            data={bubbles}
            keyExtractor={(b) => b.key}
            contentContainerStyle={styles.list}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                {phase === 'connecting' ? (
                  <Text style={styles.emptyBody}>Opening your assistant…</Text>
                ) : (
                  <>
                    <Feather name="message-circle" size={28} color={colors.accent} />
                    <Text style={styles.emptyTitle}>
                      {loadError ? "Couldn't load history" : 'Say hello'}
                    </Text>
                    <Text style={styles.emptyBody}>
                      {loadError ?? 'Ask your assistant anything about your space to get started.'}
                    </Text>
                  </>
                )}
              </View>
            }
            renderItem={({ item }) => <BubbleRow bubble={item} styles={styles} />}
          />

          <View style={[styles.composerWrap, { paddingBottom: composerPad }]}>
            <View style={styles.statusStrip}>
              <View style={[styles.activityDot, sending && styles.activityDotBusy]} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Change assistant runner"
                onPress={cycleRunner}
                disabled={!config?.runners.length || sending}
                style={styles.statusChip}
              >
                <Text numberOfLines={1} style={styles.statusText}>
                  {config?.runners.find((runner) => runner.kind === config.runnerKind)?.label ??
                    config?.runnerKind ??
                    'Agent'}
                </Text>
              </Pressable>
              {config?.models.length ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Change assistant model"
                  onPress={cycleModel}
                  disabled={sending}
                  style={styles.statusChip}
                >
                  <Text numberOfLines={1} style={styles.statusText}>
                    {config.models.find((model) => model.id === config.selectedModel)?.name ??
                      config.selectedModel ??
                      'Default model'}
                  </Text>
                </Pressable>
              ) : null}
              {config?.efforts.length ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Change assistant effort"
                  onPress={cycleEffort}
                  disabled={sending}
                  style={styles.statusChip}
                >
                  <Text numberOfLines={1} style={styles.statusText}>
                    {config.efforts.find((effort) => effort.id === config.selectedEffort)?.name ??
                      config.selectedEffort ??
                      'Default effort'}
                  </Text>
                </Pressable>
              ) : null}
              {config?.supportsContext && context.size ? (
                <View
                  accessibilityRole="progressbar"
                  accessibilityLabel="Context usage"
                  accessibilityValue={{ min: 0, max: 100, now: Math.round(contextRatio * 100) }}
                  style={styles.contextTrack}
                >
                  <View style={[styles.contextFill, { width: `${contextRatio * 100}%` }]} />
                </View>
              ) : null}
            </View>
            {selectionError ? <Text style={styles.selectionError}>{selectionError}</Text> : null}
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
                    <Feather name="paperclip" size={12} color={colors.ink2} />
                    <Text numberOfLines={1} style={styles.statusText}>
                      {attachment.filename}
                    </Text>
                    <Feather name="x" size={12} color={colors.ink2} />
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
                  <Feather name="paperclip" size={18} color={colors.ink2} />
                </Pressable>
              ) : null}
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Message your assistant"
                placeholderTextColor={colors.ink3}
                style={styles.input}
                multiline
                editable={phase === 'ready'}
                onSubmitEditing={submit}
                blurOnSubmit={false}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={sending ? 'Stop response' : 'Send message'}
                disabled={!sending && !canSend}
                onPress={sending ? stop : submit}
                style={[styles.sendButton, !sending && !canSend && styles.sendButtonDisabled]}
              >
                <Feather
                  name={sending ? 'square' : 'arrow-up'}
                  size={sending ? 16 : 20}
                  color={sending || canSend ? colors.inkInv : colors.ink3}
                />
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

function BubbleRow({
  bubble,
  styles,
}: {
  bubble: Bubble;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  if (bubble.role === 'user') {
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
          <Text style={bubble.error ? styles.errorText : styles.assistantText}>{bubble.text}</Text>
        )}
      </View>
    </View>
  );
}
