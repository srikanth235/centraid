import { useMemo } from 'react';
import type { ReplicaRow } from '@centraid/client/replica/native';
import { useReplicaQuery } from '../../kit/hooks/useReplicaQuery';
import { expandEvent } from './recurrence';

const value = <T>(row: ReplicaRow, key: string): T | undefined => row[key] as T | undefined;

export function useAgenda(rangeStart: Date, rangeEnd: Date) {
  const events = useReplicaQuery(
    'agenda',
    useMemo(() => ({ entity: 'core.event' }), []),
  );
  const attendees = useReplicaQuery(
    'agenda',
    useMemo(() => ({ entity: 'schedule.attendee' }), []),
  );
  const parties = useReplicaQuery(
    'agenda',
    useMemo(() => ({ entity: 'core.party' }), []),
  );
  const calendars = useReplicaQuery(
    'agenda',
    useMemo(() => ({ entity: 'schedule.calendar' }), []),
  );
  // The vault's owner party (issue #337) — the one attendee whose RSVP the
  // owner controls. core.vault is granted to the agenda shape, so this rides
  // the same offline replica as everything else.
  const vault = useReplicaQuery(
    'agenda',
    useMemo(() => ({ entity: 'core.vault' }), []),
  );
  const rows = useMemo(
    () =>
      events.rows
        .flatMap((row) => {
          const id = value<string>(row, 'event_id');
          const start = value<string>(row, 'dtstart');
          if (!id || !start || value(row, 'status') === 'cancelled') return [];
          // The vault allows a NULL dtend and treats it as a zero-duration
          // event (upcoming.js); match that instead of dropping the row.
          const end = value<string>(row, 'dtend') ?? start;
          return expandEvent(
            {
              id,
              calendarId: value<string>(row, 'calendar_id'),
              summary: value<string>(row, 'summary') ?? 'Untitled event',
              description: value<string>(row, 'description'),
              start,
              end,
              timezone: value<string>(row, 'start_tz'),
              rrule: value<string>(row, 'rrule'),
              status: value<string>(row, 'status') ?? 'confirmed',
            },
            rangeStart,
            rangeEnd,
          );
        })
        .sort((a, b) => a.start.localeCompare(b.start)),
    [events.rows, rangeEnd, rangeStart],
  );
  return {
    events: rows,
    canonicalEvents: events.rows,
    attendees: attendees.rows,
    parties: parties.rows,
    calendars: calendars.rows,
    ownerPartyId: value<string>(vault.rows[0] ?? {}, 'owner_party_id'),
    loading: events.loading,
    error: events.error,
  };
}
