import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function deleteNotebook({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "knowledge.delete_notebook",
    input: {
      notebook_id: String(input.notebook_id ?? ""),
    },
  });
}
