export type ViewKind = "month" | "week" | "day" | "schedule" | "waiting";

export interface Calendar {
  calendar_id: string;
  name?: string;
  color?: string;
}

export interface Attendee {
  attendee_id?: string;
  party_id: string;
  name: string;
  partstat: string;
  role?: string;
  is_you?: boolean;
}

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
  recurrence_semantics?: "zoned" | "floating" | "all-day";
  calendar_id?: string;
  reminders?: { minutes_before: number }[];
  conferencing_uri?: string;
  attendee_party_ids?: string[];
  [key: string]: unknown;
}

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
  [k: string]: unknown;
}

export interface PartyOption {
  party_id: string;
  name: string;
  is_you?: boolean;
}

export interface DaySegment {
  ev: AgEvent;
  segStart: number;
  segEnd: number;
  startsHere: boolean;
  endsHere: boolean;
  spansAll: boolean;
  clamped: boolean;
}

export interface LaidSegment extends DaySegment {
  col: number;
  width: number;
}

export interface QuickDraft {
  start: Date;
  end: Date;
  title: string;
}

export interface AppState {
  view: ViewKind;
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
