import React, { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

import { backupDocument } from '../../lib/upload/media-producer';
import { family, useTheme } from '../../kit/theme';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import type { DocsScreenProps } from '../../navigation';
import { useDocsLibrary } from './useDocsLibrary';

export default function DocsHome({
  route,
  navigation,
}: DocsScreenProps<'DocsHome'>): React.JSX.Element {
  const { colors } = useTheme();
  const { session, gatewayBase } = useReplica();
  const drive = useDocsLibrary();
  const folderId = route.params?.folderId;
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Set<string>>();
  useEffect(() => {
    let active = true;
    if (!query.trim() || !session) {
      setMatches(undefined);
      return;
    }
    const timeout = setTimeout(
      () =>
        void session
          .search('docs', { entity: 'core.document', query: query.trim(), limit: 100 })
          .then((result) => {
            if (active)
              setMatches(new Set(result.rows.map((row) => String(row.values.document_id))));
          })
          .catch(() => {
            if (active) setMatches(new Set());
          }),
      160,
    );
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [query, session]);
  const documents = useMemo(
    () =>
      drive.documents.filter(
        (doc) =>
          !doc.trashed &&
          (!folderId ? !doc.folderId : doc.folderId === folderId) &&
          (!matches || matches.has(doc.id)),
      ),
    [drive.documents, folderId, matches],
  );
  const folders = drive.folders.filter((folder) =>
    !folderId ? !folder.parentId : folder.parentId === folderId,
  );

  const pick = async (): Promise<void> => {
    if (!session || !gatewayBase) {
      Alert.alert('Gateway unavailable', 'Reconnect before adding a document.');
      return;
    }
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true,
    });
    if (result.canceled) return;
    for (const asset of result.assets)
      await backupDocument(session, gatewayBase, {
        localUri: asset.uri,
        title: asset.name,
        mediaType: asset.mimeType ?? 'application/octet-stream',
        plaintextSize: asset.size ?? new File(asset.uri).size,
        ...(folderId ? { folderId } : {}),
      });
  };
  const parent = folderId ? drive.folders.find((folder) => folder.id === folderId) : undefined;
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top']}>
      <View style={styles.header}>
        {folderId ? (
          <Pressable onPress={() => navigation.goBack()}>
            <Feather name="chevron-left" size={26} color={colors.ink} />
          </Pressable>
        ) : (
          <Text style={[styles.title, { color: colors.ink }]}>Docs</Text>
        )}
        {folderId ? (
          <Text style={[styles.folderTitle, { color: colors.ink }]}>
            {parent?.name ?? 'Folder'}
          </Text>
        ) : (
          <View style={styles.spacer} />
        )}
        <Pressable onPress={() => void pick()}>
          <Feather name="plus" size={24} color={colors.accent} />
        </Pressable>
      </View>
      <View style={[styles.search, { backgroundColor: colors.bgSunken }]}>
        <Feather name="search" size={17} color={colors.ink2} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search documents offline"
          placeholderTextColor={colors.ink3}
          style={[styles.input, { color: colors.ink }]}
        />
      </View>
      <FlatList
        data={[
          ...folders.map((folder) => ({ kind: 'folder' as const, folder })),
          ...documents.map((document) => ({ kind: 'document' as const, document })),
        ]}
        keyExtractor={(item) =>
          item.kind === 'folder' ? `f:${item.folder.id}` : `d:${item.document.id}`
        }
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.ink2 }]}>
            {drive.loading ? 'Opening your drive…' : 'No documents here yet.'}
          </Text>
        }
        renderItem={({ item }) =>
          item.kind === 'folder' ? (
            <Pressable
              style={[styles.row, { borderBottomColor: colors.line }]}
              onPress={() => navigation.push('DocsHome', { folderId: item.folder.id })}
            >
              <View style={[styles.icon, { backgroundColor: colors.bgSunken }]}>
                <Feather name="folder" size={20} color={colors.accent} />
              </View>
              <View style={styles.copy}>
                <Text style={[styles.rowTitle, { color: colors.ink }]}>{item.folder.name}</Text>
                <Text style={[styles.meta, { color: colors.ink2 }]}>Folder</Text>
              </View>
              <Feather name="chevron-right" size={18} color={colors.ink3} />
            </Pressable>
          ) : (
            <Pressable
              style={[styles.row, { borderBottomColor: colors.line }]}
              onPress={() =>
                navigation.navigate('DocumentViewer', { documentId: item.document.id })
              }
            >
              <View style={[styles.icon, { backgroundColor: colors.bgSunken }]}>
                <Feather name={iconFor(item.document.mediaType)} size={20} color={colors.accent} />
              </View>
              <View style={styles.copy}>
                <Text numberOfLines={1} style={[styles.rowTitle, { color: colors.ink }]}>
                  {item.document.title}
                </Text>
                <Text style={[styles.meta, { color: colors.ink2 }]}>
                  {item.document.mediaType} · {formatBytes(item.document.byteSize)} ·{' '}
                  {item.document.custody ?? 'local'}
                </Text>
              </View>
              {item.document.starred ? <Feather name="star" size={16} color="#d99b18" /> : null}
            </Pressable>
          )
        }
      />
    </SafeAreaView>
  );
}

const iconFor = (mime: string): React.ComponentProps<typeof Feather>['name'] =>
  mime.includes('pdf')
    ? 'file-text'
    : mime.startsWith('image/')
      ? 'image'
      : mime.startsWith('video/')
        ? 'video'
        : mime.startsWith('audio/')
          ? 'headphones'
          : 'file';
const formatBytes = (bytes: number): string =>
  bytes < 1024 ** 2 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const styles = StyleSheet.create({
  copy: { flex: 1, marginLeft: 12 },
  empty: { fontFamily: family.sansRegular, fontSize: 14, padding: 40, textAlign: 'center' },
  folderTitle: { fontFamily: family.sansBold, fontSize: 16 },
  header: { alignItems: 'center', flexDirection: 'row', minHeight: 50, paddingHorizontal: 18 },
  icon: { alignItems: 'center', borderRadius: 10, height: 40, justifyContent: 'center', width: 40 },
  input: { flex: 1, fontFamily: family.sansRegular, fontSize: 14, paddingVertical: 10 },
  list: { paddingHorizontal: 18, paddingBottom: 40 },
  meta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 4 },
  row: { alignItems: 'center', borderBottomWidth: 1, flexDirection: 'row', minHeight: 68 },
  rowTitle: { fontFamily: family.sansMedium, fontSize: 14 },
  safe: { flex: 1 },
  search: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    margin: 12,
    marginHorizontal: 18,
    paddingHorizontal: 12,
  },
  spacer: { flex: 1 },
  title: { color: '#000', flex: 1, fontFamily: family.displayBold, fontSize: 23 },
});
