// Page-side shapes for Agenda. Type-only — no runtime members — so every
// importer uses `import type`. Grounded in the `upcoming` / `search` /
// `parties` payloads and in the mutable `state`/`data` bags `app-root.tsx`
// holds in refs (mutated in place, never reassigned, so the closures logic.ts
// took over them at boot stay valid).

/**
 * The five views, and the view is STATE, not a route (spec §"Views and
 * routes"): one route `agenda` carries all of them.
 *
 * `waiting` is the invitations-and-unanswered-RSVPs list. On a pointer surface
 * it falls back to Schedule; on touch it is one of the band's destinations.
 */
export type ViewKind = "month" | "week" | "day" | "schedule" | "waiting";

/** A schedule.calendar row, projected for the rail and the editor's picker. */
export interface Calendar {
  calendar_id: string;
  name?: string;
  color?: string;
}

/** One guest row joined from schedule.attendee → core.party. */
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
  media_type?: string;
  title?: string | null;
  content_uri?: string;
  byte_size?: number;
  [k: string]: unknown;
}

/**
 * A canonical core.event enriched by the upcoming/search projection with its
 * calendar edge, guests, attachments and the recurrence-instance markers.
 * Recurrence instances share one `event_id` and carry an `instance_key`.
 *
 * `recurrence_summary` is the ONE member-facing sentence (`ctx.time`'s shared
 * summariser, resolved in the query). `rrule` rides along because the editor
 * has to send one back — it is never rendered.
 */
export interface AgEvent {
  event_id: string;
  calendar_id?: string | null;
  summary?: string;
  status?: string;
  dtstart: string;
  dtend?: string | null;
  start_tz?: string | null;
  end_tz?: string | null;
  recurrence_semantics?: "zoned" | "floating" | "all-day";
  description?: string;
  rrule?: string | null;
  recurrence_summary?: string | null;
  conferencing_uri?: string | null;
  location_place_id?: string | null;
  reminders_json?: string | null;
  attachments?: AgAttachment[];
  attendees?: Attendee[];
  snippet?: string;
  instance_key?: string;
  is_recurrence_instance?: boolean;
  original_start?: string;
  recurrence_overlap?: boolean;
}

export interface EventEditPayload {
  event_id: string;
  summary?: string;
  description?: string;
  clear_description?: true;
  dtstart?: string;
  dtend?: string;
  start_tz?: string;
  recurrence_semantics?: "zoned" | "floating" | "all-day";
  rrule?: string;
  clear_rrule?: true;
  calendar_id?: string;
  conferencing_uri?: string;
  clear_conferencing?: true;
  reminders?: { minutes_before: number }[];
  attendee_party_ids?: string[];
  [key: string]: unknown;
}

export interface OccurrenceEditPayload {
  event_id: string;
  original_start: string;
  scope: "occurrence" | "future" | "series";
  action: "skip" | "override";
  dtstart?: string;
  dtend?: string;
  summary?: string;
  description?: string;
  [key: string]: unknown;
}

/** The payload the composer hands back to `proposeEvent`. */
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
  reminders?: { minutes_before: number }[];
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

/** One event's span clamped to a single local day. */
export interface DaySegment {
  ev: AgEvent;
  segStart: number;
  segEnd: number;
  startsHere: boolean;
  endsHere: boolean;
  /** Covers the whole of this day — drawn in the all-day rail, not the grid. */
  spansAll: boolean;
  /**
   * The event runs past this day's bounds. V1 draws it as a SINGLE-DAY row
   * anyway (spec §"What is left"), so the flag exists to say so in words
   * rather than to grow a spanning bar.
   */
  clamped: boolean;
}

/** A day segment placed into an overlap column. */
export interface LaidSegment extends DaySegment {
  col: number;
  width: number;
}

/** The quick-add draft: a slot, a title, nothing else until Edit opens. */
export interface QuickDraft {
  start: Date;
  end: Date;
  title: string;
}

/** The mutable state bag `app-root.tsx` holds in a ref. */
export interface AppState {
  view: ViewKind;
  /** The day the views are drawn around. */
  anchorDay: Date;
  search: string;
  searchResults: AgEvent[] | null;
  hiddenCals: Set<string>;
  selectedId: string | null;
  quick: QuickDraft | null;
  editorId: string | null;
  createOpen: boolean;
  narrow: boolean;
}

export interface AppData {
  events: AgEvent[];
  miniEvents: AgEvent[];
  calendars: Calendar[];
  calById: Map<string, Calendar>;
  parties: PartyOption[];
  me: string | null;
}
