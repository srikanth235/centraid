// Shared page-side shapes for the agenda app (TS conversion). Type-only — no
// runtime members — so every importer uses `import type`, which esbuild strips
// at serve time (a value import of this module would 404). Grounded in the
// query payloads (upcoming/search/parties) and app.tsx's module-level
// `state`/`data` bags, which are mutated in place (never reassigned) so
// logic.ts's/pending.ts's closures over them stay valid.

/** The three canvas views (also the appDefaultView knob's domain). */
export type ViewKind = 'month' | 'week' | 'schedule';

/** A schedule.calendar row, projected for the sidebar + chip picker. */
export interface Calendar {
  calendar_id: string;
  name?: string;
  color?: string;
}

/** One guest row joined from schedule.attendee → core.party (issue #337). */
export interface Attendee {
  attendee_id?: string;
  party_id: string;
  name: string;
  partstat: string;
  role?: string;
  is_you?: boolean;
}

/** A core.attachment edge joined to its core.content_item bytes. */
export interface AgAttachment {
  attachment_id: string;
  content_id?: string;
  role?: string;
  is_primary?: number | boolean;
  media_type?: string;
  title?: string | null;
  content_uri?: string;
  byte_size?: number;
  [k: string]: unknown;
}

/**
 * A canonical core.event enriched by the upcoming/search projection with its
 * calendar edge, guests and attachments. Recurrence instances share one
 * `event_id` and carry an `instance_key` for stable list keying.
 */
export interface AgEvent {
  event_id: string;
  calendar_id?: string | null;
  summary?: string;
  status?: string;
  dtstart: string;
  dtend?: string | null;
  description?: string;
  rrule?: string | null;
  conferencing_uri?: string | null;
  attachments?: AgAttachment[];
  attendees?: Attendee[];
  snippet?: string;
  instance_key?: string;
  is_recurrence_instance?: boolean;
}

/** One event's segment clamped to a single local day (see format.ts bucketByDay). */
export interface DaySegment {
  ev: AgEvent;
  segStart: number;
  segEnd: number;
  startsHere: boolean;
  endsHere: boolean;
  spansAll: boolean;
}

/** A day segment placed into an overlap column (see format.ts layoutDay). */
export interface LaidSegment extends DaySegment {
  col: number;
  width: number;
}

/** One session-scoped, receipted activity entry the drawer renders. */
export interface ActivityEntry {
  text: string;
  when: string;
  receiptId: string | null;
}

/** A tracked parked/queued write, keyed by intent (see pending.ts). */
export interface PendingRecord {
  eventId: string;
  kind: string;
}

/** The composer's prefilled start/end when opened from a day/slot click. */
export interface Prefill {
  start: Date;
  end: Date;
}

/** The payload the create composer hands back to `proposeEvent`. */
export interface CreatePayload {
  summary: string;
  dtstart: string;
  dtend: string;
  calendar_id: string;
  start_tz?: string;
  description?: string;
  attendee_party_ids?: string[];
  rrule?: string;
  conferencing_uri?: string;
  // Handed to the vault write path (Record<string, unknown>); the index
  // signature lets this interface flow there without a cast.
  [k: string]: unknown;
}

/** A pickable guest from the parties directory. */
export interface PartyOption {
  party_id: string;
  name: string;
  is_you?: boolean;
}

/**
 * The module-level `state` bag app.tsx mutates in place (never reassigned) and
 * logic.ts/pending.ts close over. `data` is the separate last-successful-reads
 * store.
 */
export interface AppState {
  view: ViewKind;
  cursor: Date;
  search: string;
  searchResults: AgEvent[] | null;
  hiddenCals: Set<string>;
  detailEventId: string | null;
  createOpen: boolean;
  createPrefill: Prefill | null;
  narrow: boolean;
  pendingIds: Set<string>;
  pendingCancelIds: Set<string>;
  pendingByIntent: Map<string, PendingRecord>;
  activityLog: Map<string, ActivityEntry[]>;
  readFailedShown: boolean;
}

export interface AppData {
  events: AgEvent[];
  miniEvents: AgEvent[];
  calendars: Calendar[];
  calById: Map<string, Calendar>;
}
