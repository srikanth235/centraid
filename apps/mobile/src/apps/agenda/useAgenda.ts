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
  const rows = useMemo(
    () =>
      events.rows
        .flatMap((row) => {
          const id = value<string>(row, 'event_id');
          const start = value<string>(row, 'dtstart');
          const end = value<string>(row, 'dtend');
          if (!id || !start || !end || value(row, 'status') === 'cancelled') return [];
          return expandEvent(
            {
              id,
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
    loading: events.loading,
    error: events.error,
  };
}
