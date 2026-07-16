import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from '../kit/components/Icon';
import Button from '../kit/components/Button';
import { radii, spacing, t, useTheme, type ThemeColors } from '../kit/theme';
import type { RootScreenProps } from '../navigation';

// Mobile fallback for the desktop Builder. The mobile app is for *using*
// your tiny apps; building new ones is a desktop-only flow for now.
export default function MobileFallbackScreen({
  navigation,
}: RootScreenProps<'MobileFallback'>): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.bar}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={12}>
          <Icon name="X" size={22} color={colors.ink} />
        </Pressable>
      </View>

      <View style={styles.body}>
        <View style={styles.glyph}>
          <Icon name="Sparkle" size={40} color={colors.accent} strokeWidth={1.5} />
        </View>

        <Text style={styles.title}>Build on the desktop.</Text>
        <Text style={styles.copy}>
          Centraid's builder is a chat-driven canvas — designed for a keyboard and a wider screen.
          Open Centraid on your Mac to describe a new app and watch it appear.
        </Text>

        <View style={styles.steps}>
          <Step num="1" text="Open Centraid on your computer." styles={styles} />
          <Step num="2" text='Tap "New app" and describe what you want.' styles={styles} />
          <Step num="3" text="It'll show up on this home screen." styles={styles} />
        </View>

        <View style={styles.footer}>
          <Button label="Got it" icon="Check" onPress={() => navigation.goBack()} />
        </View>
      </View>
    </SafeAreaView>
  );
}

interface StepProps {
  num: string;
  text: string;
  styles: ReturnType<typeof makeStyles>;
}
function Step({ num, text, styles }: StepProps): React.JSX.Element {
  return (
    <View style={styles.step}>
      <View style={styles.stepNum}>
        <Text style={styles.stepNumText}>{num}</Text>
      </View>
      <Text style={styles.stepText}>{text}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    bar: { alignItems: 'flex-end', padding: spacing[4] },
    body: { flex: 1, padding: spacing[5], paddingTop: spacing[4] },
    copy: { ...t('body'), color: colors.ink2, marginBottom: spacing[5] },
    footer: { alignItems: 'stretch', marginTop: 'auto' },
    glyph: {
      alignItems: 'center',
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: 1,
      height: 72,
      justifyContent: 'center',
      marginBottom: spacing[4],
      width: 72,
    },
    safe: { backgroundColor: colors.bg, flex: 1 },
    step: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing[3] },
    stepNum: {
      alignItems: 'center',
      backgroundColor: colors.ink,
      borderRadius: 12,
      height: 24,
      justifyContent: 'center',
      marginTop: 2,
      width: 24,
    },
    stepNumText: { ...t('tiny'), color: colors.inkInv, fontWeight: '600' },
    stepText: { ...t('body'), color: colors.ink, flex: 1 },
    steps: { gap: spacing[3] },
    title: { ...t('display'), color: colors.ink, marginBottom: spacing[2] },
  });
