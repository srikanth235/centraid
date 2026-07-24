import React, { useMemo } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { family, useTheme } from '../../kit/theme';
import type { ThemeColors } from '../../kit/theme/resolve';

const onDesktop = (feature: string): void => {
  Alert.alert('Available on desktop', `${feature} lives on the Centraid desktop app for now.`);
};

// The "Make something" grid — colours are fixed brand hexes from the design,
// not theme tokens (they read the same in light and dark).
const MAKE: Array<{
  key: string;
  color: string;
  icon: keyof typeof Feather.glyphMap;
  title: string;
  subtitle: string;
  badge?: string;
}> = [
  {
    key: 'album',
    color: '#4E68DD',
    icon: 'image',
    title: 'Album',
    subtitle: 'Group photos to share',
  },
  {
    key: 'collage',
    color: '#E55772',
    icon: 'grid',
    title: 'Collage',
    subtitle: 'Combine up to nine',
  },
  {
    key: 'highlight',
    color: '#E89A3C',
    icon: 'film',
    title: 'Highlight video',
    subtitle: 'Auto-cut, set to music',
    badge: 'NEW',
  },
  {
    key: 'cinematic',
    color: '#7C5BD9',
    icon: 'film',
    title: 'Cinematic photo',
    subtitle: 'Add depth and motion',
  },
  {
    key: 'animation',
    color: '#2EA098',
    icon: 'copy',
    title: 'Animation',
    subtitle: 'Loop a photo burst',
  },
  {
    key: 'remix',
    color: '#B47B3F',
    icon: 'maximize-2',
    title: 'Remix',
    subtitle: 'Restyle with AI',
  },
  {
    key: 'video-remix',
    color: '#5C8A4E',
    icon: 'play-circle',
    title: 'Video remix',
    subtitle: 'Recut an existing clip',
  },
  { key: 'book', color: '#5C677D', icon: 'book', title: 'Photo book', subtitle: 'Print and bind' },
];

const GET: Array<{
  key: string;
  icon: keyof typeof Feather.glyphMap;
  title: string;
  subtitle: string;
}> = [
  {
    key: 'partner',
    icon: 'share-2',
    title: 'Share with a partner',
    subtitle: 'Auto-share photos of the people you choose',
  },
  {
    key: 'import',
    icon: 'upload',
    title: 'Import from other places',
    subtitle: 'Bring in photos from a drive or another app',
  },
];

