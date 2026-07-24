import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';

import { family, useTheme } from '../../kit/theme';
import { useReplica } from '../../kit/replica/ReplicaProvider';
import type { AgendaScreenProps } from '../../navigation';
import { useAgenda } from './useAgenda';

// Rows from useReplicaQuery carry a synthetic `__rowId` key that is not a real
// shaped column; spreading it into an optimistic mutation's values made the
// mutation fail validation and silently not render. Strip it first.
function withoutRowId<T extends { __rowId?: unknown }>(row: T): Omit<T, '__rowId'> {
  const { __rowId, ...rest } = row;
  return rest;
}

export default function AgendaEvent({
  route,
  navigation,
}: AgendaScreenProps<'AgendaEvent'>): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const { eventId, instanceKey } = route.params;
  const range = useMemo(() => [new Date('1970-01-01'), new Date('2100-01-01')] as const, []);
  const agenda = useAgenda(range[0], range[1]);
  const canonical = agenda.canonicalEvents.find((row) => row.event_id === eventId);
  // Render the tapped occurrence when an instanceKey was threaded through, so a
  // recurring instance shows its own date/time (and reminders below fire for
  // that occurrence). Writes still target the canonical series via `eventId`.
  const event =
    (instanceKey ? agenda.events.find((row) => row.instanceKey === instanceKey) : undefined) ??
    agenda.events.find((row) => row.id === eventId);
  const [pending, setPending] = useState<string>();
  const partyNames = new Map(
    agenda.parties.map((row) => [
      String(row.party_id),
      String(row.display_name ?? row.name ?? 'Guest'),
    ]),
  );
  const attendees = agenda.attendees.filter((row) => row.event_id === eventId);
  // RSVP acts as the vault owner's own attendee row, not attendees[0]. If the
  // owner isn't on the guest list there is no honest party to RSVP as.
  const me = agenda.ownerPartyId;
  const myAttendee = attendees.find((row) => me != null && String(row.party_id) === String(me));

  const applyOutcome = (result: { status: string; reason?: string }, verb: string): void => {
    if (result.status === 'parked' || result.status === 'queued') {
      setPending(`${verb} awaiting approval`);
    } else if (result.status === 'denied' || result.status === 'failed') {
      Alert.alert(`${verb} not applied`, result.reason ?? 'The vault rejected this change.');
    }
  };
  const reportFailure = (verb: string, error: unknown): void => {
    Alert.alert(`${verb} failed`, error instanceof Error ? error.message : 'Please try again.');
  };

  const reschedule = async (): Promise<void> => {
    if (!event || !session) return;
    const start = new Date(Date.parse(event.start) + 60 * 60 * 1000).toISOString();
    const end = new Date(Date.parse(event.end) + 60 * 60 * 1000).toISOString();
    try {
      const result = await session.write('agenda', {
        action: 'reschedule',
        input: { event_id: event.id, dtstart: start, dtend: end },
        optimistic: [
          {
            op: 'upsert',
            entity: 'core.event',
            rowId: event.id,
            values: { ...(canonical ? withoutRowId(canonical) : {}), dtstart: start, dtend: end },
          },
        ],
      });
      applyOutcome(result, 'Reschedule');
    } catch (error) {
      reportFailure('Reschedule', error);
    }
  };
  const cancel = async (): Promise<void> => {
    if (!event || !session) return;
    try {
      const result = await session.write('agenda', {
        action: 'cancel-event',
        input: { event_id: event.id },
        optimistic: [
          {
            op: 'upsert',
            entity: 'core.event',
            rowId: event.id,
            values: { ...(canonical ? withoutRowId(canonical) : {}), status: 'cancelled' },
          },
        ],
      });
      applyOutcome(result, 'Cancellation');
    } catch (error) {
      reportFailure('Cancellation', error);
    }
  };
  const rsvp = async (partstat: string): Promise<void> => {
    if (!myAttendee || !session || !event) return;
    const partyId = String(myAttendee.party_id ?? '');
    if (!partyId) return;
    try {
      const result = await session.write('agenda', {
        action: 'rsvp',
        input: { event_id: event.id, party_id: partyId, partstat },
        optimistic: [
          {
            op: 'upsert',
            entity: 'schedule.attendee',
            rowId: String(myAttendee.attendee_id),
            values: { ...withoutRowId(myAttendee), partstat },
          },
        ],
      });
      applyOutcome(result, 'RSVP');
    } catch (error) {
      reportFailure('RSVP', error);
    }
  };
  const remind = async (): Promise<void> => {
    if (!event) return;
    const permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        'Notifications disabled',
        'Enable notifications to receive local event reminders.',
      );
      return;
    }
    const date = new Date(Date.parse(event.start) - 15 * 60 * 1000);
    if (date <= new Date()) {
      Alert.alert('Too late to schedule', 'This reminder time has already passed.');
      return;
    }
    await Notifications.scheduleNotificationAsync({
      content: { title: event.summary, body: 'Starts in 15 minutes', data: { eventId: event.id } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date },
    });
    Alert.alert('Reminder set', 'This device will notify you 15 minutes before the event.');
  };
  if (!event) return <View style={[styles.safe, { backgroundColor: colors.bg }]} />;
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Feather name="chevron-left" size={26} color={colors.ink} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.ink }]}>Event</Text>
        <Pressable onPress={() => void remind()}>
          <Feather name="bell" size={21} color={colors.accent} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.date, { color: colors.accent }]}>
          {new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
            .format(new Date(event.start))
            .toUpperCase()}
        </Text>
        <Text style={[styles.title, { color: colors.ink }]}>{event.summary}</Text>
        <Text style={[styles.when, { color: colors.ink2 }]}>
          {new Intl.DateTimeFormat(undefined, {
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          }).format(new Date(event.start))}{' '}
          –{' '}
          {new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
            new Date(event.end),
          )}
        </Text>
        {event.description ? (
          <Text style={[styles.description, { color: colors.ink }]}>{event.description}</Text>
        ) : null}
        {pending ? (
          <Pressable
            style={[styles.pending, { backgroundColor: colors.bgSunken }]}
            onPress={() => navigation.navigate('Settings', { screen: 'Approvals' })}
          >
            <Feather name="clock" size={17} color={colors.accent} />
            <Text style={[styles.pendingText, { color: colors.ink }]}>{pending}</Text>
            <Feather name="chevron-right" size={17} color={colors.ink3} />
          </Pressable>
        ) : null}
        <Text style={[styles.section, { color: colors.ink2 }]}>GUESTS</Text>
        {attendees.length ? (
          attendees.map((attendee) => (
            <View
              key={String(attendee.attendee_id)}
              style={[styles.guest, { borderBottomColor: colors.line }]}
            >
              <View style={[styles.avatar, { backgroundColor: colors.bgSunken }]}>
                <Text style={[styles.avatarText, { color: colors.accent }]}>
                  {partyNames.get(String(attendee.party_id))?.slice(0, 1)}
                </Text>
              </View>
              <Text style={[styles.guestName, { color: colors.ink }]}>
                {partyNames.get(String(attendee.party_id))}
              </Text>
              <Text style={[styles.guestState, { color: colors.ink2 }]}>
                {String(attendee.partstat)}
              </Text>
            </View>
          ))
        ) : (
          <Text style={[styles.empty, { color: colors.ink2 }]}>No attendees.</Text>
        )}
        {myAttendee ? (
          <View style={styles.rsvp}>
            {[
              ['Going', 'accepted'],
              ['Maybe', 'tentative'],
              ['Decline', 'declined'],
            ].map(([label, state]) => (
              <Pressable
                key={state}
                style={[styles.rsvpButton, { borderColor: colors.lineStrong }]}
                onPress={() => void rsvp(state!)}
              >
                <Text style={[styles.rsvpText, { color: colors.ink }]}>{label}</Text>
              </Pressable>
            ))}
          </View>
        ) : attendees.length ? (
          <Text style={[styles.empty, { color: colors.ink2 }]}>
            You are not on this guest list, so there is no RSVP to give.
          </Text>
        ) : null}
        <Text style={[styles.section, { color: colors.ink2 }]}>ACTIONS</Text>
        <Pressable
          style={[styles.action, { borderBottomColor: colors.line }]}
          onPress={() => void reschedule()}
        >
          <Feather name="clock" size={18} color={colors.accent} />
          <Text style={[styles.actionText, { color: colors.ink }]}>Move one hour later</Text>
          <Text style={[styles.risk, { color: colors.ink2 }]}>approval</Text>
        </Pressable>
        <Pressable
          style={[styles.action, { borderBottomColor: colors.line }]}
          onPress={() =>
            Alert.alert(
              'Ask to cancel?',
              'The event stays visible until the owner approves this medium-risk write.',
              [
                { text: 'Keep' },
                { text: 'Ask to cancel', style: 'destructive', onPress: () => void cancel() },
              ],
            )
          }
        >
          <Feather name="x-circle" size={18} color={colors.danger} />
          <Text style={[styles.actionText, { color: colors.danger }]}>Ask to cancel</Text>
          <Text style={[styles.risk, { color: colors.ink2 }]}>approval</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 54,
  },
  actionText: { flex: 1, fontFamily: family.sansMedium, fontSize: 14 },
  avatar: {
    alignItems: 'center',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  avatarText: { fontFamily: family.sansBold, fontSize: 14 },
  content: { padding: 22, paddingBottom: 60 },
  date: { fontFamily: family.monoBold, fontSize: 10, letterSpacing: 1 },
  description: { fontFamily: family.sansRegular, fontSize: 14, lineHeight: 21, marginTop: 22 },
  empty: { fontFamily: family.sansRegular, fontSize: 13 },
  guest: { alignItems: 'center', borderBottomWidth: 1, flexDirection: 'row', minHeight: 56 },
  guestName: { flex: 1, fontFamily: family.sansMedium, fontSize: 14, marginLeft: 10 },
  guestState: { fontFamily: family.sansRegular, fontSize: 12 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 50,
    paddingHorizontal: 14,
  },
  headerTitle: { fontFamily: family.sansBold, fontSize: 15 },
  pending: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 10,
    marginTop: 22,
    padding: 14,
  },
  pendingText: { flex: 1, fontFamily: family.sansMedium, fontSize: 13 },
  risk: { fontFamily: family.monoRegular, fontSize: 10 },
  rsvp: { flexDirection: 'row', gap: 8, marginTop: 14 },
  rsvpButton: { alignItems: 'center', borderRadius: 10, borderWidth: 1, flex: 1, padding: 10 },
  rsvpText: { fontFamily: family.sansMedium, fontSize: 12 },
  safe: { flex: 1 },
  section: {
    fontFamily: family.monoBold,
    fontSize: 10,
    letterSpacing: 1,
    marginBottom: 6,
    marginTop: 30,
  },
  title: { fontFamily: family.displayBold, fontSize: 28, letterSpacing: -0.7, marginTop: 10 },
  when: { fontFamily: family.sansRegular, fontSize: 14, marginTop: 10 },
});
