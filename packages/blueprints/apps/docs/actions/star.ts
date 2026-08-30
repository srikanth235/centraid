import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function starHandler({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.star_document",
    input: {
      document_id: String(input.document_id ?? ""),
    },
  });
}