export default function PhotosCreateView(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <View style={styles.heroCard}>
        <View style={styles.heroMedia}>
          <View style={styles.chip}>
            <Text style={styles.chipText}>VIDEO · italy_2026.mp4</Text>
          </View>
          <View style={styles.playCircle}>
            <Feather name="play" size={22} color="#fff" />
          </View>
          <View style={[styles.autoPill, { backgroundColor: colors.accent }]}>
            <Feather name="star" size={12} color="#fff" />
            <Text style={styles.autoPillText}>Auto-made</Text>
          </View>
        </View>
        <View style={styles.heroBody}>
          <Text style={[styles.eyebrow, { color: colors.ink3 }]}>HIGHLIGHT VIDEO</Text>
          <Text style={[styles.heroTitle, { color: colors.ink }]}>Italy 2026 · 0:48</Text>
          <Text style={[styles.heroCopy, { color: colors.ink2 }]}>
            Centraid picked 24 clips and photos from your trip and set them to music.
          </Text>
          <View style={styles.heroButtons}>
            <Pressable
              style={[styles.primaryBtn, { backgroundColor: colors.accent }]}
              onPress={() => onDesktop('Highlight video preview')}
            >
              <Feather name="play" size={15} color="#fff" />
              <Text style={styles.primaryBtnText}>Preview</Text>
            </Pressable>
            <Pressable
              style={[styles.secondaryBtn, { borderColor: colors.lineStrong }]}
              onPress={() => onDesktop('Clip editing')}
            >
              <Text style={[styles.secondaryBtnText, { color: colors.ink }]}>Edit clips</Text>
            </Pressable>
          </View>
        </View>
      </View>

      <Text style={[styles.eyebrow, styles.sectionEyebrow, { color: colors.ink3 }]}>
        MAKE SOMETHING
      </Text>
      <View style={styles.makeGrid}>
        {MAKE.map((item) => (
          <Pressable
            key={item.key}
            style={[styles.makeCard, { borderColor: colors.line, backgroundColor: colors.bgElev }]}
            onPress={() => onDesktop(item.title)}
          >
            {item.badge ? (
              <View style={[styles.badge, { backgroundColor: colors.bgSunken }]}>
                <Text style={[styles.badgeText, { color: colors.accent }]}>{item.badge}</Text>
              </View>
            ) : null}
            <View style={[styles.makeIcon, { backgroundColor: item.color }]}>
              <Feather name={item.icon} size={20} color="#fff" />
            </View>
            <View>
              <Text style={[styles.makeTitle, { color: colors.ink }]}>{item.title}</Text>
              <Text style={[styles.makeSub, { color: colors.ink3 }]}>{item.subtitle}</Text>
            </View>
          </Pressable>
        ))}
      </View>

      <Text style={[styles.eyebrow, styles.sectionEyebrow, { color: colors.ink3 }]}>
        GET PHOTOS
      </Text>
      <View style={styles.getList}>
        {GET.map((item, index) => (
          <Pressable
            key={item.key}
            onPress={() => onDesktop(item.title)}
            style={[
              styles.getRow,
              index === GET.length - 1
                ? null
                : { borderBottomColor: colors.line, borderBottomWidth: 0.5 },
            ]}
          >
            <View style={[styles.getTile, { backgroundColor: colors.bgSunken }]}>
              <Feather name={item.icon} size={19} color={colors.ink2} />
            </View>
            <View style={styles.getText}>
              <Text style={[styles.getTitle, { color: colors.ink }]}>{item.title}</Text>
              <Text style={[styles.getSub, { color: colors.ink3 }]}>{item.subtitle}</Text>
            </View>
            <Feather name="chevron-right" size={18} color={colors.ink4} />
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors): ReturnType<typeof StyleSheet.create> =>
  StyleSheet.create({
    autoPill: {
      alignItems: 'center',
      borderRadius: 999,
      flexDirection: 'row',
      gap: 5,
      paddingHorizontal: 9,
      paddingVertical: 5,
      position: 'absolute',
      right: 11,
      top: 11,
    },
    autoPillText: { color: '#fff', fontFamily: family.sansBold, fontSize: 10 },
    badge: {
      borderRadius: 6,
      paddingHorizontal: 7,
      paddingVertical: 3,
      position: 'absolute',
      right: 12,
      top: 12,
      zIndex: 1,
    },
    badgeText: { fontFamily: family.sansBold, fontSize: 9, letterSpacing: 0.4 },
    chip: {
      backgroundColor: 'rgba(0,0,0,.3)',
      borderRadius: 6,
      left: 11,
      paddingHorizontal: 7,
      paddingVertical: 5,
      position: 'absolute',
      top: 11,
    },
    chipText: {
      color: 'rgba(255,255,255,.9)',
      fontFamily: family.monoMedium,
      fontSize: 9,
      letterSpacing: 0.5,
    },
    eyebrow: {
      fontFamily: family.monoMedium,
      fontSize: 11,
      letterSpacing: 0.9,
    },
    getList: { paddingHorizontal: 16 },
    getRow: { alignItems: 'center', flexDirection: 'row', gap: 13, paddingVertical: 13 },
    getSub: { fontFamily: family.sansRegular, fontSize: 13, marginTop: 1 },
    getText: { flex: 1, minWidth: 0 },
    getTile: {
      alignItems: 'center',
      borderRadius: 11,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    getTitle: { fontFamily: family.sansRegular, fontSize: 15 },
    heroBody: { padding: 15 },
    heroButtons: { flexDirection: 'row', gap: 9, marginTop: 14 },
    heroCard: {
      borderColor: colors.line,
      borderRadius: 16,
      borderWidth: 0.5,
      marginBottom: 4,
      marginHorizontal: 16,
      overflow: 'hidden',
    },
    heroCopy: { fontFamily: family.sansRegular, fontSize: 13, lineHeight: 18, marginTop: 5 },
    heroMedia: { backgroundColor: '#a06f7a', height: 132 },
    heroTitle: {
      fontFamily: family.displayBold,
      fontSize: 18,
      letterSpacing: -0.4,
      marginTop: 6,
    },
    makeCard: {
      borderRadius: 14,
      borderWidth: 0.5,
      gap: 11,
      padding: 14,
      width: '48%',
    },
    makeGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 11,
      justifyContent: 'space-between',
      paddingHorizontal: 16,
    },
    makeIcon: {
      alignItems: 'center',
      borderRadius: 10,
      height: 38,
      justifyContent: 'center',
      width: 38,
    },
    makeSub: { fontFamily: family.sansRegular, fontSize: 13, marginTop: 2 },
    makeTitle: { fontFamily: family.sansBold, fontSize: 14 },
    playCircle: {
      alignItems: 'center',
      backgroundColor: 'rgba(0,0,0,.42)',
      borderRadius: 25,
      height: 50,
      left: '50%',
      justifyContent: 'center',
      marginLeft: -25,
      marginTop: -25,
      position: 'absolute',
      top: '50%',
      width: 50,
    },
    primaryBtn: {
      alignItems: 'center',
      borderRadius: 11,
      flexDirection: 'row',
      gap: 7,
      height: 40,
      paddingHorizontal: 18,
    },
    primaryBtnText: { color: '#fff', fontFamily: family.sansBold, fontSize: 14 },
    scroll: { paddingBottom: 24, paddingTop: 2 },
    secondaryBtn: {
      alignItems: 'center',
      borderRadius: 11,
      borderWidth: 0.5,
      height: 40,
      justifyContent: 'center',
      paddingHorizontal: 16,
    },
    secondaryBtnText: { fontFamily: family.sansBold, fontSize: 14 },
    sectionEyebrow: { paddingBottom: 12, paddingHorizontal: 16, paddingTop: 24 },
  });
