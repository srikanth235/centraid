import {
  definePendingProjection,
  pendingInputValues,
  pendingPatch,
  pendingUpsert,
  stablePendingRowId,
} from "../_shared/pending-overlay.js";

const TASK_FIELDS = [
  "title",
  "description",
  "due_at",
  "effort_min",
  "priority",
  "remind_before_min",
  "rrule",
  "parent_task_id",
  "project_id",
  "section_id",
  "sort_order",
  "recurrence_anchor",
  "recurrence_tz",
] as const;

export const tasksPendingProjection = definePendingProjection({
  appId: "tasks",
  revisions: {
    edit: ["add"],
    "save-project": ["save-project"],
    "save-section": ["save-section"],
  },
  actions: {
    // #922 G2: the id the seat mints IS the row's id. It rides the write, the
    // origin honours it, and a child filed against it offline lands pointing
    // at the row the member is already looking at.
    add: ({ input, intentId }) => {
      // An id the write already carries is REUSED, never re-minted: a revision
      // of a queued add must keep the row it already showed (#922 G2).
      const taskId =
        typeof input.task_id === "string" && input.task_id.length > 0
          ? input.task_id
          : stablePendingRowId(intentId, "task");
      return {
        input: { task_id: taskId },
        optimistic: [
          pendingUpsert("schedule.task", taskId, {
            task_id: taskId,
            status: "needs-action",
            completed_at: null,
            ...pendingInputValues(input, TASK_FIELDS),
          }),
        ],
      };
    },
    "set-status": ({ input }) =>
      pendingPatch("schedule.task", input.task_id, input, ["status"]),
    delete: ({ input }) => {
      if (typeof input.task_id !== "string" || input.task_id.length === 0)
        return [];
      return [{ op: "delete", entity: "schedule.task", rowId: input.task_id }];
    },
    edit: ({ input }) =>
      pendingPatch("schedule.task", input.task_id, input, TASK_FIELDS),
    "save-project": ({ input, intentId }) => {
      const projectId =
        typeof input.project_id === "string"
          ? input.project_id
          : stablePendingRowId(intentId, "project");
      return {
        input: { project_id: projectId },
        optimistic: [
          pendingUpsert("schedule.project", projectId, {
            project_id: projectId,
            archived_at: null,
            sort_order: 0,
            ...pendingInputValues(input, [
              "name",
              "area",
              "color",
              "sort_order",
            ]),
          }),
        ],
      };
    },
    "save-section": ({ input, intentId }) => {
      const sectionId =
        typeof input.section_id === "string"
          ? input.section_id
          : stablePendingRowId(intentId, "section");
      return {
        input: { section_id: sectionId },
        optimistic: [
          pendingUpsert("schedule.section", sectionId, {
            section_id: sectionId,
            ...pendingInputValues(input, ["project_id", "name", "sort_order"]),
          }),
        ],
      };
    },
    "organize-task": ({ input }) =>
      pendingPatch("schedule.task", input.task_id, input, TASK_FIELDS),
    attach: ({ input }) =>
      pendingPatch("schedule.task", input.subject_id, input),
    detach: {
      excluded: true,
      reason: "The detach payload does not identify its task row.",
    },
    "add-tag": ({ input }) =>
      pendingPatch("schedule.task", input.task_id, input),
    "remove-tag": {
      excluded: true,
      reason:
        "The tag id alone cannot identify its task without an extra read.",
    },
  },
});
