// People's view models and the FROZEN prop contract for its eight screens.
//
// Type-only — no runtime members — so every importer uses `import type`.
//
// The row shapes are grounded in the five queries this app renders
// (`queries/people|person|dashboard|search|trash.ts`) rather than in the
// handoff's prototype seed: the prototype's person carried `vaults`, and no
// query returns one. Where the handoff names a field the vault does not have,
// the field is absent here — a view model that invents a column is how a
// screen ends up drawing a fact nobody stored.
//
// The eight `*RouteProps` interfaces below are the contract the screens are
// built against. Each screen receives DATA and CALLBACKS and owns no state and
// no reads of its own: the store lives in `logic.ts`, the writes in
// `writes.ts`, and a route that fetched for itself would be a second source of
// truth for the same rows.
import type { SearchStatus } from "../_shared/search-scaffold.ts";
import type { ShelfId } from "./shelves.ts";

export type { SearchStatus } from "../_shared/search-scaffold.ts";

/** One dated reminder as the roster window carries it. */
export interface ReminderRef {
  date_id: string;
  label: string;
  month_day: string;
}

/** A roster row — the `people` window's shape, and the `search` shelf's too
 *  (search adds only `snippet`). */
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
  /**
   * Is this person linked to a vault of their own? A TRI-STATE, and the third
   * value carries as much as the first two: `null` means the sharing plane
   * could not be read (People's `share.*` scopes parked for approval), and
   * ABSENT means the query never asked — `queries/search.ts` returns rows
   * without link facts. Both draw as unknown (`format.ts` linkState).
   */
  linked?: boolean | null;
  /** How many live bindings this person holds; 0 when unlinked or unknown. */
  vault_count?: number;
  /** The vault's FTS hit passage — present only on a search result. */
  snippet?: string;
}

/** One live party↔vault binding. It carries no vault NAME — the binding stores
 *  a `vault_id`, and an id is not a name, so nothing prints one. */
export interface VaultBinding {
  binding_id: string;
  vault_id: string;
  linked_at: string;
}

/** What a grant lets its member do. The words are the vault's own. */
export type ShareCapability = "read" | "read+write";

/** An invitation sent to this person that they have not answered yet. */
export interface PendingInvite {
  invitation_id: string;
  container_label: string | null;
  capability: ShareCapability;
  created_at: string;
}

/** One contact channel on the person screen. `legacy` marks a row projected
 *  from a party identifier rather than a channel, which has no id to edit. */
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
  legacy?: boolean;
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

/**
 * One person in full — the `person` query, minus the sections the handoff
 * excludes (lists, journal, tasks, gifts, debts, typed relationships, edit
 * history). The query still returns them; nothing renders them.
 */
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
  /**
   * The sharing plane, both halves of it. NULL IS NOT AN EMPTY LIST: it means
   * the reads were denied, and the person screen then draws no vault section
   * at all rather than an empty one claiming nothing is shared
   * (`queries/_shared.ts` returns the two together for exactly this reason).
   * WHAT IS SHARED WITH THIS PERSON IS NOT HERE (#825): standing grants are
   * read from the grant plane by `grant-dashboard.ts`, not projected through
   * this query.
   */
  vaults: VaultBinding[] | null;
  pending_invites: PendingInvite[] | null;
}

/** The card every dashboard list is built out of. The cadence pair is not the
 *  query's — `queries/dashboard.ts` keeps it to itself — so `logic.ts` joins
 *  it back in from the roster read, which always lands first. Optional,
 *  because a person can arrive on a card before the roster names them. */
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

/** The `dashboard` query's counts, verbatim — `starred`, not "favorites". */
export interface TouchCounts {
  all: number;
  reconnect: number;
  upcoming: number;
  starred: number;
  /** How many of these people hold a vault, and how many do not. Null when
   *  the sharing plane could not be read — the tiles then fall back to the
   *  four the roster alone can answer. */
  linked: number | null;
  to_link: number | null;
}

export interface DashboardData {
  reconnect: PersonCard[];
  upcoming: UpcomingCard[];
  recent: RecentCard[];
  counts: TouchCounts;
}

/** One row of the trash shelf. */
export interface TrashedPerson {
  party_id: string;
  name: string;
  role: string;
  purge_at: string | null;
}

