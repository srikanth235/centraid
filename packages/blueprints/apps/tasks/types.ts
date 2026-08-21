// Shared page-side shapes for the Tasks room (#834 rebuild). Type-only — no
// runtime members — so every importer uses `import type`.
//
// Grounded in the query payloads: `Task` is the decorated row `queries/board.ts`
// and `queries/search.ts` return. THE THREE RECURRENCE FIELDS AT THE BOTTOM OF
// `Task` ARE DERIVED SERVER-SIDE and are the only recurrence facts the UI is
// allowed to render — the summariser lives behind `ctx.time`, so a surface that
// re-derived "missed 4" would be a second engine (the defect the handoff's step
// 1 exists to prevent).
import type { Attachment } from "@centraid/design/elements";

import type { ScopeSearchReach } from "../_shared/search-scaffold.ts";

/**
 * One resolved cross-reference on a task row (`core.link_entities`), as the
 * `board`/`search` queries decorate it. Declared here rather than shared:
 * referencing is a shell capability, and this app only ever READS the rows the
 * query resolved for it.
 */
export interface Reference {
  linkId?: string;
  type?: string;
  id?: string;
  relation?: string;
  [key: string]: unknown;
}

/** VTODO lifecycle status (schedule.task). */
export type TaskStatus =
  | "needs-action"
  | "in-process"
  | "completed"
  | "cancelled";

export interface Project {
  project_id: string;
  name: string;
  area?: string | null;
  color?: string | null;
  sort_order: number;
}

export interface Section {
  section_id: string;
  project_id: string;
  name: string;
  sort_order: number;
}

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
  /** Which mounted scope this row is shown FROM (issue #726 D11), stamped by
   *  the cross-scope merge (apps/_shared/scope-merge.ts) — absent on a
   *  single-scope surface or a row app-root.tsx never ran through the merge
   *  (the logbook, still own-scope-only). */
  scope_id?: string | null;
  status: TaskStatus;
  title: string;
  description?: string | null;
  due_at?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  priority?: number;
  effort_min?: number | null;
  rrule?: string | null;
  remind_before_min?: number | null;
  project_id?: string | null;
  section_id?: string | null;
  sort_order?: number;
  recurrence_anchor?: "scheduled" | "completion";
  recurrence_tz?: string | null;
  parent_task_id?: string | null;
  children?: Task[];
  done_children?: number;
  tags?: TaskTag[];
  attachments?: Attachment[];
  references?: Reference[];
  snippet?: string;
  /** The ONE summariser's words for `rrule` (`ctx.time.describeRecurrence`).
   *  A raw RRULE never reaches a surface, so this is what a row renders. */
  recurrence_summary?: string | null;
  /** Elapsed unactioned periods collapsed onto this single live occurrence
   *  (`ctx.time.collapseMissedOccurrences`) — never a stack of copies. */
  missed?: number;
  /** The live occurrence's instant, from the same collapse. */
  next_due?: string | null;
}

/** The `data.counts` the board query returns (fetched-window counts). */
export interface BoardCounts {
  open?: number;
  closed?: number;
}

/** The last successful board read (never reassigned — mutated in place so the
 *  orchestrator's closures stay valid). */
export interface BoardData {
  open: Task[];
  logbook: Task[];
  counts: BoardCounts;
  projects: Project[];
  sections: Section[];
  tags: Array<{ concept_id: string; label: string }>;
  window: number;
}

/** One group of rows on a board screen — the header's own facts travel with
 *  the rows so the header and the list cannot disagree about the count. */
export interface TaskGroup {
  key: string;
  label: string;
  /** The header's own tabular meta, already composed (view-copy.ts). */
  meta?: string;
  /** Overdue is the ONE group drawn in the attention tone (`seam`), and it is
   *  the only group carrying bulk verbs. */
  attention?: boolean;
  rows: Task[];
}

/** What a re-entry bucket is: a pile, its one bulk verb, and why it is a pile. */
export interface ReentryBucket {
  key: "dated" | "repeating" | "sitting";
  label: string;
  verb: string;
  rows: Task[];
}

/** The pending-write chip's own row shape (apps/_shared/pending-overlay). */
export type PendingRow = Readonly<Record<string, unknown>>;

/** Which overlay is open over the room. One at a time, always. */
export type Overlay =
  | { kind: "quick-add" }
  | { kind: "more" }
  | { kind: "shortcuts" }
  | { kind: "release"; taskId: string }
  | { kind: "delete"; taskId: string };

/** The mutable presentation bag the orchestrator holds in a ref. Client-side
 *  only — never persisted, never sent to the vault. */
export interface AppState {
  search: string;
  searchResults: Task[] | null;
  searchStatus: "resting" | "searching" | "ready" | "unreachable";
  searchSeq: number;
  searchScope: "everywhere" | "project";
  boardWindow: number;
  boardTruncated: boolean;
  boardReach: ScopeSearchReach[];
  /** The task the editor is describing, on the `tasks/task` route. */
  openTaskId: string | null;
  /** The family twists the member has collapsed. */
  collapsed: Set<string>;
  /** Which row the keyboard is on (§7's `j/k`). */
  cursorId: string | null;
  overlay: Overlay | null;
  /** Where a new task lands — a scope id, personal by default. */
  landsIn: string | null;
  narrow: boolean;
}
