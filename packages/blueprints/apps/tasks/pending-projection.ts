// Tasks' declared pending-write projection (issue #738): how each
// write-bearing action's input maps onto the schedule.task row the
// board/search queries read. Grounded in the real command postconditions
// (packages/vault/src/commands/tasks.ts) so the optimistic row matches what
// settlement will actually produce — `add` starts `needs-action` with no
// `completed_at` (ADD_TASK's postcondition), `set-status` stamps
// `completed_at` iff the new status is `completed` (SET_TASK_STATUS's
// postcondition), `edit`'s clear_* flags null the same column a value would
// set.
//
// `save-project`/`save-section`/`organize-task` and the attachment/tag
// actions (`attach`/`detach`/`add-tag`/`remove-tag`) are deliberately left
// undeclared: none of them change what a Board/Detail row itself shows (a
// board reorder settles fast and the sidebar has no pending affordance of its
// own), so they stay online-only rather than growing this projection past
// what the UI renders pending state for.
import type { PendingProjectionDeclaration } from "../_shared/pending-overlay.ts";

export const tasksPendingProjection: PendingProjectionDeclaration = {
  appId: "tasks",
  actions: {
    add: (input, ctx) => {
      const values: Record<string, unknown> = {
        task_id: ctx.rowId,
        title: String(input.title ?? ""),
        status: "needs-action",
        priority: typeof input.priority === "number" ? input.priority : 0,
      };
      if (typeof input.description === "string")
        values.description = input.description;
      if (typeof input.due_at === "string") values.due_at = input.due_at;
      if (typeof input.effort_min === "number")
        values.effort_min = input.effort_min;
      if (typeof input.parent_task_id === "string")
        values.parent_task_id = input.parent_task_id;
      if (typeof input.rrule === "string") values.rrule = input.rrule;
      if (typeof input.remind_before_min === "number")
        values.remind_before_min = input.remind_before_min;
      return [
        { op: "upsert", entity: "schedule.task", rowId: ctx.rowId, values },
      ];
    },

    "set-status": (input) => [
      {
        op: "upsert",
        entity: "schedule.task",
        rowId: String(input.task_id ?? ""),
        values: {
          status: String(input.status ?? ""),
          completed_at:
            input.status === "completed" ? new Date().toISOString() : null,
        },
      },
    ],

    edit: (input) => {
      const values: Record<string, unknown> = {};
      if (typeof input.title === "string") values.title = input.title;
      if (typeof input.description === "string")
        values.description = input.description;
      if (input.clear_description === true) values.description = null;
      if (typeof input.due_at === "string") values.due_at = input.due_at;
      if (input.clear_due === true) values.due_at = null;
      if (typeof input.priority === "number") values.priority = input.priority;
      if (typeof input.effort_min === "number")
        values.effort_min = input.effort_min;
      if (typeof input.remind_before_min === "number")
        values.remind_before_min = input.remind_before_min;
      if (input.clear_remind === true) values.remind_before_min = null;
      if (typeof input.rrule === "string") values.rrule = input.rrule;
      if (input.clear_rrule === true) values.rrule = null;
      return [
        {
          op: "upsert",
          entity: "schedule.task",
          rowId: String(input.task_id ?? ""),
          values,
        },
      ];
    },
  },
};
