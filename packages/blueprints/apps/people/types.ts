import type { SearchStatus } from "../_shared/search-scaffold.ts";
import type { ShelfId } from "./shelves.ts";

export type { SearchStatus } from "../_shared/search-scaffold.ts";

export interface ReminderRef {
  date_id: string;
  label: string;
  month_day: string;
}

export interface PersonRow {
  party_id: string;
  name: string;
  role: string;
  avatar_color: string | null;
  cadence_days: number;
  last_contacted_at: string | null;
  created_at: string;
  list_id: string | null;
  starred: boolean;
  reminders: ReminderRef[];
  linked?: boolean | null;
  vault_count?: number;
  snippet?: string;
}

export interface VaultBinding {
  binding_id: string;
  vault_id: string;
  linked_at: string;
}

export type ShareCapability = "read" | "read+write";

export interface PendingInvite {
  invitation_id: string;
  container_label: string | null;
  capability: ShareCapability;
  created_at: string;
}

export interface ContactChannel {
  channel_id?: string;
  kind: "phone" | "email" | "address" | "handle";
  label?: string | null;
  value: string;
  normalized_value?: string;
  preferred?: boolean;
  provenance?: Record<string, unknown> | null;
  duplicate_party_ids?: string[];
  duplicate_names?: string[];
}

export interface ImportantDate {
  date_id: string;
  label: string;
  month_day: string;
  reminder_on: boolean;
}

export interface PersonNote {
  annotation_id: string;
  text: string;
  created_at: string;
}

export interface Interaction {
  interaction_id: string;
  kind: string;
  text: string;
  occurred_at: string;
}

export interface PersonDetail {
  party_id: string;
  name: string;
  role: string;
  avatar_color: string | null;
  cadence_days: number;
  last_contacted_at: string | null;
  created_at: string;
  met: string;
  starred: boolean;
  contact: ContactChannel[];
  dates: ImportantDate[];
  notes: PersonNote[];
  interactions: Interaction[];
  vaults: VaultBinding[] | null;
  pending_invites: PendingInvite[] | null;
}

export interface PersonCard {
  party_id: string;
  name: string;
  avatar_color: string | null;
  role: string;
  cadence_days?: number | null;
  last_contacted_at?: string | null;
  created_at?: string | null;
}

export interface UpcomingCard extends PersonCard {
  date_id: string;
  label: string;
  month_day: string;
}

export interface RecentCard extends PersonCard {
  interaction_id: string;
  kind: string;
  text: string;
  occurred_at: string;
}

export interface TouchCounts {
  all: number;
  reconnect: number;
  upcoming: number;
  starred: number;
  linked: number | null;
  to_link: number | null;
}

export interface DashboardData {
  reconnect: PersonCard[];
  upcoming: UpcomingCard[];
  recent: RecentCard[];
  counts: TouchCounts;
}

export interface TrashedPerson {
  party_id: string;
  name: string;
  role: string;
  purge_at: string | null;
}

export type RosterFilter = "all" | "linked" | "unlinked" | "starred" | "due";

export type TouchTile =
  | "all"
  | "reconnect"
  | "upcoming"
  | "starred"
  | "linked"
  | "to_link";

export type ComposerKey = "channels" | "dates" | "notes";

export interface ComposerState {
  key: ComposerKey;
  value: string;
  label: string;
  kind: ContactChannel["kind"];
  monthDay: string;
}

export interface PersonDraft {
  party_id: string | null;
  name: string;
  role: string;
  avatar_color: string | null;
  cadence_days: number;
}

export interface LogDraft {
  party_id: string;
  kind: string;
  text: string;
}

export interface ConfirmState {
  kind: "trash" | "merge";
  party_id: string;
  source_party_id?: string;
}

export interface AppState {
  shelf: ShelfId;
  personId: string | null;
  filter: RosterFilter;
  search: string;
  searchStatus: SearchStatus;
  searchSeq: number;
  searchResults: PersonRow[] | null;
  collapsed: Record<string, boolean>;
  composer: ComposerState | null;
  draft: PersonDraft | null;
  log: LogDraft | null;
  confirm: ConfirmState | null;
  mergeSourceId: string | null;
  merged: boolean;
  narrow: boolean;
}

export interface AppData {
  people: PersonRow[];
  truncated: boolean;
  linksAvailable: boolean;
  person: PersonDetail | null;
  dashboard: DashboardData | null;
  trash: TrashedPerson[];
}

export interface RouteBase {
  loading: boolean;
  offline: boolean;
  narrow: boolean;
}

export interface RosterRouteProps extends RouteBase {
  people: readonly PersonRow[];
  linksAvailable: boolean;
  filter: RosterFilter;
  onSelectFilter: (filter: RosterFilter) => void;
  onOpenPerson: (partyId: string) => void;
  onToggleStar: (person: PersonRow) => void;
  onAddPerson: () => void;
}

export interface TouchRouteProps extends RouteBase {
  dashboard: DashboardData | null;
  onSelectTile: (tile: TouchTile) => void;
  onOpenPerson: (partyId: string) => void;
  onLog: (partyId: string) => void;
}

export interface SearchRouteProps extends RouteBase {
  term: string;
  status: SearchStatus;
  results: readonly PersonRow[];
  filter: RosterFilter;
  onTermChange: (term: string) => void;
  onClear: () => void;
  onSelectFilter: (filter: RosterFilter) => void;
  onOpenPerson: (partyId: string) => void;
  onToggleStar: (person: PersonRow) => void;
  inputRef: (el: HTMLInputElement | null) => void;
}

export interface PersonRouteProps extends RouteBase {
  person: PersonDetail | null;
  roster: readonly PersonRow[];
  onStatus: (message: string) => void;
  collapsed: Readonly<Record<string, boolean>>;
  composer: ComposerState | null;
  onToggleSection: (key: string) => void;
  onOpenComposer: (key: ComposerKey) => void;
  onComposerChange: (patch: Partial<ComposerState>) => void;
  onComposerSave: () => void;
  onComposerCancel: () => void;
  onLog: () => void;
  onEdit: () => void;
  onToggleStar: () => void;
  onToggleReminder: (dateId: string, label: string) => void;
  onDeleteChannel: (channel: ContactChannel) => void;
  onTrash: () => void;
  onMerge: () => void;
}

export interface LogRouteProps extends RouteBase {
  person: PersonDetail | PersonRow | null;
  draft: LogDraft | null;
  onChange: (patch: Partial<LogDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
}

export interface EditRouteProps extends RouteBase {
  draft: PersonDraft | null;
  mode: "new" | "edit";
  onChange: (patch: Partial<PersonDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
}

export interface TrashRouteProps extends RouteBase {
  people: readonly TrashedPerson[];
  onRestore: (person: TrashedPerson) => void;
}

export interface MergeRouteProps extends RouteBase {
  keep: PersonDetail | null;
  candidates: readonly PersonRow[];
  source: PersonRow | null;
  merged: boolean;
  onPickSource: (partyId: string) => void;
  onMerge: () => void;
  onCancel: () => void;
}
