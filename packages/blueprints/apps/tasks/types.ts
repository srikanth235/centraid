// Shared page-side shapes for the tasks app (TS + CSS-modules conversion).
// Type-only — no runtime members — so every importer uses `import type`, which
// esbuild strips at serve time (a value import of this module would 404).
// Grounded in the query payloads: `Task` is the decorated row the `board`/
// `search` queries return (open + logbook, with nested children, attachments,
// tags and resolved cross-references); the presentation `AppState`/`BoardData`
// bags app.tsx mutates in place (never reassigned) and logic.ts closes over.
import type { Attachment, Reference } from './kit.ts';

/** VTODO lifecycle status (schedule.task). */
export type TaskStatus = 'needs-action' | 'in-process' | 'completed' | 'cancelled';

/** The five focus views the sidebar switches between. */
export type View = 'today' | 'upcoming' | 'anytime' | 'all' | 'logbook';

/** One tag edge decorated with its concept's label (board/search join). */
export interface TaskTag {
  tag_id: string;
  concept_id?: string;
  label: string;
}

/**
 * A decorated schedule.task row as the board/search queries project it. Open
 * top-level tasks carry their nested `children` + `done_children`; every task
 * carries its attachments, tags and resolved cross-references. `snippet` rides
 * only on FTS search hits.
 */
export interface Task {
  task_id: string;
  status: TaskStatus;
  title: string;
  description?: string | null;
  due_at?: string | null;
  completed_at?: string | null;
  priority?: number;
  effort_min?: number | null;
  rrule?: string | null;
  remind_before_min?: number | null;
  parent_task_id?: string | null;
  children?: Task[];
  done_children?: number;
  tags?: TaskTag[];
  attachments?: Attachment[];
  references?: Reference[];
  snippet?: string;
}

/**
 * The field-edit patch the detail drawer's controls hand to `logic.editField`
 * (forwarded to the `edit` action). Only the changed fields ride; clearing is
 * the explicit `clear_*` intent, never an empty string.
 */
export interface EditPatch {
  title?: string;
  description?: string;
  clear_description?: boolean;
  due_at?: string;
  clear_due?: boolean;
  priority?: number;
  effort_min?: number;
  rrule?: string;
  clear_rrule?: boolean;
  remind_before_min?: number;
  clear_remind?: boolean;
}

/** A parked add with no task_id yet — rendered as a ghost row (logic.ts). */
export interface PendingAdd {
  key: string;
  title: string;
  due_at: string | null;
  priority: number;
  parent_task_id: string | null;
}

/** One session-scoped, receipted activity entry (logic.ts logActivity). */
export interface ActivityEntry {
  text: string;
  when: string;
  receiptId: string | null;
}

/** The `data.counts` the board query returns (fetched-window counts). */
export interface BoardCounts {
  open?: number;
  closed?: number;
}

/** The derived sidebar/focus-view counts (logic.ts sidebarCounts). */
export interface SidebarCountsShape {
  today: number;
  upcoming: number;
  anytime: number;
  all: number;
  logbook: number;
}

/** Today's completion progress (logic.ts todayProgress). */
export interface TodayProgress {
  pct: number;
  label: string;
}

/** One board section (a bucket, or the logbook) — buildSections output. */
export interface BoardSection {
  key: string;
  label: string;
  tone: string;
  count: number;
  rows: Task[];
}

/**
 * The last successful board read (never reassigned — mutated in place so
 * logic.ts's closure stays valid).
 */
export interface BoardData {
  open: Task[];
  logbook: Task[];
  counts: BoardCounts;
  window: number;
}

/**
 * The module-level `state` bag app.tsx mutates in place. All client-side
 * presentation state — never persisted, never sent to the vault.
 */
export interface AppState {
  view: View;
  search: string;
  searchResults: Task[] | null;
  searchSnippets: Map<string, string> | null;
  boardWindow: number;
  boardTruncated: boolean;
  detailId: string | null;
  narrow: boolean;
  pendingIds: Set<string>;
  pendingAdds: PendingAdd[];
  activityLog: Map<string, ActivityEntry[]>;
  readFailedShown: boolean;
}

/** The dependency bag `createLogic` closes over (app.tsx wires it). */
export interface LogicDeps {
  state: AppState;
  data: BoardData;
  render: () => void;
  refresh: () => Promise<void>;
}
