import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Filing is one folders-scheme tag per document; a move swaps that tag. */
export default async function moveHandler({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.move_document",
    input: {
      document_id: String(input.document_id ?? ""),
      ...(input.folder_id == null
        ? {}
        : { folder_id: String(input.folder_id) }),
    },
  });
}
