import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function removeField({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "locker.remove_field",
    input: {
      item_id: String(input.item_id ?? ""),
      field_id: String(input.field_id ?? ""),
    },
  });
}
