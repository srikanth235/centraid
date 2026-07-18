// Shared page-side shapes for the people app (TS conversion). Type-only — no
// runtime members — so every importer uses `import type`, which esbuild strips
// at serve time (a value import of this module would 404). Grounded in the
// query payloads: `Person` is the secret-free decorated list row the `people`/
// `search` queries return; `DetailPerson` is the full profile the single
// `person` query returns; `JournalItem`/`RecentItem` are the journal/activity
// rows. `AppState`/`AppData` are the module-level bags app.tsx mutates in place
// (never reassigns) and logic.ts closes over.

/** The current directory/journal navigation selection. */
export type Nav =
  | { kind: 'all' }
  | { kind: 'reconnect' }
  | { kind: 'upcoming' }
  | { kind: 'starred' }
  | { kind: 'journal' }
  | { kind: 'activity' }
  | { kind: 'list'; listId: string };

/** An active reminder date carried on a list row (drives Upcoming). */
export interface Reminder {
  date_id?: string;
  label?: string;
  month_day: string;
}

/** Secret-free decorated list row (people/search queries). */
export interface Person {
  party_id: string;
  name: string;
  role?: string;
  avatar_color?: string | null;
  cadence_days?: number;
  last_contacted_at?: string | null;
  created_at?: string;
  list_id?: string | null;
  starred?: boolean;
  reminders?: Reminder[];
  /** FTS snippet — present only on `search` query rows. */
  snippet?: string;
}

/** An owner-curated list (a SKOS lists-scheme concept). */
export interface PersonList {
  list_id: string;
  name: string;
}

// ---------- Full profile (the single `person` query) ----------

export interface Contact {
  kind: string;
  value: string;
}
export interface Relationship {
  relationship_id?: string;
  name?: string;
  kind?: string;
  pet?: string | null;
}
export interface ImportantDate {
  date_id: string;
  label: string;
  month_day: string;
  reminder_on?: boolean;
}
export interface PersonNote {
  annotation_id?: string;
  text: string;
  created_at?: string;
}
export interface PersonTask {
  task_id: string;
  text: string;
  done?: boolean;
}
export interface Gift {
  gift_id: string;
  text: string;
  state: string;
}
export interface Debt {
  debt_id: string;
  direction: string;
  amount_minor: number;
  currency?: string;
  reason?: string;
}
export interface Interaction {
  interaction_id?: string;
  kind: string;
  text?: string;
  occurred_at?: string;
}

export interface DetailPerson {
  party_id: string;
  name: string;
  role?: string;
  avatar_color?: string | null;
  cadence_days?: number;
  last_contacted_at?: string | null;
  created_at?: string;
  met?: string;
  list_id?: string | null;
  starred?: boolean;
  contact?: Contact[];
  relationships?: Relationship[];
  dates?: ImportantDate[];
  notes?: PersonNote[];
  tasks?: PersonTask[];
  gifts?: Gift[];
  debts?: Debt[];
  interactions?: Interaction[];
}

// ---------- Journal + activity ----------

export interface JournalOwnerItem {
  kind: 'entry';
  id?: string;
  sort_at?: string;
  date?: string;
  mood?: string;
  text?: string;
}
export interface JournalAutoItem {
  kind: 'auto';
  id?: string;
  sort_at?: string;
  date?: string;
  touch?: string;
  text?: string;
  party_id?: string;
  name?: string;
  avatar_color?: string | null;
}
export type JournalItem = JournalOwnerItem | JournalAutoItem;
export interface JournalData {
  entries: JournalItem[];
}

/** One logged touch in the Activity view (dashboard `recent`). */
export interface RecentItem {
  party_id?: string;
  name?: string;
  avatar_color?: string | null;
  interaction_id?: string;
  kind?: string;
  text?: string;
  occurred_at?: string;
}
export interface DashboardData {
  recent: RecentItem[];
}

// ---------- Module-level state + data bags ----------

export type ChipKey = 'all' | 'overdue' | 'due' | 'ok';
export type SortKey = 'last' | 'name' | 'cadence';

export interface AppData {
  people: Person[];
  lists: PersonList[];
}

export interface AppState {
  view: 'grid' | 'list';
  nav: Nav;
  chip: ChipKey;
  sortKey: SortKey;
  sortDir: 1 | -1;
  search: string;
  searchResults: Person[] | null;
  searchSeq: number;
  selected: Set<string>;
  detailsId: string | null;
  detailPerson: DetailPerson | null;
  detailAdders: Record<string, boolean>;
  newMenuOpen: boolean;
  addModalOpen: boolean;
  creatingList: boolean;
  renamingListId: string | null;
  narrow: boolean;
  peopleWindow: number;
  peopleTruncated: boolean;
  journalData: JournalData | null;
  dashboardData: DashboardData | null;
  visibleRows: Person[];
}

// ---------- Logic / chrome factory dependency bags ----------

export interface LogicDeps {
  state: AppState;
  data: AppData;
  render: () => void;
  refresh: () => Promise<void>;
  renderRows: () => void;
  renderDetails: () => void;
  renderModal: () => void;
  renderNewMenu: () => void;
}

export interface ChromeDeps {
  state: AppState;
  render: () => void;
  refresh: () => Promise<void>;
  renderRows: () => void;
  renderNewMenu: () => void;
  closeDetails: () => void;
  closeAddModal: () => void;
  applySearch: () => void;
}
