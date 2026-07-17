import React, { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as Haptics from 'expo-haptics';

import { OnlineOnlyError } from '@centraid/client/replica/native';

import { backupDocument } from '../../lib/upload/media-producer';
import { useTheme } from '../../kit/theme';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import type { DocsScreenProps } from '../../navigation';
import type { NativeDocument, NativeFolder } from './docs-model';
import { styles } from './DocsHome.styles';
import { useDocsLibrary } from './useDocsLibrary';

type LibraryFilter = 'all' | 'recent' | 'starred' | 'trash';
type ViewMode = 'list' | 'grid';
type DriveItem =
  | { kind: 'folder'; folder: NativeFolder }
  | { kind: 'document'; document: NativeDocument; location?: string };

const FILTERS: readonly {
  key: LibraryFilter;
  label: string;
  icon: React.ComponentProps<typeof Feather>['name'];
}[] = [
  { key: 'all', label: 'All', icon: 'file-text' },
  { key: 'recent', label: 'Recent', icon: 'clock' },
  { key: 'starred', label: 'Starred', icon: 'star' },
  { key: 'trash', label: 'Trash', icon: 'trash-2' },
];

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
  const [searchError, setSearchError] = useState<string>();
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [view, setView] = useState<ViewMode>('list');
  const [addOpen, setAddOpen] = useState(false);
  const [folderName, setFolderName] = useState('');

  useEffect(() => {
    let active = true;
    if (!query.trim() || !session) {
      setMatches(undefined);
      setSearchError(undefined);
      return;
    }
    const timeout = setTimeout(
      () =>
        void session
          .search('docs', { entity: 'core.document', query: query.trim(), limit: 100 })
          .then((result) => {
            if (!active) return;
            setSearchError(undefined);
            setMatches(new Set(result.rows.map((row) => String(row.values.document_id))));
          })
          .catch((error: unknown) => {
            if (!active) return;
            // An OnlineOnlyError is an expected degradation (e.g. an indexed
            // title too large to rank offline): fall back to the unfiltered
            // library rather than a scary error or a blank "no matches". A
            // real transport/protocol failure is surfaced instead of swallowed.
            if (error instanceof OnlineOnlyError) {
              setMatches(undefined);
              setSearchError(undefined);
            } else {
              setMatches(undefined);
              setSearchError('Search is unavailable right now.');
            }
          }),
      160,
    );
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [query, session]);

  // A folder path resolver for search hits: a root-level search surfaces
  // documents living in subfolders (issue: search was ANDed with the current
  // folder), so each match shows where it lives.
  const folderById = useMemo(
    () => new Map(drive.folders.map((folder) => [folder.id, folder])),
    [drive.folders],
  );
  const folderPathOf = (document: NativeDocument): string => {
    if (!document.folderId) return 'Docs';
    const names: string[] = [];
    const seen = new Set<string>();
    let current: NativeFolder | undefined = folderById.get(document.folderId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = current.parentId ? folderById.get(current.parentId) : undefined;
    }
    return names.length ? names.join(' / ') : 'Docs';
  };

  // When a search is active the folder scope is dropped so a hit in any
  // subfolder surfaces; otherwise documents are scoped to the open folder.
  const searching = matches !== undefined;
  const documents = useMemo(() => {
    const inScope = drive.documents.filter((document) =>
      searching
        ? matches.has(document.id)
        : !folderId
          ? !document.folderId
          : document.folderId === folderId,
    );
    const visible = inScope.filter((document) => {
      if (filter === 'trash') return document.trashed;
      if (document.trashed) return false;
      return filter !== 'starred' || document.starred;
    });
    const sorted = [...visible].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return filter === 'recent' ? sorted.slice(0, 8) : sorted;
  }, [drive.documents, filter, folderId, matches, searching]);
  const folders = drive.folders.filter(
    (folder) =>
      filter === 'all' &&
      !searching &&
      (!folderId ? !folder.parentId : folder.parentId === folderId),
  );
  const items: DriveItem[] = [
    ...folders.map((folder) => ({ kind: 'folder' as const, folder })),
    ...documents.map((document) => ({
      kind: 'document' as const,
      document,
      ...(searching ? { location: folderPathOf(document) } : {}),
    })),
  ];
  const parent = folderId ? drive.folders.find((folder) => folder.id === folderId) : undefined;

  const pick = async (): Promise<void> => {
    setAddOpen(false);
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
  const createFolder = async (): Promise<void> => {
    if (!session || !folderName.trim()) return;
    try {
      const result = await session.write('docs', {
        action: 'create-folder',
        input: { name: folderName.trim() },
      });
      setFolderName('');
      setAddOpen(false);
      if (result.status === 'parked' || result.status === 'queued') {
        navigation.navigate('Tabs', {
          screen: 'SettingsTab',
          params: { screen: 'Approvals' },
        });
      } else if (result.status === 'denied' || result.status === 'failed') {
        Alert.alert('Folder not created', result.reason ?? 'The vault rejected this change.');
      } else {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (error) {
      setAddOpen(false);
      Alert.alert(
        'Folder not created',
        error instanceof Error ? error.message : 'Please try again.',
      );
    }
  };
  const selectFilter = (next: LibraryFilter): void => {
    void Haptics.selectionAsync();
    setFilter(next);
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top']}>
      <View style={styles.header}>
        {folderId ? (
          <Pressable onPress={() => navigation.goBack()}>
            <Feather name="chevron-left" size={26} color={colors.ink} />
          </Pressable>
        ) : null}
        <View style={styles.headerCopy}>
          <Text style={[styles.title, { color: colors.ink }]}>{parent?.name ?? 'Docs'}</Text>
          <Text style={[styles.subtitle, { color: colors.ink2 }]}>Private document library</Text>
        </View>
        <Pressable accessibilityLabel="Add document or folder" onPress={() => setAddOpen(true)}>
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
        {query ? (
          <Pressable accessibilityLabel="Clear search" onPress={() => setQuery('')}>
            <Feather name="x" size={17} color={colors.ink2} />
          </Pressable>
        ) : null}
      </View>

      {!folderId ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterScroll}
          contentContainerStyle={styles.filters}
        >
          {FILTERS.map((item) => {
            const active = filter === item.key;
            const count =
              item.key === 'starred'
                ? drive.documents.filter((document) => document.starred && !document.trashed).length
                : item.key === 'trash'
                  ? drive.documents.filter((document) => document.trashed).length
                  : undefined;
            return (
              <Pressable
                key={item.key}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => selectFilter(item.key)}
                style={[styles.filter, { backgroundColor: active ? colors.ink : colors.bgSunken }]}
              >
                <Feather name={item.icon} size={14} color={active ? colors.bg : colors.ink2} />
                <Text style={[styles.filterText, { color: active ? colors.bg : colors.ink2 }]}>
                  {item.label}
                  {count ? ` ${count}` : ''}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <View style={styles.libraryHeader}>
        <View>
          <Text style={[styles.libraryTitle, { color: colors.ink }]}>
            {filter === 'all'
              ? folderId
                ? (parent?.name ?? 'Folder')
                : 'All documents'
              : FILTERS.find((item) => item.key === filter)?.label}
          </Text>
          <Text style={[styles.libraryMeta, { color: colors.ink2 }]}>
            {documents.length} documents{folders.length ? ` · ${folders.length} folders` : ''}
          </Text>
        </View>
        <View style={[styles.viewSwitch, { backgroundColor: colors.bgSunken }]}>
          {(['list', 'grid'] as ViewMode[]).map((mode) => (
            <Pressable
              key={mode}
              accessibilityLabel={`${mode} view`}
              onPress={() => setView(mode)}
              style={[styles.viewButton, view === mode && { backgroundColor: colors.bgElev }]}
            >
              <Feather
                name={mode === 'list' ? 'list' : 'grid'}
                size={16}
                color={view === mode ? colors.ink : colors.ink3}
              />
            </Pressable>
          ))}
        </View>
      </View>

      <FlatList
        key={view}
        data={items}
        numColumns={view === 'grid' ? 2 : 1}
        columnWrapperStyle={view === 'grid' ? styles.gridRow : undefined}
        keyExtractor={(item) =>
          item.kind === 'folder' ? `f:${item.folder.id}` : `d:${item.document.id}`
        }
        contentContainerStyle={[styles.list, view === 'grid' && styles.gridList]}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Feather
              name={filter === 'trash' ? 'trash-2' : 'file-text'}
              size={32}
              color={colors.accent}
            />
            <Text style={[styles.emptyTitle, { color: colors.ink }]}>
              {drive.loading
                ? 'Opening your drive…'
                : searchError
                  ? searchError
                  : query
                    ? 'No matching documents'
                    : 'Nothing here yet'}
            </Text>
            <Text style={[styles.empty, { color: colors.ink2 }]}>
              {searchError
                ? 'Reconnect and try your search again.'
                : filter === 'trash'
                  ? 'Deleted documents will remain recoverable here.'
                  : 'Import a file or create a folder to get started.'}
            </Text>
          </View>
        }
        renderItem={({ item }) =>
          view === 'grid' ? (
            <GridItem item={item} navigation={navigation} colors={colors} />
          ) : (
            <ListItem item={item} navigation={navigation} colors={colors} />
          )
        }
      />

      <Modal
        transparent
        animationType="fade"
        visible={addOpen}
        onRequestClose={() => setAddOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setAddOpen(false)} />
        <View style={[styles.dialog, { backgroundColor: colors.bgElev }]}>
          <Text style={[styles.dialogTitle, { color: colors.ink }]}>Add to Docs</Text>
          <Pressable
            style={[styles.addRow, { borderBottomColor: colors.line }]}
            onPress={() => void pick()}
          >
            <View style={[styles.addIcon, { backgroundColor: colors.bgSunken }]}>
              <Feather name="upload-cloud" size={20} color={colors.accent} />
            </View>
            <View style={styles.addCopy}>
              <Text style={[styles.rowTitle, { color: colors.ink }]}>Import documents</Text>
              <Text style={[styles.meta, { color: colors.ink2 }]}>
                Choose files from this device
              </Text>
            </View>
          </Pressable>
          {!folderId ? (
            <>
              <Text style={[styles.newFolderLabel, { color: colors.ink2 }]}>NEW FOLDER</Text>
              <TextInput
                value={folderName}
                onChangeText={setFolderName}
                placeholder="Folder name"
                placeholderTextColor={colors.ink3}
                style={[styles.folderInput, { borderColor: colors.lineStrong, color: colors.ink }]}
              />
              <Pressable
                disabled={!folderName.trim()}
                style={[
                  styles.create,
                  { backgroundColor: folderName.trim() ? colors.accent : colors.bgSunken },
                ]}
                onPress={() => void createFolder()}
              >
                <Text
                  style={[styles.createText, { color: folderName.trim() ? '#fff' : colors.ink3 }]}
                >
                  Create folder
                </Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function ListItem({ item, navigation, colors }: ItemProps): React.JSX.Element {
  if (item.kind === 'folder') {
    return (
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
    );
  }
  return (
    <Pressable
      style={[styles.row, { borderBottomColor: colors.line }]}
      onPress={() => navigation.navigate('DocumentViewer', { documentId: item.document.id })}
    >
      <View style={[styles.icon, { backgroundColor: colors.bgSunken }]}>
        <Feather name={iconFor(item.document.mediaType)} size={20} color={colors.accent} />
      </View>
      <View style={styles.copy}>
        <Text numberOfLines={1} style={[styles.rowTitle, { color: colors.ink }]}>
          {item.document.title}
        </Text>
        <Text style={[styles.meta, { color: colors.ink2 }]}>
          {item.location ? `${item.location} · ` : ''}
          {formatType(item.document.mediaType)} · {formatBytes(item.document.byteSize)} ·{' '}
          {item.document.custody ?? 'local'}
        </Text>
      </View>
      {item.document.starred ? <Feather name="star" size={16} color="#d99b18" /> : null}
    </Pressable>
  );
}

function GridItem({ item, navigation, colors }: ItemProps): React.JSX.Element {
  const document = item.kind === 'document' ? item.document : undefined;
  return (
    <Pressable
      style={[styles.gridCard, { backgroundColor: colors.bgElev, borderColor: colors.line }]}
      onPress={() =>
        item.kind === 'folder'
          ? navigation.push('DocsHome', { folderId: item.folder.id })
          : navigation.navigate('DocumentViewer', { documentId: item.document.id })
      }
    >
      <View style={[styles.gridPreview, { backgroundColor: colors.bgSunken }]}>
        <Feather
          name={item.kind === 'folder' ? 'folder' : iconFor(item.document.mediaType)}
          size={30}
          color={colors.accent}
        />
      </View>
      <Text numberOfLines={2} style={[styles.gridTitle, { color: colors.ink }]}>
        {item.kind === 'folder' ? item.folder.name : item.document.title}
      </Text>
      <Text style={[styles.meta, { color: colors.ink2 }]}>
        {document
          ? `${item.kind === 'document' && item.location ? `${item.location} · ` : ''}${formatType(document.mediaType)} · ${formatBytes(document.byteSize)}`
          : 'Folder'}
      </Text>
    </Pressable>
  );
}

type ItemProps = {
  item: DriveItem;
  navigation: DocsScreenProps<'DocsHome'>['navigation'];
  colors: ReturnType<typeof useTheme>['colors'];
};
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
const formatType = (mime: string): string => mime.split('/')[1]?.toUpperCase() || 'FILE';
const formatBytes = (bytes: number): string =>
  bytes < 1024 ** 2 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
