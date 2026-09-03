import {
  ACTION_PURPOSE,
  actionInput,
  deniedResult,
  runVaultAction,
} from "../../_shared/action-kit.ts";

export default async function sendToTasks({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const title = String(input.title ?? "").trim();
  const noteId = String(input.note_id ?? "");
  if (!title) return deniedResult("A task needs a title.");
  return runVaultAction(
    ctx,
    {
      command: "schedule.add_task",
      input: {
        title,
        ...(input.due_at ? { due_at: String(input.due_at) } : {}),
      },
    },
    async (outcome) => {
      const taskId = (outcome.output as { task_id?: string } | undefined)
        ?.task_id;
      if (outcome.status !== "executed" || !taskId || !noteId) return;
      const exact = String(input.exact ?? "");
      await ctx.vault
        .invoke({
          command: "core.link_entities",
          input: {
            from_type: "schedule.task",
            from_id: taskId,
            to_type: "knowledge.note",
            to_id: noteId,
            relation: "references",
            ...(exact ? { selector: { exact, prefix: "", suffix: "" } } : {}),
          },
          purpose: ACTION_PURPOSE,
        })
        .catch(() => undefined);
    }
  );
}
