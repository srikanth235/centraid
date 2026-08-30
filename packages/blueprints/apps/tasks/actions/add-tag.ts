import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** One Tags concept scheme is shared with every app tagging through
 *  core.tag_item. Idempotent: a label already on the task returns its edge. */
export default async function addTag({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.tag_item",
    input: {
      subject_type: "schedule.task",
      subject_id: String(input.task_id ?? ""),
      label: String(input.label ?? ""),
    },
  });
}
