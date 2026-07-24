import { StyleSheet } from 'react-native';

import { family, radii, spacing, t, type ThemeColors } from '../../kit/theme';

export const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    safe: { backgroundColor: colors.bg, flex: 1 },
    header: { paddingBottom: spacing[3], paddingHorizontal: spacing[5], paddingTop: spacing[2] },
    title: { color: colors.ink, fontFamily: family.serif, fontSize: 30, letterSpacing: -0.4 },
    subtitle: { ...t('small'), color: colors.ink3, marginTop: 4 },
    scroll: { paddingBottom: spacing[6], paddingHorizontal: spacing[5] },

    sectionLabel: {
      color: colors.ink3,
      fontFamily: family.monoMedium,
      fontSize: 11,
      letterSpacing: 0.9,
      marginBottom: 10,
      marginTop: spacing[5],
    },

    // --- Gateway health hero ---
    hero: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: 1,
      overflow: 'hidden',
      padding: spacing[4],
    },
    heroTop: { alignItems: 'center', flexDirection: 'row', gap: 12 },
    heroDot: { borderRadius: 7, height: 14, width: 14 },
    heroStatus: { color: colors.ink, fontFamily: family.serif, fontSize: 20, letterSpacing: -0.2 },
    heroSub: { ...t('small'), color: colors.ink3, marginTop: 2 },
    heroMeta: { flex: 1, minWidth: 0 },

    // Metric chips strip inside the hero.
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: spacing[4] },
    chip: {
      backgroundColor: colors.bg,
      borderColor: colors.line,
      borderRadius: radii.sm,
      borderWidth: 1,
      flexGrow: 1,
      minWidth: 96,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    chipLabel: {
      color: colors.ink3,
      fontFamily: family.monoMedium,
      fontSize: 10,
      letterSpacing: 0.6,
    },
    chipValue: { color: colors.ink, fontFamily: family.monoBold, fontSize: 16, marginTop: 3 },

    // Components list.
    components: { gap: 2, marginTop: spacing[4] },
    compRow: { alignItems: 'center', flexDirection: 'row', gap: 10, paddingVertical: 9 },
    compDot: { borderRadius: 4, height: 8, width: 8 },
    compName: { ...t('body'), color: colors.ink, flexShrink: 1 },
    compDetail: {
      ...t('small'),
      color: colors.ink3,
      flex: 1,
      textAlign: 'right',
    },
    compError: { ...t('small'), color: colors.danger, marginLeft: 18, marginTop: -4 },
    divider: { backgroundColor: colors.line, height: StyleSheet.hairlineWidth },

    // Recent events tail.
    eventRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
    eventBadge: {
      borderRadius: 4,
      marginTop: 5,
      height: 7,
      width: 7,
    },
    eventBody: { flex: 1, minWidth: 0 },
    eventMsg: { ...t('small'), color: colors.ink2 },
    eventMeta: {
      color: colors.ink4,
      fontFamily: family.monoRegular,
      fontSize: 10,
      marginTop: 2,
    },

    // --- Usage KPIs ---
    kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    kpi: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      flexBasis: '47%',
      flexGrow: 1,
      padding: spacing[4],
    },
    kpiLabel: { alignItems: 'center', flexDirection: 'row', gap: 6 },
    kpiLabelText: {
      color: colors.ink3,
      fontFamily: family.monoMedium,
      fontSize: 10,
      letterSpacing: 0.5,
    },
    kpiValue: {
      color: colors.ink,
      fontFamily: family.monoBold,
      fontSize: 24,
      letterSpacing: -0.5,
      marginTop: 8,
    },
    kpiFoot: { ...t('small'), color: colors.ink3, marginTop: 4 },

    // Quota meter under the tokens KPI.
    meter: { marginTop: 8 },
    meterTrack: {
      backgroundColor: colors.bgSunken,
      borderRadius: 3,
      height: 6,
      overflow: 'hidden',
    },
    meterFill: { borderRadius: 3, height: 6 },
    meterFoot: {
      color: colors.ink3,
      fontFamily: family.monoRegular,
      fontSize: 10,
      marginTop: 5,
    },

    // --- Daily sparkline panel ---
    panel: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      marginTop: 10,
      padding: spacing[4],
    },
    panelHead: {
      alignItems: 'baseline',
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: spacing[3],
    },
    panelTitle: { ...t('bodyStrong'), color: colors.ink },
    panelMeta: {
      color: colors.ink3,
      fontFamily: family.monoMedium,
      fontSize: 10,
      letterSpacing: 0.5,
    },
    chartStats: { flexDirection: 'row', gap: spacing[5], marginBottom: spacing[3] },
    chartStatLabel: {
      color: colors.ink3,
      fontFamily: family.monoMedium,
      fontSize: 10,
      letterSpacing: 0.5,
    },
    chartStatValue: { color: colors.ink, fontFamily: family.monoBold, fontSize: 16, marginTop: 2 },
    chartAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
    chartAxisText: { color: colors.ink4, fontFamily: family.monoRegular, fontSize: 10 },

    // Model bars.
    model: { marginTop: spacing[3] },
    modelName: { ...t('small'), color: colors.ink2, marginBottom: 5 },
    modelFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
    modelFootText: { color: colors.ink3, fontFamily: family.monoRegular, fontSize: 11 },

    // Recent activity.
    act: { alignItems: 'center', flexDirection: 'row', gap: 12, paddingVertical: 9 },
    actAgo: {
      color: colors.ink4,
      fontFamily: family.monoRegular,
      fontSize: 11,
      width: 62,
    },
    actBody: { flex: 1, minWidth: 0 },
    actLabel: { ...t('body'), color: colors.ink },
    actKind: {
      color: colors.ink3,
      fontFamily: family.monoMedium,
      fontSize: 10,
      letterSpacing: 0.5,
      marginTop: 2,
    },
    actNums: { alignItems: 'flex-end' },
    actTokens: { color: colors.ink2, fontFamily: family.monoMedium, fontSize: 12 },
    actUsd: { color: colors.ink3, fontFamily: family.monoRegular, fontSize: 11, marginTop: 2 },

    // Section-level error / empty notes.
    note: {
      ...t('small'),
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      color: colors.ink3,
      overflow: 'hidden',
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    panelEmpty: { ...t('small'), color: colors.ink3, paddingVertical: spacing[2] },

    // Full-screen empty states.
    emptyWrap: {
      alignItems: 'center',
      gap: spacing[2],
      paddingHorizontal: spacing[5],
      paddingTop: 72,
    },
    emptyTitle: { ...t('title'), color: colors.ink, marginTop: spacing[2] },
    emptyCopy: { ...t('body'), color: colors.ink3, textAlign: 'center' },
    emptyHint: { ...t('small'), color: colors.ink4, marginTop: spacing[2] },
  });
