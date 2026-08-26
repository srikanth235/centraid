// The three lines that make Tasks projectable across scopes: everything a
// share needs to know about this app's rows, declared once against the
// shared kit (apps/_shared/scope-kit.ts) — no sharing code of Tasks' own.
//
// Record-only, the cheaper of Tasks/Docs to wire (#726 D11 task 3): a
// task carries no bytes of its own — attachments are `core.content_item`
// rows this app only ever references, never mints — so a projected task has
// nothing to re-ingest, unlike Photos' EXIF re-link + enrichment enqueue.
import type { ScopeAppDeclaration } from "../_shared/scope-kit.ts";
import type { Task } from "./types.ts";

export const tasksScopeDeclaration: ScopeAppDeclaration<Task> = {
  mergeKey: (task) => task.task_id,
  mintedIdFamilies: ["schedule.task"],
  projectionIngest: "none",
};

/** The cross-scope identity two Task rows are deduped on. A record has no
 *  separate "same bytes, different row" question the way a photo does —
 *  its own id (UUIDv7, so also chronological) is the only identity there
 *  is, which is why it is `mergeKey` restated rather than a second rule. */
export function taskDedupeIdentity(task: Task): string {
  return task.task_id;
}
