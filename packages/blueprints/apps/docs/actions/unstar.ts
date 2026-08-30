import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function unstar({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.unstar_document",
    input: {
      document_id: String(input.document_id ?? ""),
    },
  });
}
