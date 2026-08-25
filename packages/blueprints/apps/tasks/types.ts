// Page-side shapes for Tasks (#834). `Task`'s recurrence fields are derived
// behind `ctx.time` and are the only recurrence facts a surface may render.
import type { Attachment } from "@centraid/design/elements";

import type { ScopeSearchReach } from "../_shared/search-scaffold.ts";

export interface Reference {
  linkId?: string;
  type?: string;
  id?: string;
  relation?: string;
  [key: string]: unknown;
}

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

export interface TaskTag {
  tag_id: string;
  concept_id?: string;
  label: string;
}

export interface Task {
  task_id: string;
  /** From the cross-scope merge; absent on single-scope surfaces (#726). */
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
  recurrence_summary?: string | null;
  missed?: number;
  next_due?: string | null;
}

export interface BoardCounts {
  open?: number;
  closed?: number;
}

/** Never reassigned — mutated in place so the orchestrator's closures hold. */
export interface BoardData {
  open: Task[];
  logbook: Task[];
  counts: BoardCounts;
  projects: Project[];
  sections: Section[];
  tags: Array<{ concept_id: string; label: string }>;
  window: number;
}

export interface TaskGroup {
  key: string;
  label: string;
  meta?: string;
  attention?: boolean;
  rows: Task[];
}

export interface ReentryBucket {
  key: "dated" | "repeating" | "sitting";
  label: string;
  verb: string;
  rows: Task[];
}

export type PendingRow = Readonly<Record<string, unknown>>;

export type Overlay =
  | { kind: "quick-add" }
  | { kind: "more" }
  | { kind: "shortcuts" }
  | { kind: "release"; taskId: string }
  | { kind: "delete"; taskId: string };

/** Client-side only — never persisted, never sent to the vault. */
export interface AppState {
  search: string;
  searchResults: Task[] | null;
  searchStatus: "resting" | "searching" | "ready" | "unreachable";
  searchSeq: number;
  searchScope: "everywhere" | "project";
  boardWindow: number;
  boardTruncated: boolean;
  boardReach: ScopeSearchReach[];
  openTaskId: string | null;
  collapsed: Set<string>;
  cursorId: string | null;
  overlay: Overlay | null;
  landsIn: string | null;
  narrow: boolean;
}
