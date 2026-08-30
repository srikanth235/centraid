import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function renameHandler({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.rename_document",
    input: {
      document_id: String(input.document_id ?? ""),
      title: String(input.title ?? ""),
    },
  });
}
