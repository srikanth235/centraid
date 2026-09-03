import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function renameNotebook({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "knowledge.rename_notebook",
    input: {
      notebook_id: String(input.notebook_id ?? ""),
      name: String(input.name ?? ""),
    },
  });
}
