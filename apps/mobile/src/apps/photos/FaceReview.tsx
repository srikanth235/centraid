import React, { useMemo } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { useReplicaQuery } from '../../kit/hooks/useReplicaQuery';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import { family, useTheme } from '../../kit/theme';
import type { PhotosScreenProps } from '../../navigation';

export default function FaceReview({
  navigation,
}: PhotosScreenProps<'FaceReview'>): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const faces = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'media.face_region' }), []),
  );
  const parties = useReplicaQuery(
    'photos',
    useMemo(() => ({ entity: 'core.party' }), []),
  );
  const names = new Map(
    parties.rows.map((row) => [String(row.party_id), String(row.display_name ?? 'Unknown person')]),
  );
  const proposals = faces.rows.filter((row) => !row.confirmed_by_party_id);
  const confirmedPeople = parties.rows
    .map((party) => ({
      party,
      count: faces.rows.filter(
        (face) => face.confirmed_by_party_id && String(face.party_id) === String(party.party_id),
      ).length,
    }))
    .filter(({ count }) => count > 0);
  const act = async (
    action: 'confirm-face' | 'reject-face',
    regionId: string,
    partyId?: string,
  ): Promise<void> => {
    await session?.write('photos', {
      action,
      input: { region_id: regionId, ...(partyId ? { party_id: partyId } : {}) },
    });
  };
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Feather name="chevron-left" size={26} color={colors.ink} />
        </Pressable>
        <Text style={[styles.title, { color: colors.ink }]}>People review</Text>
        <Text style={[styles.count, { color: colors.ink2 }]}>{proposals.length}</Text>
      </View>
      <FlatList
        data={proposals}
        keyExtractor={(row) => row.__rowId}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View>
            <Text style={[styles.section, { color: colors.ink2 }]}>CONFIRMED PEOPLE</Text>
            {confirmedPeople.length ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.people}
              >
                {confirmedPeople.map(({ party, count }) => (
                  <View
                    key={String(party.party_id)}
                    style={[styles.personCard, { backgroundColor: colors.bgSunken }]}
                  >
                    <View style={[styles.personAvatar, { backgroundColor: colors.bgElev }]}>
                      <Feather name="user" size={22} color={colors.accent} />
                    </View>
                    <Text numberOfLines={1} style={[styles.personName, { color: colors.ink }]}>
                      {String(party.display_name ?? party.name ?? 'Unknown person')}
                    </Text>
                    <Text style={[styles.meta, { color: colors.ink2 }]}>{count} photos</Text>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <Text style={[styles.emptyPeople, { color: colors.ink2 }]}>
                Confirmed people will appear here.
              </Text>
            )}
            <Text style={[styles.section, { color: colors.ink2 }]}>FACE PROPOSALS</Text>
          </View>
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.ink2 }]}>No face proposals need review.</Text>
        }
        renderItem={({ item }) => {
          const partyId = item.party_id ? String(item.party_id) : undefined;
          return (
            <View style={[styles.row, { borderBottomColor: colors.line }]}>
              <View style={[styles.avatar, { backgroundColor: colors.bgSunken }]}>
                <Feather name="user" size={20} color={colors.accent} />
              </View>
              <View style={styles.copy}>
                <Text style={[styles.name, { color: colors.ink }]}>
                  {partyId ? names.get(partyId) : 'Unmatched face'}
                </Text>
                <Text style={[styles.meta, { color: colors.ink2 }]}>
                  {Math.round(Number(item.confidence ?? 0) * 100)}% confidence
                </Text>
              </View>
              {partyId ? (
                <Pressable
                  onPress={() => void act('confirm-face', String(item.region_id), partyId)}
                >
                  <Feather name="check" size={21} color="#2f9d6a" />
                </Pressable>
              ) : null}
              <Pressable onPress={() => void act('reject-face', String(item.region_id))}>
                <Feather name="x" size={21} color={colors.danger} />
              </Pressable>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    borderRadius: 21,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  copy: { flex: 1, marginLeft: 12 },
  count: { fontFamily: family.monoMedium, fontSize: 11 },
  empty: { fontFamily: family.sansRegular, fontSize: 14, padding: 40, textAlign: 'center' },
  emptyPeople: { fontFamily: family.sansRegular, fontSize: 13, paddingVertical: 14 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 50,
    paddingHorizontal: 14,
  },
  list: { paddingHorizontal: 18 },
  meta: { fontFamily: family.sansRegular, fontSize: 11, marginTop: 4 },
  name: { fontFamily: family.sansMedium, fontSize: 14 },
  people: { gap: 10, paddingVertical: 8 },
  personAvatar: {
    alignItems: 'center',
    borderRadius: 24,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  personCard: { borderRadius: 14, padding: 12, width: 128 },
  personName: { fontFamily: family.sansMedium, fontSize: 12, marginTop: 8 },
  row: { alignItems: 'center', borderBottomWidth: 1, flexDirection: 'row', gap: 14, minHeight: 70 },
  safe: { flex: 1 },
  section: { fontFamily: family.monoBold, fontSize: 10, letterSpacing: 1, marginTop: 18 },
  title: { fontFamily: family.displayBold, fontSize: 18 },
});
