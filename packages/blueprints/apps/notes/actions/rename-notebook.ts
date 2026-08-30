import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * The vault refuses a name another of the owner's notebooks holds — two
 * same-named notebooks are indistinguishable in a filing UI. Self-rename is
 * a no-op.
 */
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
