import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * Pure structure: members are unfiled, never destroyed (notes_unfiled). The
 * vault refuses while child notebooks exist, so nothing dangles.
 */
export default async function deleteNotebook({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "knowledge.delete_notebook",
    input: {
      notebook_id: String(input.notebook_id ?? ""),
    },
  });
}