/** The roster's filter chips. `linked`/`unlinked` are DRAWN only while the
 *  sharing plane can be read (`people-copy.ts` filterChips). */
export type RosterFilter = "all" | "linked" | "unlinked" | "starred" | "due";

/** The Touch screen's count tiles across both sets. Each navigates or filters. */
export type TouchTile =
  | "all"
  | "reconnect"
  | "upcoming"
  | "starred"
  | "linked"
  | "to_link";

/** Which section of the person screen an inline composer is open in. Adding
 *  is a field where the row will be, never a new screen (handoff deviation 3). */
export type ComposerKey = "channels" | "dates" | "notes";

/** The open inline composer's own state. `label` carries the channel label or
 *  the date's own label; `value` carries the one typed value. */
export interface ComposerState {
  key: ComposerKey;
  value: string;
  label: string;
  /** The channel kind being added, while `key` is `channels`. */
  kind: ContactChannel["kind"];
  /** The `MM-DD` being added, while `key` is `dates`. */
  monthDay: string;
}

/** The edit/new form. `avatar_color` is a stored hex or null (derive). */
export interface PersonDraft {
  party_id: string | null;
  name: string;
  role: string;
  avatar_color: string | null;
  cadence_days: number;
}

/** The log composer. */
export interface LogDraft {
  party_id: string;
  kind: string;
  text: string;
}

/** An open modal confirm. Revoke is absent — there is no link to revoke. */
export interface ConfirmState {
  kind: "trash" | "merge";
  party_id: string;
  /** The duplicate being merged in, while `kind` is `merge`. */
  source_party_id?: string;
}

/** The mutable state bag `app-root.tsx` owns and `logic.ts` closes over. It is
 *  MUTATED IN PLACE, never reassigned, exactly as Docs' `AppState` is. */
export interface AppState {
  shelf: ShelfId;
  /** Who every nested screen is about (`shelves.ts`). */
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
  /** The duplicate picked on the merge screen, before it is confirmed. */
  mergeSourceId: string | null;
  merged: boolean;
  narrow: boolean;
}

/** The read-through data bag, mutated in place beside `AppState`. */
export interface AppData {
  people: PersonRow[];
  truncated: boolean;
  /** The roster envelope's `links_available`: whether the sharing plane
   *  answered at all. False draws the link-free app, ring and chips included. */
  linksAvailable: boolean;
  person: PersonDetail | null;
  dashboard: DashboardData | null;
  trash: TrashedPerson[];
}

// ---------------------------------------------------------------------------
// The frozen route contract. Wave 2 builds against exactly these props.
// ---------------------------------------------------------------------------

/** What every route is told about the read that produced it. */
export interface RouteBase {
  /** A read has not landed yet — draw the skeleton, never "nothing here". */
  loading: boolean;
  /** The gateway is out of reach (`_shared/view-state-kit.ts`). */
  offline: boolean;
  /** The compact form factor, measured on the app pane's own width. */
  narrow: boolean;
}

export interface RosterRouteProps extends RouteBase {
  people: readonly PersonRow[];
  /** Whether the link ring and the two link chips may be drawn at all. */
  linksAvailable: boolean;
  filter: RosterFilter;
  onSelectFilter: (filter: RosterFilter) => void;
  onOpenPerson: (partyId: string) => void;
  onToggleStar: (person: PersonRow) => void;
  /** The first-run empty state's one commit, and nothing else's. */
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
  /** The roster window, which the grant dashboard hands the share sheet as
   *  its audience list: People is where a party id has a name (#825). */
  roster: readonly PersonRow[];
  /** The frame's one status line, for what a share or a revoke answered. The
   *  grant plane is not a People write, so it does not travel through
   *  `writes.ts` — but its outcome lands on the same one line. */
  onStatus: (message: string) => void;
  /** Which section keys are collapsed. Absent means open. */
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
  /** A draft with no `party_id` is a new person; the screen names itself. */
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
  /** The surviving person — the one the screen was opened from. */
  keep: PersonDetail | null;
  /** Every other person, as candidates for `Merge in`. */
  candidates: readonly PersonRow[];
  /** The duplicate picked so far, or null while none is. */
  source: PersonRow | null;
  merged: boolean;
  onPickSource: (partyId: string) => void;
  onMerge: () => void;
  onCancel: () => void;
}
