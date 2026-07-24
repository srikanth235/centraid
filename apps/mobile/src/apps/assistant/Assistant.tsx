import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
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
  const { phase, bubbles, sending, loadError, send } = useAssistant();
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

  const submit = (): void => {
    const text = draft.trim();
    if (!text || sending) return;
    send(text);
    setDraft('');
  };

  const canSend = draft.trim().length > 0 && !sending;
  // With the back key up in the header, the composer owns the bottom edge: when
  // the keyboard is up it rides just above it, otherwise it only clears the
  // home-indicator safe area.
  const composerPad = keyboardUp ? 8 : insets.bottom + 8;

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
            <View style={styles.composer}>
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
                accessibilityLabel="Send message"
                disabled={!canSend}
                onPress={submit}
                style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
              >
                <Feather name="arrow-up" size={20} color={canSend ? '#fff' : colors.ink3} />
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
