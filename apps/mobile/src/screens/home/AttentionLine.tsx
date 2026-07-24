// The attention-first strip that sits directly under the greeting (issue #498,
// Slice B change #3). It is the launcher's "what needs me right now" line and
// replaces BOTH the old full-width "Connect your computer" banner and the
// "Automations" tile — those blocks are gone.
//
// The rule is calm-by-default: cards only appear when they carry a real signal.
//   · not paired / offline → one prominent card that routes to pairing;
//   · paired → a horizontal strip of compact cards for pending approvals and
//     available automations, only when their counts are non-zero;
//   · paired with nothing pending → a single quiet "all caught up" line.
// So a settled, connected home shows one calm line, and a home that needs the
// owner shows exactly the cards that do.

import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Icon from '../../kit/components/Icon';
import { family, t, useTheme, type ThemeColors } from '../../kit/theme';
import type { IconName } from '@centraid/design-tokens';

// Mirrors Home's load state, minus the resolved app payload — this component
// only needs to know whether the desktop is reachable, not what it returned.
export type ConnectionState =
  | { kind: 'loading' }
  | { kind: 'no-gateway' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export interface AttentionLineProps {
  connection: ConnectionState;
  /** Pending parked invocations awaiting the owner's approval. */
  approvals: number;
  /** Automation rows installed on the paired desktop. */
  automations: number;
  onApprovals(): void;
  onAutomations(): void;
  /** Route to Settings → pairing. */
  onPair(): void;
}

export default function AttentionLine({
  connection,
  approvals,
  automations,
  onApprovals,
  onAutomations,
  onPair,
}: AttentionLineProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // While we're still resolving the gateway there's nothing honest to say yet;
  // the dimmed grid already reads as "not connected", so stay silent.
  if (connection.kind === 'loading') return null;

  if (connection.kind === 'no-gateway') {
    return (
      <View style={styles.wrap}>
        <BannerCard
          tone="pair"
          icon="Monitor"
          title="Connect your computer"
          copy="Pair once to bring every app you build into this launcher."
          action="Pair desktop"
          onPress={onPair}
          styles={styles}
          colors={colors}
        />
      </View>
    );
  }

  if (connection.kind === 'error') {
    return (
      <View style={styles.wrap}>
        <BannerCard
          tone="error"
          icon="AlertCircle"
          title="Desktop is offline"
          copy={connection.message}
          action="Check settings"
          onPress={onPair}
          styles={styles}
          colors={colors}
        />
      </View>
    );
  }

  // Paired. Assemble compact cards only for live signals.
  const hasApprovals = approvals > 0;
  const hasAutomations = automations > 0;

  if (!hasApprovals && !hasAutomations) {
    return (
      <View style={styles.wrap}>
        <View style={styles.allClear}>
          <View style={[styles.dot, { backgroundColor: colors.accent }]} />
          <Text style={styles.allClearText}>You&rsquo;re all caught up.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
      >
        {hasApprovals ? (
          <ChipCard
            icon="Bell"
            count={approvals}
            title="Approvals"
            sub={approvals === 1 ? '1 waiting on you' : `${approvals} waiting on you`}
            onPress={onApprovals}
            styles={styles}
            colors={colors}
          />
        ) : null}
        {hasAutomations ? (
          <ChipCard
            icon="Sparkle"
            title="Automations"
            sub={automations === 1 ? '1 available' : `${automations} available`}
            onPress={onAutomations}
            styles={styles}
            colors={colors}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

/** A compact, horizontally-scrolling signal card (approvals / automations). */
function ChipCard({
  icon,
  title,
  sub,
  count,
  onPress,
  styles,
  colors,
}: {
  icon: IconName;
  title: string;
  sub: string;
  count?: number;
  onPress(): void;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${sub}`}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
    >
      <View style={[styles.chipIcon, { backgroundColor: colors.accent }]}>
        <Icon name={icon} size={16} color="#fff" strokeWidth={1.8} />
      </View>
      <View style={styles.chipCopy}>
        <Text style={styles.chipTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.chipSub} numberOfLines={1}>
          {sub}
        </Text>
      </View>
      {count !== undefined ? (
        <View style={[styles.badge, { backgroundColor: colors.accent }]}>
          <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** The full-width pairing / offline banner (not-connected states). */
function BannerCard({
  tone,
  icon,
  title,
  copy,
  action,
  onPress,
  styles,
  colors,
}: {
  tone: 'pair' | 'error';
  icon: IconName;
  title: string;
  copy: string;
  action: string;
  onPress(): void;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}): React.JSX.Element {
  const accent = tone === 'error' ? (colors.danger ?? colors.accent) : colors.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${action}`}
      onPress={onPress}
      style={({ pressed }) => [styles.banner, pressed && styles.pressed]}
    >
      <View style={[styles.bannerIcon, { backgroundColor: accent }]}>
        <Icon name={icon} size={20} color="#fff" strokeWidth={1.7} />
      </View>
      <View style={styles.bannerCopy}>
        <Text style={styles.bannerTitle}>{title}</Text>
        <Text style={styles.bannerSub}>{copy}</Text>
      </View>
      <Text style={[styles.bannerAction, { color: accent }]}>{action}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    allClear: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
    },
    allClearText: { ...t('small'), color: colors.ink2 },
    badge: {
      alignItems: 'center',
      borderRadius: 10,
      justifyContent: 'center',
      minWidth: 20,
      paddingHorizontal: 5,
      paddingVertical: 1,
    },
    badgeText: { color: '#fff', fontFamily: family.sansBold, fontSize: 11 },
    banner: {
      alignItems: 'center',
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 14,
    },
    bannerAction: { ...t('small'), fontFamily: family.sansBold },
    bannerCopy: { flex: 1 },
    bannerIcon: {
      alignItems: 'center',
      borderRadius: 12,
      height: 42,
      justifyContent: 'center',
      width: 42,
    },
    bannerSub: { ...t('small'), color: colors.ink2, lineHeight: 18, marginTop: 2 },
    bannerTitle: { ...t('bodyStrong'), color: colors.ink },
    chip: {
      alignItems: 'center',
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    chipCopy: { maxWidth: 150 },
    chipIcon: {
      alignItems: 'center',
      borderRadius: 10,
      height: 32,
      justifyContent: 'center',
      width: 32,
    },
    chipSub: { ...t('tiny'), color: colors.ink3, marginTop: 1 },
    chipTitle: { ...t('small'), color: colors.ink, fontFamily: family.sansBold },
    dot: { borderRadius: 3, height: 6, width: 6 },
    pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
    strip: { flexDirection: 'row', gap: 10 },
    wrap: { marginBottom: 22 },
  });
