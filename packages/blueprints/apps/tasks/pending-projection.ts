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
    add: ({ input, intentId }) => {
      const taskId = stablePendingRowId(intentId, "task");
      return [
        pendingUpsert("schedule.task", taskId, {
          task_id: taskId,
          status: "needs-action",
          completed_at: null,
          ...pendingInputValues(input, TASK_FIELDS),
        }),
      ];
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
      return [
        pendingUpsert("schedule.project", projectId, {
          project_id: projectId,
          archived_at: null,
          sort_order: 0,
          ...pendingInputValues(input, ["name", "area", "color", "sort_order"]),
        }),
      ];
    },
    "save-section": ({ input, intentId }) => {
      const sectionId =
        typeof input.section_id === "string"
          ? input.section_id
          : stablePendingRowId(intentId, "section");
      return [
        pendingUpsert("schedule.section", sectionId, {
          section_id: sectionId,
          ...pendingInputValues(input, ["project_id", "name", "sort_order"]),
        }),
      ];
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
