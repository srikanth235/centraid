import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

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
