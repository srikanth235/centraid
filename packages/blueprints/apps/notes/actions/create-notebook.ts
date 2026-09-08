import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * Sibling order is the vault's to assign (end of the list). The model nests
 * via parent_notebook_id; this app keeps its chips flat.
 */
export default async function createNotebook({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "knowledge.create_notebook",
    input: {
      name: String(input.name ?? ""),
      // The seat mints the row's id and the origin honours it (#922 G2).
      ...(input.notebook_id ? { notebook_id: String(input.notebook_id) } : {}),
      ...(input.parent_notebook_id == null
        ? {}
        : { parent_notebook_id: String(input.parent_notebook_id) }),
    },
  });
}
