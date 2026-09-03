import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function createNotebook({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "knowledge.create_notebook",
    input: {
      name: String(input.name ?? ""),
      ...(input.parent_notebook_id == null
        ? {}
        : { parent_notebook_id: String(input.parent_notebook_id) }),
    },
  });
}
