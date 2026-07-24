import { StyleSheet } from 'react-native';

import { family, radii, spacing, t, type ThemeColors } from '../../kit/theme';

// makeStyles(colors) + useMemo per scheme (matches Settings). The composer row
// stays clear of the floating Home key via its own bottom padding; the bubbles
// read as a two-sided transcript — user on the right in the system accent,
// assistant on the left on an elevated card.
export const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    assistantBubble: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: 1,
      maxWidth: '86%',
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    assistantText: { ...t('body'), color: colors.ink },
    composer: {
      alignItems: 'flex-end',
      backgroundColor: colors.bgSunken,
      borderRadius: radii.lg,
      flexDirection: 'row',
      gap: spacing[2],
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
    },
    composerWrap: { paddingHorizontal: spacing[4], paddingTop: spacing[2] },
    emptyBody: { ...t('body'), color: colors.ink2, marginTop: spacing[2], textAlign: 'center' },
    emptyTitle: { ...t('title'), color: colors.ink, textAlign: 'center' },
    emptyWrap: {
      alignItems: 'center',
      flex: 1,
      justifyContent: 'center',
      paddingBottom: spacing[7],
      paddingHorizontal: spacing[6],
    },
    errorText: { ...t('body'), color: colors.danger },
    // Conversation-style header: the back key leads a name + status column,
    // vertically centered against the two lines (back · name · status).
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
    headerText: { flex: 1, minWidth: 0 },
    input: {
      ...t('body'),
      color: colors.ink,
      flex: 1,
      maxHeight: 120,
      paddingVertical: spacing[2],
    },
    list: {
      flexGrow: 1,
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[4],
    },
    pendingText: { ...t('body'), color: colors.ink3, fontStyle: 'italic' },
    rowLeft: { alignItems: 'flex-start' },
    rowRight: { alignItems: 'flex-end' },
    safe: { backgroundColor: colors.bg, flex: 1 },
    sendButton: {
      alignItems: 'center',
      backgroundColor: colors.accent,
      borderRadius: 18,
      height: 36,
      justifyContent: 'center',
      width: 36,
    },
    sendButtonDisabled: {
      backgroundColor: colors.bgSunken,
      borderColor: colors.line,
      borderWidth: 1,
    },
    subtitle: { ...t('small'), color: colors.ink2, marginTop: 2 },
    title: {
      color: colors.ink,
      fontFamily: family.serif,
      fontSize: 26,
      letterSpacing: -0.3,
    },
    userBubble: {
      backgroundColor: colors.accent,
      borderRadius: radii.lg,
      maxWidth: '86%',
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    userText: { ...t('body'), color: '#fff' },
  });
