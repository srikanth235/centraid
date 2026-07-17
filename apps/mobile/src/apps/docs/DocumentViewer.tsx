import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { WebView } from 'react-native-webview';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';

import { authHeader } from '../../lib/gateway';
import { family, useTheme } from '../../kit/theme';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import type { DocsScreenProps } from '../../navigation';
import type { NativeDocument } from './docs-model';
import { useDocsLibrary } from './useDocsLibrary';

function StreamViewer({
  source,
}: {
  source: { uri: string; headers: Record<string, string> };
}): React.JSX.Element {
  const player = useVideoPlayer(source);
  return <VideoView player={player} nativeControls contentFit="contain" style={styles.viewer} />;
}

function Viewer({ document, url }: { document: NativeDocument; url: string }): React.JSX.Element {
  const source = { uri: url, headers: authHeader() };
  if (document.mediaType.startsWith('image/'))
    return <Image source={source} contentFit="contain" style={styles.viewer} />;
  if (document.mediaType.startsWith('video/') || document.mediaType.startsWith('audio/'))
    return <StreamViewer source={source} />;
  return <WebView source={source} style={styles.viewer} allowsInlineMediaPlayback />;
}

export default function DocumentViewer({
  route,
  navigation,
}: DocsScreenProps<'DocumentViewer'>): React.JSX.Element {
  const { colors } = useTheme();
  const { session, gatewayBase } = useReplica();
  const drive = useDocsLibrary();
  const document = drive.documents.find((item) => item.id === route.params.documentId);
  const url =
    document && gatewayBase
      ? `${gatewayBase}/centraid/_vault/blobs/${encodeURIComponent(document.contentId)}${document.mediaType.startsWith('image/') || document.mediaType === 'application/pdf' ? '?variant=preview' : ''}`
      : '';
  const action = async (name: string): Promise<void> => {
    if (!document || !session) return;
    try {
      const result = await session.write('docs', {
        action: name,
        input: { document_id: document.id },
      });
      // A parked write (e.g. moving to trash is medium-risk) must surface for
      // Approve/Discard rather than silently vanish (M5); denials/failures are
      // shown, not swallowed.
      if (result.status === 'parked' || result.status === 'queued') {
        navigation.navigate('Tabs', {
          screen: 'SettingsTab',
          params: { screen: 'Approvals' },
        });
      } else if (result.status === 'denied' || result.status === 'failed') {
        Alert.alert('Not applied', result.reason ?? 'The vault rejected this change.');
      }
    } catch (error) {
      Alert.alert('Action failed', error instanceof Error ? error.message : 'Please try again.');
    }
  };
  const share = async (): Promise<void> => {
    if (!document || !url) return;
    const file = await File.downloadFileAsync(
      url.replace('?variant=preview', ''),
      new File(Paths.cache, document.title),
      { headers: authHeader(), idempotent: true },
    );
    if (await Sharing.isAvailableAsync())
      await Sharing.shareAsync(file.uri, { mimeType: document.mediaType });
  };
  if (!document) return <View style={[styles.viewer, { backgroundColor: colors.bg }]} />;
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Feather name="chevron-left" size={26} color={colors.ink} />
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: colors.ink }]}>
          {document.title}
        </Text>
        <Pressable onPress={() => void share()}>
          <Feather name="share" size={21} color={colors.accent} />
        </Pressable>
      </View>
      <Viewer document={document} url={url} />
      <View style={[styles.toolbar, { borderTopColor: colors.line }]}>
        <Pressable onPress={() => void action(document.starred ? 'unstar' : 'star')}>
          <Feather name="star" size={21} color={document.starred ? '#d99b18' : colors.ink2} />
        </Pressable>
        <Text style={[styles.meta, { color: colors.ink2 }]}>
          {document.mediaType} · {document.custody ?? 'local'}
        </Text>
        <Pressable
          onPress={() =>
            Alert.alert(
              'Move to trash?',
              'The current document and its version history remain restorable until vault purge.',
              [
                { text: 'Cancel' },
                { text: 'Trash', style: 'destructive', onPress: () => void action('trash') },
              ],
            )
          }
        >
          <Feather name="trash-2" size={20} color={colors.danger} />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    minHeight: 50,
    paddingHorizontal: 14,
  },
  meta: { flex: 1, fontFamily: family.sansRegular, fontSize: 11, textAlign: 'center' },
  safe: { flex: 1 },
  title: { flex: 1, fontFamily: family.sansBold, fontSize: 15 },
  toolbar: {
    alignItems: 'center',
    borderTopWidth: 1,
    flexDirection: 'row',
    height: 52,
    justifyContent: 'space-between',
    paddingHorizontal: 22,
  },
  viewer: { flex: 1 },
});
