import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from '../../components/Icon';
import { family, t, useTheme, type ThemeColors } from '../../theme';
import type { PhotosScreenProps } from '../../navigation';
import { usePhotoTimeline } from './timeline-source';

// Native Photos home. M0.5 ships the themed shell + empty state; M1 mounts
// the real timeline at the `usePhotoTimeline()` seam (see timeline-source.ts).
export default function PhotosHome(_props: PhotosScreenProps<'PhotosHome'>): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const timeline = usePhotoTimeline();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Photos</Text>
      </View>

      {timeline.kind === 'empty' ? (
        <View style={styles.empty}>
          <View style={styles.glyph}>
            <Icon name="Camera" size={34} color={colors.accent} strokeWidth={1.5} />
          </View>
          <Text style={styles.emptyTitle}>Your photos, on your terms.</Text>
          <Text style={styles.emptyCopy}>
            Backup and a scrollable timeline of everything on your devices land next. For now this
            is the home they'll live in.
          </Text>
          <Text style={styles.emptyHint}>Coming in M1</Text>
        </View>
      ) : (
        // M1 renders the loading / ready timeline states here.
        <View style={styles.empty}>
          <Text style={styles.emptyCopy}>Loading your timeline…</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    empty: {
      alignItems: 'center',
      flex: 1,
      justifyContent: 'center',
      paddingBottom: 64,
      paddingHorizontal: 32,
    },
    emptyCopy: {
      ...t('body'),
      color: colors.ink2,
      marginBottom: 16,
      textAlign: 'center',
    },
    emptyHint: {
      ...t('tiny'),
      color: colors.ink3,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
    },
    emptyTitle: {
      ...t('title'),
      color: colors.ink,
      marginBottom: 8,
      textAlign: 'center',
    },
    glyph: {
      alignItems: 'center',
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: 20,
      borderWidth: 1,
      height: 80,
      justifyContent: 'center',
      marginBottom: 20,
      width: 80,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 44,
      paddingHorizontal: 22,
      paddingVertical: 4,
    },
    safe: { backgroundColor: colors.bg, flex: 1 },
    title: {
      color: colors.ink,
      fontFamily: family.displayBold,
      fontSize: 20,
      letterSpacing: -0.4,
    },
  });
