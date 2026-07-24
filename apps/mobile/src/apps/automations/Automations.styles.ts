import { StyleSheet } from 'react-native';

import { family, radii, spacing, t, type ThemeColors } from '../../kit/theme';

// StyleSheet keys stay alphabetized (repo convention). Colour comes from the
// resolved theme (solar-cream light / dark), so `makeStyles(colors)` is memoized
// per palette by the screen — no hardcoded hex beyond `#fff` on the teal pill,
// which mirrors the accent-glyph contrast used across the mobile apps.
export const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      gap: spacing[2],
      padding: spacing[4],
    },
    cardActions: { flexDirection: 'row', marginTop: spacing[2] },
    cardHead: { alignItems: 'center', flexDirection: 'row', gap: spacing[3] },
    cardName: { ...t('bodyStrong'), color: colors.ink, flex: 1 },
    description: { ...t('small'), color: colors.ink2, lineHeight: 19 },
    dim: { opacity: 0.55 },
    emptyCopy: { ...t('body'), color: colors.ink2, textAlign: 'center' },
    emptyHint: { ...t('small'), color: colors.ink3, textAlign: 'center' },
    emptyTitle: { ...t('title'), color: colors.ink, textAlign: 'center' },
    emptyWrap: {
      alignItems: 'center',
      gap: spacing[3],
      paddingTop: 72,
      paddingHorizontal: spacing[4],
    },
    // Leading back key + title/status column, centered as one header row.
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing[3],
      paddingBottom: spacing[3],
      paddingHorizontal: 18,
      paddingTop: spacing[2],
    },
    headerText: { flex: 1, minWidth: 0 },
    list: { gap: spacing[3], paddingHorizontal: 18, paddingTop: spacing[2] },
    runBtn: {
      alignItems: 'center',
      borderRadius: radii.md,
      borderWidth: 1,
      flexDirection: 'row',
      gap: spacing[2],
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    runText: { ...t('small'), color: colors.accent, fontFamily: family.sansMedium },
    safe: { backgroundColor: colors.bg, flex: 1 },
    scheduleRow: { alignItems: 'center', flexDirection: 'row', gap: 6 },
    scheduleText: { color: colors.ink3, fontFamily: family.monoMedium, fontSize: 11 },
    subtitle: { ...t('small'), color: colors.ink2, marginTop: 3 },
    title: { color: colors.ink, fontFamily: family.serif, fontSize: 28 },
    togglePill: {
      alignItems: 'center',
      borderRadius: 999,
      justifyContent: 'center',
      minWidth: 52,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    toggleText: { fontFamily: family.sansBold, fontSize: 11 },
  });
